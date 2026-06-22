const { clamp, isPeakHour, minutesBetween, roundScore } = require("./aiUtils");

const getStatusRates = (bookings, userId) => {
  const userBookings = bookings.filter((booking) => booking.userId === userId && booking.status !== "pending");
  const total = userBookings.length;

  if (total === 0) {
    return {
      successRate: 0.5,
      failureRate: 0.5,
      hasHistory: false,
    };
  }

  const successes = userBookings.filter((booking) => booking.status === "confirmed").length;
  const failures = userBookings.filter((booking) => ["expired", "cancelled"].includes(booking.status)).length;

  return {
    successRate: successes / total,
    failureRate: failures / total,
    hasHistory: true,
  };
};

const getRiskLevel = (riskScore) => {
  if (riskScore >= 0.75) {
    return "HIGH";
  }
  if (riskScore >= 0.45) {
    return "MEDIUM";
  }
  return "LOW";
};

const predictPaymentRisk = ({ booking, bookings, now = new Date(), holdMinutes = 10 }) => {
  const createdAt = booking.createdAt || booking.timestamp;
  const expiresAt = booking.expiresAt;
  const ageMinutes = minutesBetween(createdAt, now) ?? 0;
  const remainingMinutes = expiresAt ? minutesBetween(now, expiresAt) ?? 0 : Math.max(0, holdMinutes - ageMinutes);
  const elapsedRatio = clamp(ageMinutes / Math.max(holdMinutes, 1));
  const remainingPressure = clamp(1 - remainingMinutes / Math.max(holdMinutes, 1));
  const userRates = getStatusRates(bookings, booking.userId);
  const amount = Number(booking.amount) || 0;
  const amountPressure = clamp((amount - 50) / 150);
  const peakPressure = isPeakHour(createdAt || now) ? 0.12 : 0;

  // Weighted statistical scoring: older holds, lower remaining time, and previous failures increase expiry risk.
  const rawScore =
    elapsedRatio * 0.34 +
    remainingPressure * 0.28 +
    userRates.failureRate * 0.22 +
    amountPressure * 0.08 +
    peakPressure;

  const riskScore = roundScore(rawScore);
  const riskLevel = getRiskLevel(riskScore);

  return {
    bookingId: booking.bookingId,
    riskLevel,
    riskScore,
    action: riskLevel === "HIGH" ? "SEND_PAYMENT_REMINDER" : "MONITOR",
    factors: {
      ageMinutes: Math.round(ageMinutes),
      remainingMinutes: Math.round(remainingMinutes),
      userPaymentHistory: userRates.hasHistory ? "AVAILABLE" : "FALLBACK_DEFAULT",
      peakHour: isPeakHour(createdAt || now),
    },
  };
};

module.exports = {
  predictPaymentRisk,
};
