const { OpenAI } = require("openai");
require("dotenv").config();

const openAIKeys = [
  process.env.OPENAI_API_KEY,
 // process.env.OPENAI_API_KEY_BACKUP,
].filter(Boolean);

const responseCache = new Map();
const CACHE_TTL = 3600000;

let keyIndex = 0;
function getOpenAIClient() {
  const key = openAIKeys[keyIndex % openAIKeys.length];
  keyIndex++;
  return new OpenAI({ apiKey: key });
}

function getBaseModelName(model) {
  if (model.startsWith("gpt-3.5-turbo")) {
    return "gpt-3.5-turbo";
  } else if (model.startsWith("gpt-4")) {
    return "gpt-4";
  }
  return model;
}

function Price(model) {
  const baseModel = getBaseModelName(model);
  const pricing = {
    "gpt-3.5-turbo": { prompt: 0.001, completion: 0.002 },
    "gpt-4": { prompt: 0.03, completion: 0.06 },
  };
  return pricing[baseModel] || pricing["gpt-3.5-turbo"];
}

async function callOpenAIWithTimeout(prompt, model = "gpt-3.5-turbo", timeout = 5000) {
  //console.log("prompt",prompt);
  const openai = getOpenAIClient();
  const cacheKey = `${model}:${prompt.slice(0, 100)}`;
  if (responseCache.has(cacheKey)) {
    console.log("Using cached response");
    return responseCache.get(cacheKey);
  }
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("OpenAI API timeout")), timeout)
  );
  try {
    const response = await Promise.race([
      openai.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 150,
      }),
      timeoutPromise,
    ]);
    responseCache.set(cacheKey, response);
    setTimeout(() => responseCache.delete(cacheKey), CACHE_TTL);
    return response;
  } catch (error) {
    console.error("OpenAI API error:", error.message);
    return {
      choices: [{ message: { content: "I'm processing your request. Could you please repeat that?" } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      model,
    };
  }
}

const rolePatterns = [
  { regex: /doctor|physician|md|surgeon|cardiologist/i, role: "Doctor" },
  { regex: /nurse|rn|lpn/i, role: "Nurse" },
  { regex: /admin|administrator|staff/i, role: "Administrator" },
  { regex: /technician|tech|laboratory/i, role: "Technician" },
  { regex: /patient|client/i, role: "Patient" },
];

function extractRoleFromText(text) {
  for (const pattern of rolePatterns) {
    if (pattern.regex.test(text)) {
      return pattern.role;
    }
  }
  return null;
}

async function initializeServices() {
  try {
    await callOpenAIWithTimeout("Hello", "gpt-3.5-turbo", 2000);
    console.log("OpenAI connection pre-warmed");
  } catch (error) {
    console.error("Error pre-warming connections:", error);
  }
}

module.exports = {
  callOpenAIWithTimeout,
  Price,
  extractRoleFromText,
  initializeServices,
};
