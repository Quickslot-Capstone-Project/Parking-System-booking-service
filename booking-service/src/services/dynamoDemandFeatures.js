const { getHour, parseDate, roundScore } = require("./aiUtils");

const ACTIVE_STATUSES = new Set(["pending", "confirmed"]);
const COMPLETED_STATUSES = new Set(["confirmed", "expired", "cancelled"]);

const normalizeLocation = (location) => String(location || "General").trim() || "General";

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

const demandLevelFromScore = (score) => {
  if (score >= 0.67) {
    return "HIGH";
  }
  if (score >= 0.34) {
    return "MEDIUM";
  }
  return "LOW";
};

const bookingHour = (booking) => {
  const date = parseDate(booking.createdAt || booking.timestamp || booking.paidAt);
  return date ? getHour(date) : null;
};

const getSlotLocationMap = (slots) => {
  const map = new Map();
  slots.forEach((slot) => {
    if (slot.slotId) {
      map.set(slot.slotId, normalizeLocation(slot.location));
    }
  });
  return map;
};

const buildDemandFeatures = ({ slots, bookings, now = new Date() }) => {
  const slotLocationMap = getSlotLocationMap(slots);
  const totalBookings = bookings.length;
  const currentHour = getHour(now);
  const locations = new Map();

  slots.forEach((slot) => {
    const location = normalizeLocation(slot.location);
    if (!locations.has(location)) {
      locations.set(location, {
        location,
        totalSlots: 0,
        availableSlots: 0,
        reservedSlots: 0,
        occupiedSlots: 0,
        blockedSlots: 0,
        activeBookings: 0,
        historicalBookings: 0,
        sameHourHistoricalBookings: 0,
        cancelledOrExpiredBookings: 0,
        paidBookings: 0,
        totalRevenue: 0,
      });
    }

    const stats = locations.get(location);
    stats.totalSlots += 1;
    if (slot.status === "available") stats.availableSlots += 1;
    if (slot.status === "reserved") stats.reservedSlots += 1;
    if (slot.status === "occupied") stats.occupiedSlots += 1;
    if (slot.status === "blocked") stats.blockedSlots += 1;
  });

  bookings.forEach((booking) => {
    const location = slotLocationMap.get(booking.slotId) || normalizeLocation(booking.location);
    if (!locations.has(location)) {
      locations.set(location, {
        location,
        totalSlots: 0,
        availableSlots: 0,
        reservedSlots: 0,
        occupiedSlots: 0,
        blockedSlots: 0,
        activeBookings: 0,
        historicalBookings: 0,
        sameHourHistoricalBookings: 0,
        cancelledOrExpiredBookings: 0,
        paidBookings: 0,
        totalRevenue: 0,
      });
    }

    const stats = locations.get(location);
    const status = String(booking.status || "").toLowerCase();
    if (ACTIVE_STATUSES.has(status)) stats.activeBookings += 1;
    if (COMPLETED_STATUSES.has(status)) stats.historicalBookings += 1;
    if (bookingHour(booking) === currentHour) stats.sameHourHistoricalBookings += 1;
    if (["cancelled", "expired"].includes(status)) stats.cancelledOrExpiredBookings += 1;
    if (booking.paidAt || status === "confirmed") stats.paidBookings += 1;
    stats.totalRevenue += Number(booking.amount) || 0;
  });

  const maxHistorical = Math.max(1, ...Array.from(locations.values()).map((item) => item.historicalBookings));
  const maxSameHour = Math.max(1, ...Array.from(locations.values()).map((item) => item.sameHourHistoricalBookings));

  const locationDemand = Array.from(locations.values())
    .map((stats) => {
      const availabilityRatio = stats.totalSlots > 0 ? stats.availableSlots / stats.totalSlots : 0;
      const activeSlotPressure =
        stats.totalSlots > 0 ? (stats.reservedSlots + stats.occupiedSlots + stats.activeBookings) / stats.totalSlots : 0;
      const historicalPressure = stats.historicalBookings / maxHistorical;
      const sameHourPressure = stats.sameHourHistoricalBookings / maxSameHour;
      const failurePressure =
        stats.historicalBookings > 0 ? stats.cancelledOrExpiredBookings / stats.historicalBookings : 0;
      const paidRatio = stats.historicalBookings > 0 ? stats.paidBookings / stats.historicalBookings : 0;

      const demandScore = roundScore(
        clamp(
          activeSlotPressure * 0.38 +
            historicalPressure * 0.24 +
            sameHourPressure * 0.18 +
            (1 - availabilityRatio) * 0.14 +
            failurePressure * 0.06
        )
      );

      return {
        ...stats,
        availabilityRatio: roundScore(availabilityRatio),
        activeSlotPressure: roundScore(clamp(activeSlotPressure)),
        historicalPressure: roundScore(historicalPressure),
        sameHourPressure: roundScore(sameHourPressure),
        cancellationExpiryPressure: roundScore(failurePressure),
        paidRatio: roundScore(paidRatio),
        averageRevenuePerBooking: stats.historicalBookings
          ? Math.round((stats.totalRevenue / stats.historicalBookings) * 100) / 100
          : 0,
        demandScore,
        demandLevel: demandLevelFromScore(demandScore),
      };
    })
    .sort((left, right) => right.demandScore - left.demandScore || left.location.localeCompare(right.location));

  return {
    generatedAt: now.toISOString(),
    source: "DynamoDB slots and bookings tables only",
    currentHour,
    totalSlots: slots.length,
    availableSlots: slots.filter((slot) => slot.status === "available").length,
    totalBookings,
    activeBookings: bookings.filter((booking) => ACTIVE_STATUSES.has(String(booking.status || "").toLowerCase())).length,
    locationDemand,
  };
};

module.exports = {
  buildDemandFeatures,
  demandLevelFromScore,
  normalizeLocation,
};
