const { BedrockRuntimeClient, ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");
const { InvokeCommand, LambdaClient } = require("@aws-sdk/client-lambda");

const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-east-1";
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || "amazon.nova-pro-v1:0";
const AI_ASSISTANT_LAMBDA_NAME = process.env.AI_ASSISTANT_LAMBDA_NAME || "";

const client = new BedrockRuntimeClient({ region: BEDROCK_REGION });
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || "us-east-1" });

const isBedrockEnabled = () => Boolean(BEDROCK_MODEL_ID);

const getResponseText = (response) =>
  response?.output?.message?.content
    ?.map((part) => part.text || "")
    .join("")
    .trim() || "";

const parseJsonText = (text) => {
  if (!text) {
    throw new Error("Bedrock returned an empty response");
  }

  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const firstBracket = cleaned.indexOf("[");
  const startsAt =
    firstBrace === -1 ? firstBracket : firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket);

  if (startsAt < 0) {
    throw new Error("Bedrock response did not contain JSON");
  }

  return JSON.parse(cleaned.slice(startsAt));
};

const generateTextDirect = async ({ prompt, temperature, maxTokens }) => {
  const response = await client.send(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      messages: [
        {
          role: "user",
          content: [{ text: prompt }],
        },
      ],
      inferenceConfig: {
        maxTokens,
        temperature,
      },
    })
  );

  return getResponseText(response);
};

const generateTextWithLambda = async ({ prompt, temperature, maxTokens }) => {
  const response = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: AI_ASSISTANT_LAMBDA_NAME,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({ prompt, temperature, maxTokens })),
    })
  );

  const payload = JSON.parse(Buffer.from(response.Payload || []).toString("utf8") || "{}");
  if (response.FunctionError) {
    throw new Error(payload.errorMessage || `AI assistant Lambda failed: ${response.FunctionError}`);
  }
  if (!payload.text) {
    throw new Error("AI assistant Lambda returned an empty response");
  }

  return payload.text;
};

const generateText = async ({ prompt, temperature = 0.25, maxTokens = 1200 }) => {
  if (!isBedrockEnabled()) {
    return null;
  }

  if (AI_ASSISTANT_LAMBDA_NAME) {
    try {
      return await generateTextWithLambda({ prompt, temperature, maxTokens });
    } catch (error) {
      // Preserve availability: if Lambda is unavailable, use the existing
      // direct Bedrock path with the context already assembled by the service.
      console.error("Grounded AI Lambda unavailable; using direct Bedrock fallback:", error.message);
    }
  }

  return generateTextDirect({ prompt, temperature, maxTokens });
};

const generateJson = async ({ prompt, temperature = 0.2, maxTokens = 1200 }) =>
  parseJsonText(await generateText({ prompt, temperature, maxTokens }));

module.exports = {
  BEDROCK_MODEL_ID,
  BEDROCK_REGION,
  AI_ASSISTANT_LAMBDA_NAME,
  generateJson,
  generateText,
  isBedrockEnabled,
};
