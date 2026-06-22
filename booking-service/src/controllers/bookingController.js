const Booking = require("../models/Booking");
const { internalHeaders, notificationClient, parkingClient } = require("../config/http");
const { getBedrockPaymentRisk } = require("../services/bedrockAiService");
const { publishNotification } = require("../services/sqsPublisher");

const buildBookingId = () => `BKG-${Date.now()}${Math.floor(Math.random() * 1000)}`;
const DEFAULT_BOOKING_AMOUNT = 50;
const ALLOWED_VEHICLE_TYPES = ["two-wheeler", "four-wheeler"];

const getAffordableAmount = (amount) => {
  const numericAmount = Number(amount);
  return Number.isFinite(numericAmount) && numericAmount > 0 ? numericAmount : DEFAULT_BOOKING_AMOUNT;
};

const normalizeBookingAmount = (booking) => ({ ...booking, amount: getAffordableAmount(booking.amount) });

const getBookingDurationHours = (durationHours) => {
  const numericDuration = Number(durationHours);
  if (!Number.isFinite(numericDuration)) {
    return 1;
  }
  return Math.min(24, Math.max(1, Math.ceil(numericDuration)));
};

const sendNotification = async ({ recipientUserId, bookingId, type, message, metadata = {} }) => {
  const payload = { recipientUserId, bookingId, type, message, channel: "console", metadata };
  try {
    if (await publishNotification(payload)) {
      return;
    }
    await notificationClient.post(
      "/internal/notify",
      payload,
      { headers: internalHeaders() }
    );
  } catch (error) {
    console.error("SQS notification publish failed; using HTTP fallback", error.message);
    try {
      await notificationClient.post("/internal/notify", payload, { headers: internalHeaders() });
    } catch (fallbackError) {
      console.error("Notification fallback failed", fallbackError.response?.data || fallbackError.message);
    }
  }
};

const reserveSlot = async (slotId, bookingId) => {
  const response = await parkingClient.post(
    `/internal/slots/${slotId}/reserve`,
    { bookingId },
    { headers: internalHeaders() }
  );
  return response.data.slot;
};

const releaseSlot = async (slotId) => {
  await parkingClient.post(`/internal/slots/${slotId}/release`, {}, { headers: internalHeaders() });
};

const occupySlot = async (slotId, bookingId) => {
  await parkingClient.post(
    `/internal/slots/${slotId}/occupy`,
    { bookingId },
    { headers: internalHeaders() }
  );
};

const createBooking = async (req, res) => {
  const bookingId = buildBookingId();

  try {
    const { slotId, vehicleType, durationHours } = req.body;
    if (!slotId) {
      return res.status(400).json({ message: "slotId is required" });
    }
    if (!ALLOWED_VEHICLE_TYPES.includes(vehicleType)) {
      return res.status(400).json({ message: "vehicleType must be two-wheeler or four-wheeler" });
    }

    const slotResponse = await parkingClient.get(`/internal/slots/${slotId}`, {
      headers: internalHeaders(),
    });
    const slot = slotResponse.data;

    if (slot.status !== "available") {
      return res.status(409).json({ message: "Selected slot is not available" });
    }

    const bookingDurationHours = getBookingDurationHours(durationHours);
    const bookingAmount = getAffordableAmount(slot.price) * bookingDurationHours;
    const booking = await Booking.createBooking({
      bookingId,
      userId: req.user.id,
      userEmail: req.user.email,
      slotId,
      vehicleType,
      durationHours: bookingDurationHours,
      amount: bookingAmount,
      status: "pending",
      timestamp: new Date().toISOString(),
      expiresAt: new Date(Date.now() + Number(process.env.BOOKING_HOLD_MINUTES || 10) * 60 * 1000).toISOString(),
    });

    try {
      await reserveSlot(slotId, booking.bookingId);
    } catch (error) {
      await Booking.deleteBooking(booking.bookingId);
      return res.status(error.response?.status || 500).json({
        message: error.response?.data?.message || "Failed to reserve slot",
      });
    }

    await sendNotification({
      recipientUserId: req.user.id,
      bookingId: booking.bookingId,
      type: "booking_pending",
      message: `Booking ${booking.bookingId} created for slot ${slotId}. Complete payment before expiration.`,
      metadata: { slotId, amount: bookingAmount, vehicleType, durationHours: bookingDurationHours },
    });

    return res.status(201).json({ message: "Booking created", booking: normalizeBookingAmount(booking) });
  } catch (error) {
    return res.status(500).json({ message: "Failed to create booking", error: error.message });
  }
};

const getBookings = async (req, res) => {
  try {
    await Booking.repairZeroAmounts(DEFAULT_BOOKING_AMOUNT);
    const bookings = await Booking.listBookings({
      isAdmin: req.user.role === "admin",
      userId: req.user.id,
    });
    return res.json(bookings.map(normalizeBookingAmount));
  } catch (error) {
    return res.status(500).json({ message: "Failed to load bookings", error: error.message });
  }
};

const getBookingById = async (req, res) => {
  try {
    await Booking.repairZeroAmounts(DEFAULT_BOOKING_AMOUNT);
    const booking = await Booking.getBooking(req.params.bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    if (req.user.role !== "admin" && booking.userId !== req.user.id) {
      return res.status(403).json({ message: "Access denied" });
    }
    return res.json(normalizeBookingAmount(booking));
  } catch (error) {
    return res.status(500).json({ message: "Failed to load booking", error: error.message });
  }
};

const cancelBooking = async (req, res) => {
  try {
    const booking = await Booking.getBooking(req.params.bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (req.user.role !== "admin" && booking.userId !== req.user.id) {
      return res.status(403).json({ message: "Access denied" });
    }

    if (!["pending", "confirmed"].includes(booking.status)) {
      return res.status(400).json({ message: `Cannot cancel a ${booking.status} booking` });
    }

    const updatedBooking = await Booking.updateBooking(booking.bookingId, {
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
    });
    await releaseSlot(booking.slotId);
    await sendNotification({
      recipientUserId: booking.userId,
      bookingId: booking.bookingId,
      type: "booking_cancelled",
      message: `Booking ${booking.bookingId} was cancelled.`,
      metadata: { slotId: booking.slotId },
    });

    return res.json({ message: "Booking cancelled", booking: normalizeBookingAmount(updatedBooking) });
  } catch (error) {
    return res.status(500).json({ message: "Failed to cancel booking", error: error.message });
  }
};

const getBookingInternal = async (req, res) => {
  try {
    await Booking.repairZeroAmounts(DEFAULT_BOOKING_AMOUNT);
    const booking = await Booking.getBooking(req.params.bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    return res.json(normalizeBookingAmount(booking));
  } catch (error) {
    return res.status(500).json({ message: "Failed to load booking", error: error.message });
  }
};

const confirmBookingInternal = async (req, res) => {
  try {
    const booking = await Booking.getBooking(req.params.bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (booking.status !== "pending") {
      return res.status(400).json({ message: `Cannot confirm a ${booking.status} booking` });
    }

    const updatedBooking = await Booking.updateBooking(booking.bookingId, {
      status: "confirmed",
      paidAt: new Date().toISOString(),
    });
    await occupySlot(booking.slotId, booking.bookingId);
    await sendNotification({
      recipientUserId: booking.userId,
      bookingId: booking.bookingId,
      type: "booking_confirmed",
      message: `Booking ${booking.bookingId} has been confirmed.`,
      metadata: { slotId: booking.slotId, amount: getAffordableAmount(booking.amount) },
    });

    return res.json({ message: "Booking confirmed", booking: normalizeBookingAmount(updatedBooking) });
  } catch (error) {
    return res.status(500).json({ message: "Failed to confirm booking", error: error.message });
  }
};

const cancelBookingInternal = async (req, res) => {
  try {
    const booking = await Booking.getBooking(req.params.bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    if (!["pending", "confirmed"].includes(booking.status)) {
      return res.status(400).json({ message: `Cannot cancel a ${booking.status} booking` });
    }

    const updatedBooking = await Booking.updateBooking(booking.bookingId, {
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
    });
    await releaseSlot(booking.slotId);
    await sendNotification({
      recipientUserId: booking.userId,
      bookingId: booking.bookingId,
      type: "booking_cancelled",
      message: `Booking ${booking.bookingId} was cancelled after payment failure.`,
      metadata: { slotId: booking.slotId },
    });

    return res.json({ message: "Booking cancelled", booking: normalizeBookingAmount(updatedBooking) });
  } catch (error) {
    return res.status(500).json({ message: "Failed to cancel booking", error: error.message });
  }
};

const expireBookingInternal = async (req, res) => {
  try {
    const booking = await Booking.getBooking(req.params.bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    if (booking.status !== "pending") {
      return res.status(400).json({ message: `Cannot expire a ${booking.status} booking` });
    }

    const updatedBooking = await Booking.updateBooking(booking.bookingId, {
      status: "expired",
      expiredAt: new Date().toISOString(),
    });
    await releaseSlot(booking.slotId);
    await sendNotification({
      recipientUserId: booking.userId,
      bookingId: booking.bookingId,
      type: "booking_expired",
      message: `Booking ${booking.bookingId} expired because payment was not completed.`,
      metadata: { slotId: booking.slotId },
    });

    return res.json({ message: "Booking expired", booking: normalizeBookingAmount(updatedBooking) });
  } catch (error) {
    return res.status(500).json({ message: "Failed to expire booking", error: error.message });
  }
};

const expirePendingBookings = async (_req, res) => {
  try {
    const now = new Date();
    const allBookings = await Booking.listBookings({ isAdmin: true });
    const pendingBookings = await Booking.findPendingBookings();
    const reminderWindowMinutes = Number(process.env.PAYMENT_RISK_REMINDER_MINUTES || 3);
    const highRiskBookings = [];

    for (const booking of pendingBookings) {
      if (!booking.expiresAt || new Date(booking.expiresAt).getTime() <= now.getTime()) {
        continue;
      }

      const risk = await getBedrockPaymentRisk({
        booking,
        bookings: allBookings,
        holdMinutes: Number(process.env.BOOKING_HOLD_MINUTES || 10),
      });
      const remainingMs = new Date(booking.expiresAt).getTime() - now.getTime();
      const insideReminderWindow = remainingMs <= reminderWindowMinutes * 60 * 1000;
      const alreadyReminded = Boolean(booking.riskReminderSentAt);

      if (risk.riskLevel === "HIGH") {
        console.log("High pending-payment expiry risk:", risk);
        highRiskBookings.push(risk);
      }

      if (risk.riskLevel === "HIGH" && insideReminderWindow && !alreadyReminded) {
        await sendNotification({
          recipientUserId: booking.userId,
          bookingId: booking.bookingId,
          type: "payment_reminder",
          message: `Booking ${booking.bookingId} may expire soon. Please complete payment to keep slot ${booking.slotId}.`,
          metadata: { slotId: booking.slotId, riskScore: risk.riskScore },
        });
        await Booking.updateBooking(booking.bookingId, {
          riskReminderSentAt: now.toISOString(),
          paymentRiskScore: risk.riskScore,
          paymentRiskLevel: risk.riskLevel,
        });
      }
    }

    const expiredBookings = await Booking.findExpiredPendingBookings(new Date().toISOString());

    for (const booking of expiredBookings) {
      await Booking.updateBooking(booking.bookingId, {
        status: "expired",
        expiredAt: new Date().toISOString(),
      });
      await releaseSlot(booking.slotId);
      await sendNotification({
        recipientUserId: booking.userId,
        bookingId: booking.bookingId,
        type: "booking_expired",
        message: `Booking ${booking.bookingId} expired and slot ${booking.slotId} was released.`,
        metadata: { slotId: booking.slotId },
      });
    }

    return res.json({
      message: "Expired booking scan completed",
      expiredCount: expiredBookings.length,
      highRiskCount: highRiskBookings.length,
      bookings: expiredBookings.map((booking) => booking.bookingId),
      highRiskBookings,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to expire pending bookings", error: error.message });
  }
};

module.exports = {
  cancelBooking,
  cancelBookingInternal,
  confirmBookingInternal,
  createBooking,
  expireBookingInternal,
  expirePendingBookings,
  getBookingById,
  getBookingInternal,
  getBookings,
};
