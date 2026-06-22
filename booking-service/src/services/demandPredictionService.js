const { buildDemandFeatures, demandLevelFromScore } = require("./dynamoDemandFeatures");

const predictDemand = ({ slots = [], bookings, totalSlots, hours = 6, now = new Date() }) => {
  const demandFeatures = buildDemandFeatures({
    slots:
      slots.length > 0
        ? slots
        : Array.from({ length: totalSlots || 0 }, (_, index) => ({
            slotId: `unknown-${index + 1}`,
            location: "General",
            status: "available",
          })),
    bookings,
    now,
  });
  const predictions = [];
  const currentHour = now.getHours();
  const systemDemand =
    demandFeatures.locationDemand.reduce((sum, item) => sum + item.demandScore * Math.max(1, item.totalSlots), 0) /
    Math.max(1, demandFeatures.locationDemand.reduce((sum, item) => sum + Math.max(1, item.totalSlots), 0));

  for (let offset = 0; offset < hours; offset += 1) {
    const target = new Date(now);
    target.setHours(currentHour + offset, 0, 0, 0);
    const targetHour = target.getHours();
    const sameHourBookings = bookings.filter((booking) => {
      const date = new Date(booking.createdAt || booking.timestamp || booking.paidAt || 0);
      return !Number.isNaN(date.getTime()) && date.getHours() === targetHour;
    }).length;
    const sameHourPressure = sameHourBookings / Math.max(1, bookings.length);
    const projectedDemandScore = Math.min(1, systemDemand * 0.75 + sameHourPressure * 0.25);
    const predictedBookedSlots = Math.min(
      demandFeatures.totalSlots,
      Math.round(projectedDemandScore * Math.max(1, demandFeatures.totalSlots))
    );

    predictions.push({
      time: target.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false }),
      predictedBookedSlots,
      predictedAvailableSlots: Math.max(0, demandFeatures.totalSlots - predictedBookedSlots),
      demandLevel: demandLevelFromScore(projectedDemandScore),
      demandScore: Number(projectedDemandScore.toFixed(2)),
      basis: "dynamodb_slots_bookings_features",
    });
  }

  return predictions;
};

module.exports = {
  predictDemand,
};
