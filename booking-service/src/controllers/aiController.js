const Booking = require("../models/Booking");
const { internalHeaders, parkingClient } = require("../config/http");
const {
  getBedrockDemandPrediction,
  getBedrockPaymentRisk,
  getBedrockSlotRecommendation,
} = require("../services/bedrockAiService");
const {
  getAssistantChatResponse,
  getAssistantOptions,
  getAssistantRecommendation,
} = require("../services/aiAssistantService");

const getSlots = async () => {
  const response = await parkingClient.get("/internal/slots", { headers: internalHeaders() });
  return response.data || [];
};

const getRecommendation = async (req, res) => {
  try {
    const [slots, bookings] = await Promise.all([getSlots(), Booking.listBookings({ isAdmin: true })]);
    const recommendation = await getBedrockSlotRecommendation({
      slots,
      bookings,
      userId: req.user.id,
      durationHours: Number(req.query.durationHours || req.query.duration || 1),
    });

    return res.json(recommendation);
  } catch (error) {
    return res.status(500).json({ message: "Failed to recommend slot", error: error.message });
  }
};

const getDemandPrediction = async (req, res) => {
  try {
    const [slots, bookings] = await Promise.all([getSlots(), Booking.listBookings({ isAdmin: true })]);
    const predictions = await getBedrockDemandPrediction({
      slots,
      bookings,
      hours: Number(req.query.hours || 6),
    });

    return res.json(predictions);
  } catch (error) {
    return res.status(500).json({ message: "Failed to predict demand", error: error.message });
  }
};

const getPaymentRisk = async (req, res) => {
  try {
    const booking = await Booking.getBooking(req.params.bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    if (req.user.role !== "admin" && booking.userId !== req.user.id) {
      return res.status(403).json({ message: "Access denied" });
    }

    const bookings = await Booking.listBookings({ isAdmin: true });
    return res.json(
      await getBedrockPaymentRisk({
        booking,
        bookings,
        holdMinutes: Number(process.env.BOOKING_HOLD_MINUTES || 10),
      })
    );
  } catch (error) {
    return res.status(500).json({ message: "Failed to predict payment risk", error: error.message });
  }
};

const getAssistantSlotOptions = async (req, res) => {
  try {
    const [slots, bookings] = await Promise.all([getSlots(), Booking.listBookings({ isAdmin: true })]);
    return res.json(
      getAssistantOptions({
        slots,
        bookings,
        vehicleType: req.query.vehicleType,
      })
    );
  } catch (error) {
    return res.status(500).json({ message: "Failed to load assistant options", error: error.message });
  }
};

const getAssistantSlotRecommendation = async (req, res) => {
  try {
    const { vehicleType, location } = req.query;
    if (!vehicleType || !location) {
      return res.status(400).json({ message: "vehicleType and location are required" });
    }

    const [slots, bookings] = await Promise.all([getSlots(), Booking.listBookings({ isAdmin: true })]);
    const fallbackRecommendation = getAssistantRecommendation({
      slots,
      bookings,
      userId: req.user.id,
      vehicleType,
      location,
      durationHours: Number(req.query.durationHours || 1),
    });
    const llmRecommendation = await getAssistantChatResponse({
      message: `Recommend the best ${vehicleType} parking slot for ${Number(
        req.query.durationHours || 1
      )} hour(s) in ${location}. Prefer low demand and explain the reason.`,
      slots,
      bookings,
      userId: req.user.id,
    });

    return res.json({
      ...fallbackRecommendation,
      ...llmRecommendation,
      score: llmRecommendation.confidence ?? fallbackRecommendation.score,
      paymentPrompt: llmRecommendation.recommendedSlotId
        ? `I found slot ${llmRecommendation.recommendedSlotId}. Shall I reserve it and take you to payment?`
        : fallbackRecommendation.paymentPrompt,
      nextStep: llmRecommendation.recommendedSlotId ? "PROCEED_TO_PAYMENT" : "TRY_ANOTHER_LOCATION",
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to recommend assistant slot", error: error.message });
  }
};

const chatWithAssistant = async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || String(message).trim().length < 2) {
      return res.status(400).json({ message: "message is required" });
    }

    const [slots, bookings] = await Promise.all([getSlots(), Booking.listBookings({ isAdmin: true })]);
    return res.json(
      await getAssistantChatResponse({
        message: String(message).trim(),
        slots,
        bookings,
        userId: req.user.id,
      })
    );
  } catch (error) {
    return res.status(500).json({ message: "Failed to chat with assistant", error: error.message });
  }
};

module.exports = {
  chatWithAssistant,
  getAssistantSlotOptions,
  getAssistantSlotRecommendation,
  getDemandPrediction,
  getPaymentRisk,
  getRecommendation,
};
