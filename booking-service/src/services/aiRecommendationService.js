const { average, getHour, hoursBetween, isPeakHour, roundScore } = require("./aiUtils");
const { buildDemandFeatures, normalizeLocation } = require("./dynamoDemandFeatures");
const { predictPaymentRisk } = require("./paymentRiskService");

const getZone = (slot) => {
  const location = String(slot.location || "");
  const zoneMatch = location.match(/^[^-]+/);
  return zoneMatch ? zoneMatch[0].trim() : "General";
};

const getFloorNumber = (slot) => {
  const text = `${slot.location || ""} ${slot.slotId || ""}`;
  const match = text.match(/(?:L|floor|level|basement)[\s-]*(\d+)/i);
  return match ? Number(match[1]) : 1;
};

const getDistanceScore = (slot) => {
  const text = `${slot.location || ""} ${slot.slotId || ""}`.toLowerCase();
  if (text.includes("basement") || text.includes("north") || text.includes("entry")) {
    return 1;
  }
  if (text.includes("east") || text.includes("west")) {
    return 0.75;
  }
  return Math.max(0.35, 1 - (getFloorNumber(slot) - 1) * 0.18);
};

const getDemandMetrics = (bookings) => {
  const slotCounts = new Map();

  bookings.forEach((booking) => {
    if (!booking.slotId) {
      return;
    }
    slotCounts.set(booking.slotId, (slotCounts.get(booking.slotId) || 0) + 1);
  });

  return { slotCounts };
};

const getDurationFitScore = (slot, requestedDurationHours, bookings) => {
  const durations = bookings
    .filter((booking) => booking.slotId === slot.slotId && booking.paidAt && booking.createdAt)
    .map((booking) => hoursBetween(booking.createdAt, booking.paidAt))
    .filter((value) => value !== null);

  if (durations.length < 3) {
    return requestedDurationHours <= 2 ? 0.75 : 0.65;
  }

  const avgDuration = average(durations);
  return Math.max(0.25, 1 - Math.abs(avgDuration - requestedDurationHours) / Math.max(requestedDurationHours, 1));
};

const buildReason = ({ slot, demandScore, durationScore, paymentRisk, locationDemand }) => {
  const reasons = [`Slot ${slot.slotId} is available`];
  if (locationDemand) {
    reasons.push(
      `${locationDemand.location} is ${locationDemand.demandLevel.toLowerCase()} demand from DynamoDB booking history and current slot pressure`
    );
  } else {
    reasons.push(demandScore >= 0.7 ? "less demanded historically" : "balanced for current demand");
  }
  reasons.push(durationScore >= 0.7 ? "suitable for your booking duration" : "acceptable for your booking duration");
  if (paymentRisk.riskLevel === "LOW") {
    reasons.push("has low pending-payment expiry risk");
  }
  return `${reasons.join(", ")}.`;
};

const recommendSlot = ({ slots, bookings, userId, durationHours = 1, now = new Date() }) => {
  const availableSlots = slots.filter((slot) => slot.status === "available");

  if (availableSlots.length === 0) {
    return {
      recommendedSlotId: null,
      reason: "No available slot can be recommended right now.",
      score: 0,
    };
  }

  const { slotCounts } = getDemandMetrics(bookings);
  const demandFeatures = buildDemandFeatures({ slots, bookings, now });
  const demandByLocation = new Map(demandFeatures.locationDemand.map((item) => [item.location, item]));
  const maxSlotCount = Math.max(1, ...Array.from(slotCounts.values()));
  const activePending = bookings.filter((booking) => booking.status === "pending").length;
  const currentDemandPressure = slots.length > 0 ? activePending / slots.length : 0;

  const scored = availableSlots.map((slot) => {
    const historicalCount = slotCounts.get(slot.slotId) || 0;
    const locationDemand = demandByLocation.get(normalizeLocation(slot.location));
    const demandScore = locationDemand ? 1 - locationDemand.demandScore : 1 - historicalCount / maxSlotCount;
    const distanceScore = getDistanceScore(slot);
    const durationScore = getDurationFitScore(slot, Number(durationHours) || 1, bookings);
    const peakScore = isPeakHour(now) ? (getFloorNumber(slot) <= 1 ? 0.85 : 0.65) : 0.8;
    const pendingRisk = predictPaymentRisk({
      booking: {
        bookingId: `SIM-${slot.slotId}`,
        userId,
        slotId: slot.slotId,
        amount: slot.price,
        status: "pending",
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      },
      bookings,
      now,
    });
    const pendingPaymentScore = 1 - pendingRisk.riskScore;

    // Weighted recommendation: availability is pre-filtered, then we balance convenience, demand, fit, and risk.
    const score = roundScore(
      0.22 +
        distanceScore * 0.18 +
        demandScore * 0.2 +
        durationScore * 0.16 +
        peakScore * 0.12 +
        pendingPaymentScore * 0.08 +
        (1 - currentDemandPressure) * 0.04
    );

    return {
      slot,
      score,
      demandScore,
      durationScore,
      pendingRisk,
      hour: getHour(now),
      zone: getZone(slot),
      locationDemand,
    };
  });

  scored.sort((left, right) => right.score - left.score || String(left.slot.slotId).localeCompare(String(right.slot.slotId)));
  const best = scored[0];

  return {
    recommendedSlotId: best.slot.slotId,
    reason: buildReason({
      slot: best.slot,
      demandScore: best.demandScore,
      durationScore: best.durationScore,
      paymentRisk: best.pendingRisk,
      locationDemand: best.locationDemand,
    }),
    score: best.score,
    details: {
      zone: best.zone,
      hour: best.hour,
      comparedAvailableSlots: availableSlots.length,
      model: "weighted_rule_based_scoring",
      demandSource: "DynamoDB slots and bookings",
      demandLevel: best.locationDemand?.demandLevel || "LOW",
      demandScore: best.locationDemand?.demandScore ?? null,
    },
  };
};

module.exports = {
  recommendSlot,
};
