const crypto = require("crypto");
const { SendMessageCommand, SQSClient } = require("@aws-sdk/client-sqs");

const client = new SQSClient({ region: process.env.AWS_REGION || "us-east-1" });
const sqsEnabled = () => String(process.env.SQS_ENABLED).toLowerCase() === "true";

const publishNotification = async (payload) => {
  if (!sqsEnabled() || !process.env.NOTIFICATION_QUEUE_URL) {
    return false;
  }

  const event = {
    eventId: crypto.randomUUID(),
    eventType: "notification.requested",
    environment: process.env.APP_ENV || "dev",
    timestamp: new Date().toISOString(),
    payload,
  };

  await client.send(new SendMessageCommand({
    QueueUrl: process.env.NOTIFICATION_QUEUE_URL,
    MessageBody: JSON.stringify(event),
  }));
  return true;
};

module.exports = { publishNotification };

