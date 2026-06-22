const axios = require("axios");

const internalHeaders = () => ({
  "x-internal-api-key": process.env.INTERNAL_API_KEY,
});

const parkingClient = axios.create({
  baseURL: process.env.PARKING_SERVICE_URL,
  timeout: 10000,
});

const notificationClient = axios.create({
  baseURL: process.env.NOTIFICATION_SERVICE_URL,
  timeout: 10000,
});

module.exports = { internalHeaders, notificationClient, parkingClient };

