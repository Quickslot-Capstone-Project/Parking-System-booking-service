const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const tableName = process.env.BOOKING_TABLE || "smart-parking-bookings";
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const scanAll = async () => {
  const items = [];
  let ExclusiveStartKey;

  do {
    const response = await client.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey,
      })
    );
    items.push(...(response.Items || []));
    ExclusiveStartKey = response.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return items;
};

const sortNewest = (items) =>
  [...items].sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));

const createBooking = async (booking) => {
  const now = new Date().toISOString();
  const item = {
    ...booking,
    timestamp: booking.timestamp || now,
    expiresAt: booking.expiresAt,
    createdAt: now,
    updatedAt: now,
  };

  await client.send(
    new PutCommand({
      TableName: tableName,
      Item: item,
      ConditionExpression: "attribute_not_exists(bookingId)",
    })
  );

  return item;
};

const deleteBooking = async (bookingId) => {
  await client.send(
    new DeleteCommand({
      TableName: tableName,
      Key: { bookingId },
    })
  );
};

const getBooking = async (bookingId) => {
  const response = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { bookingId },
    })
  );

  return response.Item || null;
};

const listBookings = async ({ userId, isAdmin }) => {
  const bookings = await scanAll();
  return sortNewest(isAdmin ? bookings : bookings.filter((booking) => booking.userId === userId));
};

const updateBooking = async (bookingId, fields) => {
  const values = { ...fields, updatedAt: new Date().toISOString() };
  const names = {};
  const expressionValues = {};
  const setExpressions = [];

  Object.entries(values).forEach(([key, value]) => {
    names[`#${key}`] = key;
    expressionValues[`:${key}`] = value;
    setExpressions.push(`#${key} = :${key}`);
  });

  const response = await client.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { bookingId },
      UpdateExpression: `SET ${setExpressions.join(", ")}`,
      ConditionExpression: "attribute_exists(bookingId)",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: expressionValues,
      ReturnValues: "ALL_NEW",
    })
  );

  return response.Attributes;
};

const findExpiredPendingBookings = async (nowIso) => {
  const response = await client.send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression: "#status = :status AND expiresAt <= :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":status": "pending", ":now": nowIso },
    })
  );

  return response.Items || [];
};

const findPendingBookings = async () => {
  const response = await client.send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression: "#status = :status",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":status": "pending" },
    })
  );

  return response.Items || [];
};

const repairZeroAmounts = async (fallbackAmount) => {
  const bookings = await scanAll();
  for (const booking of bookings) {
    const numericAmount = Number(booking.amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      await updateBooking(booking.bookingId, { amount: fallbackAmount });
    }
  }
};

module.exports = {
  createBooking,
  deleteBooking,
  findExpiredPendingBookings,
  findPendingBookings,
  getBooking,
  listBookings,
  repairZeroAmounts,
  updateBooking,
};
