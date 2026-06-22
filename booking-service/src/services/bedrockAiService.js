const { recommendSlot } = require("./aiRecommendationService");
const { buildDemandFeatures } = require("./dynamoDemandFeatures");
const { predictDemand } = require("./demandPredictionService");
const { generateJson, isBedrockEnabled } = require("./bedrockService");
const { predictPaymentRisk } = require("./paymentRiskService");

const compactBookings = (bookings, limit = 80) =>
  bookings.slice(0, limit).map((booking) => ({
    bookingId: booking.bookingId,
    userId: booking.userId,
    slotId: booking.slotId,
    vehicleType: booking.vehicleType,
    durationHours: Number(booking.durationHours) || 1,
    amount: Number(booking.amount) || 0,
    status: booking.status,
    createdAt: booking.createdAt || booking.timestamp,
    expiresAt: booking.expiresAt,
    paidAt: booking.paidAt,
  }));

const compactSlots = (slots) =>
  slots.map((slot) => ({
    slotId: slot.slotId,
    location: slot.location,
    status: slot.status,
    price: Number(slot.price) || 0,
  }));

const withFallback = async (fallback, bedrockCall) => {
  if (!isBedrockEnabled()) {
    return { ...fallback, aiProvider: "LOCAL_FALLBACK" };
  }

  try {
    const result = await bedrockCall();
    return { ...fallback, ...result, aiProvider: "BEDROCK_NOVA" };
  } catch (error) {
    console.error("Bedrock AI fallback used:", error.response?.data || error.message);
    return { ...fallback, aiProvider: "LOCAL_FALLBACK", aiError: "Bedrock unavailable or returned invalid JSON" };
  }
};

const normalizeScore = (score, fallbackScore) => {
  const numericScore = Number(score);
  if (!Number.isFinite(numericScore)) {
    return fallbackScore;
  }
  return Math.min(1, Math.max(0, Number(numericScore.toFixed(2))));
};

const recommendationSchema = {
  type: "OBJECT",
  properties: {
    recommendedSlotId: { type: "STRING" },
    reason: { type: "STRING" },
    score: { type: "NUMBER" },
  },
  required: ["recommendedSlotId", "reason", "score"],
};

const demandSchema = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      time: { type: "STRING" },
      predictedBookedSlots: { type: "NUMBER" },
      predictedAvailableSlots: { type: "NUMBER" },
      demandLevel: { type: "STRING" },
    },
    required: ["time", "predictedBookedSlots", "predictedAvailableSlots", "demandLevel"],
  },
};

const paymentRiskSchema = {
  type: "OBJECT",
  properties: {
    bookingId: { type: "STRING" },
    riskLevel: { type: "STRING" },
    riskScore: { type: "NUMBER" },
    action: { type: "STRING" },
  },
  required: ["bookingId", "riskLevel", "riskScore", "action"],
};

const getBedrockSlotRecommendation = async ({ slots, bookings, userId, durationHours }) => {
  const fallback = recommendSlot({ slots, bookings, userId, durationHours });
  const demandFeatures = buildDemandFeatures({ slots, bookings });
  return withFallback(fallback, async () =>
    generateJson({
      prompt: `You are the AI decision engine for Quickslot, a smart parking system.
Recommend exactly one best available slot for the user.
Use only available slots. Base demand reasoning only on the DynamoDB-derived demand features provided below.
Consider location, current status, historical booking frequency, same-hour history, active pressure, cancellation/expiry pressure, requested duration, price, and pending payment risk.
Return only JSON matching this schema:
{"recommendedSlotId":"string","reason":"string","score":0.0}
Score must be between 0 and 1.

User context:
${JSON.stringify({ userId, durationHours, now: new Date().toISOString() })}

Slots:
${JSON.stringify(compactSlots(slots))}

Recent booking history:
${JSON.stringify(compactBookings(bookings))}

DynamoDB-derived demand features:
${JSON.stringify(demandFeatures)}`,
    }).then((result) => {
      const availableSlotIds = new Set(slots.filter((slot) => slot.status === "available").map((slot) => slot.slotId));
      if (!availableSlotIds.has(result.recommendedSlotId)) {
        throw new Error("Bedrock recommended a slot that is not available");
      }
      return {
        recommendedSlotId: result.recommendedSlotId,
        reason: result.reason || fallback.reason,
        score: normalizeScore(result.score, fallback.score),
      };
    })
  );
};

const getBedrockDemandPrediction = async ({ slots, bookings, hours }) => {
  const demandFeatures = buildDemandFeatures({ slots, bookings });
  const fallback = predictDemand({ slots, bookings, totalSlots: slots.length, hours });
  return withFallback({ predictions: fallback }, async () => {
    const result = await generateJson({
      prompt: `You are the AI demand prediction engine for Quickslot, a smart parking system.
Predict parking demand for the next ${hours} hours.
Use only the DynamoDB-derived slots/bookings features below.
Do not use generic city traffic, assumptions, or hardcoded peak hours unless the DynamoDB booking records show same-hour demand.
Demand level must be justified by activeSlotPressure, historicalPressure, sameHourPressure, availabilityRatio, and cancellationExpiryPressure.
Return only a JSON array. Demand level must be LOW, MEDIUM, or HIGH.

Context:
${JSON.stringify({ now: new Date().toISOString(), totalSlots: slots.length, hours })}

Slots:
${JSON.stringify(compactSlots(slots))}

Recent booking history:
${JSON.stringify(compactBookings(bookings, 120))}

DynamoDB-derived demand features:
${JSON.stringify(demandFeatures)}`,
    });
    return {
      predictions: result.map((item, index) => ({
        time: item.time || fallback[index]?.time,
        predictedBookedSlots: Math.max(0, Math.round(Number(item.predictedBookedSlots) || 0)),
        predictedAvailableSlots: Math.max(0, Math.round(Number(item.predictedAvailableSlots) || 0)),
        demandLevel: ["LOW", "MEDIUM", "HIGH"].includes(item.demandLevel) ? item.demandLevel : "MEDIUM",
      })),
    };
  }).then((result) => result.predictions.map((item) => ({ ...item, aiProvider: result.aiProvider })));
};

const getBedrockPaymentRisk = async ({ booking, bookings, holdMinutes }) => {
  const fallback = predictPaymentRisk({ booking, bookings, holdMinutes });
  return withFallback(fallback, async () =>
    generateJson({
      prompt: `You are the AI payment-risk engine for Quickslot, a smart parking system.
Predict whether this pending booking is likely to expire before payment.
Consider time since booking was created, remaining time before expiry, user's previous payment success/failure history, booking amount, and peak-hour pressure.
Return only JSON matching this schema:
{"bookingId":"string","riskLevel":"LOW|MEDIUM|HIGH","riskScore":0.0,"action":"MONITOR|SEND_PAYMENT_REMINDER"}
Risk score must be between 0 and 1.

Booking to score:
${JSON.stringify(booking)}

Hold minutes:
${holdMinutes}

User and system booking history:
${JSON.stringify(compactBookings(bookings))}`,
    }).then((result) => ({
      bookingId: booking.bookingId,
      riskLevel: ["LOW", "MEDIUM", "HIGH"].includes(result.riskLevel) ? result.riskLevel : fallback.riskLevel,
      riskScore: normalizeScore(result.riskScore, fallback.riskScore),
      action: ["MONITOR", "SEND_PAYMENT_REMINDER"].includes(result.action) ? result.action : fallback.action,
    }))
  );
};

module.exports = {
  getBedrockDemandPrediction,
  getBedrockPaymentRisk,
  getBedrockSlotRecommendation,
};
