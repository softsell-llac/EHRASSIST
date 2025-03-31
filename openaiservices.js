const { OpenAI } = require('openai');
require("dotenv").config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Function to extract the name, role, department, and issue from the transcribed text
async function extractDetails(transcribedText) {
  const extractionPrompt = `Extract the name, role, department, and issue from the following text: "${transcribedText}"`;

  const extractionResponse = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [{ role: "user", content: extractionPrompt }],
  });

  const extractedData = extractionResponse.choices[0].message.content;
  const [name, role, department, issue] = extractedData.split(", ");
  
  return {
    name,
    role,
    department,
    issue,
    usage: extractionResponse.usage,
    model: extractionResponse.model,
  };
}

// Function to get a generic AI response from OpenAI
async function getAIResponse(transcribedText) {
  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [{ role: "user", content: transcribedText }],
  });

  return {
    aiResponse: response.choices[0].message.content,
    usage: response.usage,
    model: response.model,
  };
}

module.exports = { extractDetails, getAIResponse };
