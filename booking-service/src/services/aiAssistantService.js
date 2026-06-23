const { recommendSlot } = require("./aiRecommendationService");
const { generateJson, isBedrockEnabled } = require("./bedrockService");
const { buildDemandFeatures } = require("./dynamoDemandFeatures");

const VEHICLE_TYPES = [
  { id: "two-wheeler", label: "Two-wheeler" },
  { id: "four-wheeler", label: "Four-wheeler" },
];

const normalizeLocation = (location) => String(location || "General").trim() || "General";

const slotSupportsVehicle = (slot, vehicleType) => {
  const text = `${slot.slotId || ""} ${slot.location || ""}`.toLowerCase();
  const explicitlyTwoWheeler = /(two|2)[-\s]?wheeler|bike|scooter|motorcycle/.test(text);
  const explicitlyFourWheeler = /(four|4)[-\s]?wheeler|car|suv/.test(text);

  if (vehicleType === "two-wheeler") {
    return !explicitlyFourWheeler || explicitlyTwoWheeler;
  }
  if (vehicleType === "four-wheeler") {
    return !explicitlyTwoWheeler || explicitlyFourWheeler;
  }
  return true;
};

const getLocationDemand = ({ location, slots, bookings }) => {
  const locationSlots = slots.filter((slot) => normalizeLocation(slot.location) === location);
  const slotIds = new Set(locationSlots.map((slot) => slot.slotId));
  const availableSlots = locationSlots.filter((slot) => slot.status === "available").length;
  const activeSlots = locationSlots.filter((slot) => ["reserved", "occupied"].includes(slot.status)).length;
  const historicalBookings = bookings.filter((booking) => slotIds.has(booking.slotId)).length;

  const activePressure = locationSlots.length > 0 ? activeSlots / locationSlots.length : 1;
  const historyPressure = Math.min(1, historicalBookings / Math.max(1, bookings.length || 1));
  const demandScore = Number((activePressure * 0.65 + historyPressure * 0.35).toFixed(2));

  let demandLevel = "LOW";
  if (demandScore >= 0.66) {
    demandLevel = "HIGH";
  } else if (demandScore >= 0.34) {
    demandLevel = "MEDIUM";
  }

  return {
    location,
    availableSlots,
    totalSlots: locationSlots.length,
    demandLevel,
    demandScore,
    reason:
      demandLevel === "LOW"
        ? `${location} has open slots and lower recent booking pressure.`
        : `${location} has ${demandLevel.toLowerCase()} demand based on active and historical bookings.`,
  };
};

const getAssistantOptions = ({ slots, bookings, vehicleType }) => {
  const compatibleSlots = slots.filter((slot) => slotSupportsVehicle(slot, vehicleType));
  const locations = Array.from(new Set(compatibleSlots.map((slot) => normalizeLocation(slot.location))))
    .map((location) => getLocationDemand({ location, slots: compatibleSlots, bookings }))
    .filter((item) => item.totalSlots > 0)
    .sort(
      (left, right) =>
        left.demandScore - right.demandScore ||
        right.availableSlots - left.availableSlots ||
        left.location.localeCompare(right.location)
    );

  return {
    vehicleTypes: VEHICLE_TYPES,
    selectedVehicleType: vehicleType || null,
    locations,
    suggestedLocation: locations.find((item) => item.availableSlots > 0) || locations[0] || null,
    message: vehicleType
      ? "I checked current availability and past booking demand. These locations are sorted from lowest demand to highest."
      : "I can help you find a low-demand slot. Choose your vehicle type first.",
  };
};

const getAssistantRecommendation = ({ slots, bookings, userId, vehicleType, location, durationHours }) => {
  const compatibleSlots = slots.filter(
    (slot) => slotSupportsVehicle(slot, vehicleType) && normalizeLocation(slot.location) === normalizeLocation(location)
  );
  const locationDemand = getLocationDemand({
    location: normalizeLocation(location),
    slots: compatibleSlots,
    bookings,
  });
  const recommendation = recommendSlot({
    slots: compatibleSlots,
    bookings,
    userId,
    durationHours,
  });

  return {
    vehicleType,
    location: normalizeLocation(location),
    demandLevel: locationDemand.demandLevel,
    recommendedSlotId: recommendation.recommendedSlotId,
    reason: recommendation.recommendedSlotId
      ? `${recommendation.reason} ${locationDemand.reason}`
      : `No available ${vehicleType || "vehicle"} slot is available in ${normalizeLocation(location)} right now.`,
    score: recommendation.score,
    nextStep: recommendation.recommendedSlotId ? "PROCEED_TO_PAYMENT" : "TRY_ANOTHER_LOCATION",
    paymentPrompt: recommendation.recommendedSlotId
      ? `I found slot ${recommendation.recommendedSlotId}. Shall I reserve it and take you to payment?`
      : "Please choose another location with available slots.",
  };
};

const assistantChatSchema = {
  type: "OBJECT",
  properties: {
    reply: { type: "STRING" },
    vehicleType: { type: "STRING" },
    durationHours: { type: "NUMBER" },
    preferredLocation: { type: "STRING" },
    recommendedSlotId: { type: "STRING" },
    reason: { type: "STRING" },
    refusalReason: { type: "STRING" },
    confidence: { type: "NUMBER" },
    nextAction: { type: "STRING" },
    nearestResults: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          slotId: { type: "STRING" },
          location: { type: "STRING" },
          totalPrice: { type: "NUMBER" },
          reason: { type: "STRING" },
        },
      },
    },
  },
  required: ["reply", "vehicleType", "durationHours", "recommendedSlotId", "reason", "confidence", "nextAction"],
};

const compactSlotsForRetrieval = (slots) =>
  slots.map((slot) => ({
    slotId: slot.slotId,
    location: slot.location,
    status: slot.status,
    price: Number(slot.price) || 0,
  }));

const compactBookingsForRetrieval = (bookings, limit = 100) =>
  bookings.slice(0, limit).map((booking) => ({
    slotId: booking.slotId,
    status: booking.status,
    vehicleType: booking.vehicleType,
    durationHours: Number(booking.durationHours) || 1,
    amount: Number(booking.amount) || 0,
    createdAt: booking.createdAt || booking.timestamp,
    paidAt: booking.paidAt,
    expiresAt: booking.expiresAt,
  }));

const buildRagContext = ({ slots, bookings }) => {
  const availableSlots = slots.filter((slot) => slot.status === "available");
  const demandFeatures = buildDemandFeatures({ slots, bookings });
  const locations = Array.from(new Set(slots.map((slot) => normalizeLocation(slot.location)))).map((location) =>
    getLocationDemand({ location, slots, bookings })
  );

  return {
    generatedAt: new Date().toISOString(),
    totalSlots: slots.length,
    availableSlots: availableSlots.length,
    activeBookings: bookings.filter((booking) => ["pending", "confirmed"].includes(booking.status)).length,
    locationDemand: demandFeatures.locationDemand,
    legacyLocationDemand: locations.sort((left, right) => left.demandScore - right.demandScore),
    demandFeatures,
    slots: compactSlotsForRetrieval(slots),
    recentBookings: compactBookingsForRetrieval(bookings),
  };
};

const inferBudgetAmount = (message) => {
  const text = String(message || "").toLowerCase();
  const match =
    text.match(/(?:rs\.?|rupees?|inr|₹)\s*(\d+(?:\.\d+)?)/i) ||
    text.match(/(\d+(?:\.\d+)?)\s*(?:rs\.?|rupees?|inr|₹)/i) ||
    text.match(/(?:budget|under|below|within|max(?:imum)?|price)\D{0,12}(\d+(?:\.\d+)?)/i);

  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
};

const getClosestAvailableSlotsByPrice = ({ slots, durationHours, budgetAmount, limit = 3 }) => {
  const duration = Math.min(24, Math.max(1, Number(durationHours) || 1));
  return slots
    .filter((slot) => slot.status === "available")
    .map((slot) => {
      const totalPrice = (Number(slot.price) || 0) * duration;
      return {
        slotId: slot.slotId,
        location: slot.location,
        basePrice: Number(slot.price) || 0,
        durationHours: duration,
        totalPrice,
        overBudgetBy: budgetAmount == null ? 0 : Math.max(0, totalPrice - budgetAmount),
      };
    })
    .sort((left, right) => {
      if (budgetAmount == null) {
        return left.totalPrice - right.totalPrice || String(left.slotId).localeCompare(String(right.slotId));
      }
      return (
        Math.abs(left.totalPrice - budgetAmount) - Math.abs(right.totalPrice - budgetAmount) ||
        left.totalPrice - right.totalPrice ||
        String(left.slotId).localeCompare(String(right.slotId))
      );
    })
    .slice(0, limit);
};

const inferVehicleType = (message, fallback = "four-wheeler") => {
  const text = String(message || "").toLowerCase();
  if (/two|2|bike|scooter|motorcycle/.test(text)) {
    return "two-wheeler";
  }
  if (/four|4|car|suv/.test(text)) {
    return "four-wheeler";
  }
  return fallback;
};

const inferDurationHours = (message, fallback = 1) => {
  const match = String(message || "").match(/(\d+(?:\.\d+)?)\s*(?:hour|hr|hrs|h)\b/i);
  if (!match) {
    return fallback;
  }
  return Math.min(24, Math.max(1, Math.ceil(Number(match[1]) || fallback)));
};

const inferPreferredLocation = (message, slots) => {
  const text = String(message || "").toLowerCase();
  const locations = Array.from(new Set(slots.map((slot) => normalizeLocation(slot.location)))).sort(
    (left, right) => right.length - left.length
  );

  return locations.find((location) => text.includes(location.toLowerCase())) || "";
};

const getIntentCompatibleSlots = ({ slots, vehicleType, preferredLocation, durationHours, budgetAmount }) => {
  const normalizedLocation = normalizeLocation(preferredLocation);
  const hasLocation = Boolean(String(preferredLocation || "").trim());

  return slots
    .filter((slot) => {
      const totalPrice = (Number(slot.price) || 0) * durationHours;
      return (
        slot.status === "available" &&
        slotSupportsVehicle(slot, vehicleType) &&
        (!hasLocation || normalizeLocation(slot.location) === normalizedLocation) &&
        (budgetAmount == null || totalPrice <= budgetAmount)
      );
    })
    .map((slot) => ({
      slotId: slot.slotId,
      location: normalizeLocation(slot.location),
      pricePerHour: Number(slot.price) || 0,
      totalPrice: (Number(slot.price) || 0) * durationHours,
    }))
    .sort(
      (left, right) =>
        left.totalPrice - right.totalPrice ||
        left.location.localeCompare(right.location) ||
        String(left.slotId).localeCompare(String(right.slotId))
    );
};

const getRelevantLocationDemand = ({ locationDemand, preferredLocation }) => {
  const normalizedLocation = normalizeLocation(preferredLocation);
  const hasLocation = Boolean(String(preferredLocation || "").trim());
  const demand = hasLocation
    ? locationDemand.filter((item) => normalizeLocation(item.location) === normalizedLocation)
    : locationDemand;

  return demand.slice(0, 8);
};

const getFallbackAssistantChat = ({ message, slots, bookings, userId }) => {
  const vehicleType = inferVehicleType(message);
  const durationHours = inferDurationHours(message);
  const budgetAmount = inferBudgetAmount(message);
  const withinBudgetSlots =
    budgetAmount == null
      ? slots
      : slots.filter((slot) => slot.status !== "available" || (Number(slot.price) || 0) * durationHours <= budgetAmount);
  const closestSlots = getClosestAvailableSlotsByPrice({ slots, durationHours, budgetAmount });

  if (budgetAmount != null && closestSlots.every((slot) => slot.totalPrice > budgetAmount)) {
    const closestText = closestSlots
      .map((slot) => `${slot.slotId} at Rs ${slot.totalPrice} for ${durationHours} hour(s)`)
      .join(", ");
    const messageText = `We do not have an available slot within Rs ${budgetAmount} for ${durationHours} hour(s). Closest available option(s): ${closestText}.`;
    return {
      reply: messageText,
      vehicleType,
      durationHours,
      budgetAmount,
      preferredLocation: "",
      recommendedSlotId: null,
      reason: messageText,
      refusalReason: messageText,
      confidence: 0,
      nextAction: "NO_SLOT_AVAILABLE",
      aiProvider: "LOCAL_FALLBACK",
      retrievedContext: {
        availableSlots: slots.filter((slot) => slot.status === "available").length,
        bookingHistoryRecords: bookings.length,
        nearestResults: closestSlots,
        closestPriceOptions: closestSlots,
      },
    };
  }

  const options = getAssistantOptions({ slots: withinBudgetSlots, bookings, vehicleType });
  const location = options.suggestedLocation?.location || normalizeLocation(slots[0]?.location);
  const recommendation = getAssistantRecommendation({
    slots: withinBudgetSlots,
    bookings,
    userId,
    vehicleType,
    location,
    durationHours,
  });

  return {
    reply: recommendation.recommendedSlotId
      ? `I found ${recommendation.recommendedSlotId} for your ${vehicleType.replace("-", " ")} for ${durationHours} hour(s). ${recommendation.reason}`
      : `I could not find an available ${vehicleType.replace("-", " ")} slot for that request right now.`,
    vehicleType,
    durationHours,
    budgetAmount,
    preferredLocation: location,
    recommendedSlotId: recommendation.recommendedSlotId,
    reason: recommendation.reason,
    confidence: recommendation.score,
    nextAction: recommendation.nextStep,
    aiProvider: "LOCAL_FALLBACK",
    retrievedContext: {
      availableSlots: slots.filter((slot) => slot.status === "available").length,
      bookingHistoryRecords: bookings.length,
      nearestResults: closestSlots,
      closestPriceOptions: closestSlots,
      locationDemand: options.locations.slice(0, 5),
    },
  };
};

const getAssistantChatResponse = async ({ message, slots, bookings, userId }) => {
  if (!isBedrockEnabled()) {
    return {
      ...getFallbackAssistantChat({ message, slots, bookings, userId }),
      aiError: "Bedrock is not configured, so the assistant used local fallback scoring.",
    };
  }

  try {
    const ragContext = buildRagContext({ slots, bookings });
    const requestedBudgetAmount = inferBudgetAmount(message);
    const requestedVehicleType = inferVehicleType(message);
    const requestedDurationHours = inferDurationHours(message);
    const requestedPreferredLocation = inferPreferredLocation(message, slots);
    const intentCompatibleSlots = getIntentCompatibleSlots({
      slots,
      vehicleType: requestedVehicleType,
      preferredLocation: requestedPreferredLocation,
      durationHours: requestedDurationHours,
      budgetAmount: requestedBudgetAmount,
    });
    const closestPriceOptions = getClosestAvailableSlotsByPrice({
      slots: slots.filter(
        (slot) =>
          slotSupportsVehicle(slot, requestedVehicleType) &&
          (!requestedPreferredLocation ||
            normalizeLocation(slot.location) === normalizeLocation(requestedPreferredLocation))
      ),
      durationHours: requestedDurationHours,
      budgetAmount: requestedBudgetAmount,
    });
    const result = await generateJson({
      temperature: 0.25,
      prompt: `You are QuickSlot AI, a conversational parking assistant inside the QuickSlot smart parking app.
Talk naturally like a helpful chat assistant, not like predefined if/else text.
Use only the retrieved live QuickSlot context below. The context is built from DynamoDB slots and bookings tables.
Do not invent slots, locations, prices, availability, bookings, demand, or policy.

Your job:
1. Understand the user's message in natural language.
2. Infer vehicle type, duration, location, budget, or booking intent when possible.
3. Treat requestIntent and compatibleAvailableSlots as the strongest grounding signals.
4. Answer conversationally based on live slot, price, booking context, and DynamoDB-derived demandFeatures.
5. Recommend a currently available slot only when the retrieved data supports it.
6. If the exact request cannot be satisfied, clearly say that QuickSlot cannot get an exact output for that query and then provide the nearest/closest available results from closestPriceOptions or locationDemand.
7. If the query is outside parking/booking/payment/demand context or cannot be answered from retrieved data, say you cannot determine it from current QuickSlot data and suggest what detail the user should provide.

Rules:
- Supported vehicle types are only "two-wheeler" and "four-wheeler".
- Budget means maximum total booking amount for the requested duration.
- If requestIntent has a preferredLocation, do not recommend a slot from another location unless no exact location match exists; explain the mismatch clearly.
- Prefer compatibleAvailableSlots for recommendedSlotId. If this list is empty, recommendedSlotId must be an empty string.
- Demand must be LOW, MEDIUM, or HIGH based on demandFeatures only. Use activeSlotPressure, historicalPressure, sameHourPressure, availabilityRatio, and cancellationExpiryPressure.
- If demandFeatures do not contain enough data for a confident demand answer, say that current DynamoDB data is limited and provide the nearest supported result.
- Do not recommend any slot whose total price exceeds the user's budget.
- recommendedSlotId must be an available slotId from retrieved context, otherwise use an empty string.
- nearestResults must contain closest useful options when exact output is unavailable.
- nextAction must be one of "ASK_DETAILS", "SUGGEST_SLOT", "PROCEED_TO_PAYMENT", "NO_SLOT_AVAILABLE", "ANSWER_ONLY".
- Return only valid JSON matching this shape:
{"reply":"string","vehicleType":"two-wheeler|four-wheeler","durationHours":1,"preferredLocation":"string","recommendedSlotId":"string","reason":"string","refusalReason":"string","confidence":0.0,"nextAction":"ASK_DETAILS|SUGGEST_SLOT|PROCEED_TO_PAYMENT|NO_SLOT_AVAILABLE|ANSWER_ONLY","nearestResults":[{"slotId":"string","location":"string","totalPrice":0,"reason":"string"}]}

User message:
${message}

User:
${JSON.stringify({ userId, now: new Date().toISOString() })}

Retrieved Quickslot context:
${JSON.stringify({
  ...ragContext,
  requestIntent: {
    vehicleType: requestedVehicleType,
    durationHours: requestedDurationHours,
    preferredLocation: requestedPreferredLocation,
    budgetAmount: requestedBudgetAmount,
  },
  compatibleAvailableSlots: intentCompatibleSlots.slice(0, 25),
  requestedBudgetAmount,
  requestedDurationHours,
  relevantLocationDemand: getRelevantLocationDemand({
    locationDemand: ragContext.locationDemand,
    preferredLocation: requestedPreferredLocation,
  }),
  closestPriceOptions,
})}`,
    });

    const availableSlotIds = new Set(intentCompatibleSlots.map((slot) => slot.slotId));
    const requestedRecommendation = String(result.recommendedSlotId || "").trim();
    const recommendedSlotId = availableSlotIds.has(requestedRecommendation) ? requestedRecommendation : null;
    const confidence = Math.min(1, Math.max(0, Number(result.confidence) || 0));
    const allowedNextActions = new Set([
      "ASK_DETAILS",
      "SUGGEST_SLOT",
      "PROCEED_TO_PAYMENT",
      "NO_SLOT_AVAILABLE",
      "ANSWER_ONLY",
    ]);
    const requestedNextAction = String(result.nextAction || "").trim();
    const nextAction = allowedNextActions.has(requestedNextAction) ? requestedNextAction : "ANSWER_ONLY";
    const modelTriedInvalidSlot = requestedRecommendation && !recommendedSlotId;
    const closestPriceResultFallback = closestPriceOptions.map((slot) => ({
      slotId: slot.slotId,
      location: slot.location,
      totalPrice: slot.totalPrice,
      reason:
        requestedBudgetAmount == null
          ? "Closest currently available option."
          : `Closest available option to Rs ${requestedBudgetAmount}.`,
    }));
    const knownClosestSlots = new Set(closestPriceOptions.map((slot) => slot.slotId));
    const modelNearestResults = Array.isArray(result.nearestResults)
      ? result.nearestResults
          .filter((slot) => knownClosestSlots.has(slot.slotId) || availableSlotIds.has(slot.slotId))
          .map((slot) => ({
            slotId: slot.slotId,
            location: normalizeLocation(slot.location),
            totalPrice: Number(slot.totalPrice) || 0,
            reason: String(slot.reason || "Closest currently available option."),
          }))
      : [];
    const nearestResults = modelNearestResults.length ? modelNearestResults : closestPriceResultFallback;
    const closestText = nearestResults
      .map((slot) => `${slot.slotId} at Rs ${slot.totalPrice}`)
      .join(", ");
    const unavailableReply =
      result.refusalReason ||
      (modelTriedInvalidSlot ? result.reason : "") ||
      (requestedBudgetAmount == null
        ? "I cannot recommend a slot from the current Quickslot data for that request."
        : `We do not have an available slot within Rs ${requestedBudgetAmount}.${
            closestText ? ` Closest available option(s): ${closestText}.` : ""
          }`);

    return {
      ...result,
      recommendedSlotId,
      confidence: recommendedSlotId ? confidence : 0,
      nextAction: recommendedSlotId ? nextAction : modelTriedInvalidSlot ? "NO_SLOT_AVAILABLE" : nextAction,
      reply: recommendedSlotId || !modelTriedInvalidSlot ? result.reply : unavailableReply,
      reason: recommendedSlotId || !modelTriedInvalidSlot ? result.reason : unavailableReply,
      refusalReason: recommendedSlotId ? "" : result.refusalReason || (modelTriedInvalidSlot ? unavailableReply : ""),
      nearestResults,
      aiProvider: "BEDROCK_NOVA",
      retrievedContext: {
        availableSlots: ragContext.availableSlots,
        bookingHistoryRecords: ragContext.recentBookings.length,
        nearestResults,
        closestPriceOptions,
        locationDemand: ragContext.locationDemand.slice(0, 5),
      },
    };
  } catch (error) {
    console.error("Bedrock assistant chat fallback used:", error.response?.data || error.message);
    const fallback = getFallbackAssistantChat({ message, slots, bookings, userId });
    return { ...fallback, aiError: "Bedrock unavailable or returned invalid JSON" };
  }
};

module.exports = {
  getAssistantChatResponse,
  getAssistantOptions,
  getAssistantRecommendation,
};
