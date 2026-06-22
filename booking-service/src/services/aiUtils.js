const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

const roundScore = (value) => Number(clamp(value).toFixed(2));

const parseDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const getHour = (value = new Date()) => {
  const date = value instanceof Date ? value : parseDate(value);
  return date ? date.getHours() : new Date().getHours();
};

const isPeakHour = (value = new Date()) => {
  const hour = getHour(value);
  return (hour >= 8 && hour <= 11) || (hour >= 17 && hour <= 21);
};

const hoursBetween = (start, end) => {
  const startDate = parseDate(start);
  const endDate = parseDate(end);
  if (!startDate || !endDate) {
    return null;
  }
  return Math.max(0, (endDate.getTime() - startDate.getTime()) / (60 * 60 * 1000));
};

const minutesBetween = (start, end) => {
  const startDate = parseDate(start);
  const endDate = parseDate(end);
  if (!startDate || !endDate) {
    return null;
  }
  return Math.max(0, (endDate.getTime() - startDate.getTime()) / (60 * 1000));
};

const average = (values) => {
  const numericValues = values.filter((value) => Number.isFinite(value));
  if (numericValues.length === 0) {
    return 0;
  }
  return numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length;
};

module.exports = {
  average,
  clamp,
  getHour,
  hoursBetween,
  isPeakHour,
  minutesBetween,
  parseDate,
  roundScore,
};
