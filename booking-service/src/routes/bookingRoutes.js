const express = require("express");
const {
  cancelBooking,
  cancelBookingInternal,
  confirmBookingInternal,
  createBooking,
  expireBookingInternal,
  expirePendingBookings,
  getBookingById,
  getBookingInternal,
  getBookings,
} = require("../controllers/bookingController");
const { authenticate, requireInternalKey } = require("../middleware/auth");

const router = express.Router();

router.get("/health", (_req, res) => res.json({ service: "booking-service", status: "ok" }));
router.post("/bookings", authenticate, createBooking);
router.get("/bookings", authenticate, getBookings);
router.get("/bookings/:bookingId", authenticate, getBookingById);
router.post("/bookings/:bookingId/cancel", authenticate, cancelBooking);

router.get("/internal/bookings/:bookingId", requireInternalKey, getBookingInternal);
router.post("/internal/bookings/:bookingId/confirm", requireInternalKey, confirmBookingInternal);
router.post("/internal/bookings/:bookingId/cancel", requireInternalKey, cancelBookingInternal);
router.post("/internal/bookings/:bookingId/expire", requireInternalKey, expireBookingInternal);
router.post("/internal/bookings/expire-pending", requireInternalKey, expirePendingBookings);

module.exports = router;

