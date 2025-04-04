const { OpenAI } = require("openai");
require("dotenv").config();

const openAIKeys = [
  process.env.OPENAI_API_KEY,
  // process.env.OPENAI_API_KEY_BACKUP,
].filter(Boolean);

const responseCache = new Map();
const CACHE_TTL = 3600000; // 1 hour cache
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

/**
 * Call OpenAI API with proper timeout handling
 * @param {string} prompt - The prompt to send to OpenAI
 * @param {string} model - The model to use (e.g., "gpt-3.5-turbo")
 * @param {number|boolean} timeoutSetting - Timeout in ms or false to disable timeout
 * @param {boolean} useCache - Whether to use cached responses
 * @returns {Promise<Object>} - OpenAI API response
 */
async function callOpenAIWithTimeout(prompt, model = "gpt-3.5-turbo", timeoutSetting = 15000, useCache = true) {
  const openai = getOpenAIClient();
  const cacheKey = `${model}:${prompt.slice(0, 100)}`;
  
  // Use cached response if available and cache is enabled
  // if (useCache && responseCache.has(cacheKey)) {
  //   console.log("Using cached response");
  //   return responseCache.get(cacheKey);
  // }
  
  try {
    // Handle timeout properly - if timeoutSetting is false, don't set a timeout
    let apiPromise = openai.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      // Increase max_tokens for more complex responses
      max_tokens: 500,
    });
    
    // Only race with timeout if timeout is enabled (not false)
    let response;
    if (timeoutSetting !== false && typeof timeoutSetting === 'number') {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`OpenAI API timeout after ${timeoutSetting}ms`)), timeoutSetting)
      );
      response = await Promise.race([apiPromise, timeoutPromise]);
    } else {
      // No timeout, just wait for the API call to complete
      response = await apiPromise;
    }
    
    // Cache successful responses
    if (useCache) {
      responseCache.set(cacheKey, response);
      setTimeout(() => responseCache.delete(cacheKey), CACHE_TTL);
    }
    
    return response;
  } catch (error) {
    console.error(`OpenAI API error (${model}):`, error.message);
    
    // Retry with a different key if available
    if (openAIKeys.length > 1 && error.message.includes('API key')) {
      console.log("Retrying with different API key");
      keyIndex++; // Move to next key
      return callOpenAIWithTimeout(prompt, model, timeoutSetting, useCache);
    }
    
    // Handle rate limits by throwing a specific error that can be caught
    if (error.message.includes('rate limit') || error.message.includes('429')) {
      throw new Error("OpenAI rate limit reached. Please try again in a moment.");
    }
    
    // Re-throw the error for proper handling upstream
    throw error;
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
    await callOpenAIWithTimeout("Hello", "gpt-3.5-turbo", 10000);
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