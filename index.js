const WebSocket = require("ws");
const express = require("express");
const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { selectQuery, insertQuery, updateQuery, deleteQuery } = require('./db');
const twilio = require('twilio');

require("dotenv").config();

// Include Google Speech to Text and Text-to-Speech
const speech = require("@google-cloud/speech");
const textToSpeech = require("@google-cloud/text-to-speech");
const client = new speech.SpeechClient();
const ttsClient = new textToSpeech.TextToSpeechClient();
const twilioClient = new twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// OpenAI API Setup with multiple keys for load balancing
const { OpenAI } = require("openai");
const openAIKeys = [
  process.env.OPENAI_API_KEY, 
  process.env.OPENAI_API_KEY_BACKUP // Add backup key if available
].filter(Boolean); // Filter out undefined keys

let keyIndex = 0;
function getOpenAIClient() {
  const key = openAIKeys[keyIndex % openAIKeys.length];
  keyIndex++;
  return new OpenAI({ apiKey: key });
}

// Response cache to avoid redundant API calls
const responseCache = new Map();
const CACHE_TTL = 3600000; // 1 hour cache lifetime

// Configure Transcription Request - use phone_call model for better results
const request = {
  config: {
    encoding: "MULAW",
    sampleRateHertz: 8000,
    languageCode: "en-GB",
    model: "phone_call",
    useEnhanced: true, // Use enhanced model for better transcription
  },
  interimResults: true, // Enable interim results for faster processing
};

// Common role patterns for quick extraction without API calls
const rolePatterns = [
  { regex: /doctor|physician|md|surgeon|cardiologist/i, role: "Doctor" },
  { regex: /nurse|rn|lpn/i, role: "Nurse" },
  { regex: /admin|administrator|staff/i, role: "Administrator" },
  { regex: /technician|tech|laboratory/i, role: "Technician" },
  { regex: /patient|client/i, role: "Patient" },
];

// Function to quickly extract role without API call
function extractRoleFromText(text) {
  for (const pattern of rolePatterns) {
    if (pattern.regex.test(text)) {
      return pattern.role;
    }
  }
  return null; // Return null if no pattern matches
}

// Function to map any model version to base model name
function getBaseModelName(model) {
  if (model.startsWith("gpt-3.5-turbo")) {
    return "gpt-3.5-turbo";
  } else if (model.startsWith("gpt-4")) {
    return "gpt-4";
  }
  return model;
}

// Optimized pricing function
function Price(model) {
  const baseModel = getBaseModelName(model);
  const pricing = {
    'gpt-3.5-turbo': {
      'prompt': 0.001,
      'completion': 0.002,
    },
    'gpt-4': {
      'prompt': 0.03,
      'completion': 0.06,
    }
  };
  return pricing[baseModel] || pricing['gpt-3.5-turbo']; 
}

// New function to check if a call is still active
async function isCallActive(callSid) {
  try {
    const call = await twilioClient.calls(callSid).fetch();
    return ['queued', 'ringing', 'in-progress'].includes(call.status);
  } catch (error) {
    console.error("Error checking call status:", error);
    return false;
  }
}

// New function to update a call only if it's still active
async function updateCallIfActive(callSid, twiml) {
  if (await isCallActive(callSid)) {
    try {
      await twilioClient.calls(callSid).update({ twiml });
      console.log("Call updated successfully");
      return true;
    } catch (err) {
      console.error("Error updating call:", err);
      return false;
    }
  } else {
    console.log(`Call ${callSid} is no longer active, skipping update`);
    return false;
  }
}

// Call OpenAI with timeout to prevent hanging
async function callOpenAIWithTimeout(prompt, model = "gpt-3.5-turbo", timeout = 5000) {
  const openai = getOpenAIClient();
  
  // Create a cache key based on the prompt and model
  const cacheKey = `${model}:${prompt.slice(0, 100)}`;
  
  // Check cache
  if (responseCache.has(cacheKey)) {
    console.log("Using cached response");
    return responseCache.get(cacheKey);
  }
  
  // Set up timeout promise
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error('OpenAI API timeout')), timeout)
  );
  
  try {
    // Race the API call against the timeout
    const response = await Promise.race([
      openai.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 150, // Limit token usage for faster responses
      }),
      timeoutPromise
    ]);
    
    // Cache the response
    responseCache.set(cacheKey, response);
    
    // Set cache expiration
    setTimeout(() => responseCache.delete(cacheKey), CACHE_TTL);
    
    return response;
  } catch (error) {
    console.error("OpenAI API error:", error.message);
    
    // Return a fallback response
    return {
      choices: [{ message: { content: "I'm processing your request. Could you please repeat that?" } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      model
    };
  }
}

// Timer and Pause Detection Variables
let lastAudioReceivedTime = Date.now();
const PAUSE_THRESHOLD = 2000; // 2 seconds pause threshold
let recognizeStream = null;

// Store partial transcriptions for faster processing
let currentTranscription = "";
let processingTranscription = false;

wss.on("connection", function connection(ws) {
  console.log("New Connection Initiated");

  let callSid1 = null;
  let callDetails = null;
  
  ws.on("message", async function incoming(message) {
    const msg = JSON.parse(message);

    switch (msg.event) {
      case "connected":
        console.log(`A new call has connected.`);
        break;

      case "start":
        callSid1 = msg.start.callSid;
        console.log(`Starting media stream for call: ${callSid1}`);
        
        // Fetch call details - do this once and store for later use
        try {
          const result = await selectQuery('SELECT * FROM calls WHERE unique_identifier = ?', [callSid1]);
          if (result.length > 0) {
            callDetails = result[0];
            console.log(`Call details loaded: ${JSON.stringify(callDetails)}`);
          }
        } catch (err) {
          console.error('Error fetching call details:', err);
        }

        // Update start time immediately
        const start_time = new Date();
        updateQuery('UPDATE calls SET start_time = ? WHERE unique_identifier = ?', [start_time, callSid1])
          .catch(err => console.error('Error updating start time:', err));

        recognizeStream = client.streamingRecognize(request)
          .on("error", console.error)
          .on("data", async (data) => {
            // Skip if we're already processing
            if (processingTranscription) return;
            
            // Handle interim results for faster response preparation
            if (data.results[0]) {
              const transcription = data.results[0].alternatives[0].transcript;
              
              // Store the transcription
              currentTranscription = transcription;
              
              // Only process final results
              if (data.results[0].isFinal) {
                processingTranscription = true;
                
                console.log("Final Transcribed Text:", transcription);
                
                try {
                  // Calculate audio duration and costs
                  const audioDurationInSeconds = data.results[0].resultEndTime.seconds || 1;
                  const googleCharge = (audioDurationInSeconds / 60) * 0.006;
                  
                  // Process the transcribed text with OpenAI - use a faster model for short texts
                  const model = "gpt-3.5-turbo";
                  
                  // Check if call is still active before sending acknowledgment
                  if (await isCallActive(callSid1)) {
                    // Send immediate acknowledgment to keep the call responsive
                    await updateCallIfActive(callSid1, `<Response><Say>Processing your request...</Say><Gather input="speech" timeout="1" /></Response>`);
                  } else {
                    console.log(`Call ${callSid1} is no longer active, skipping processing`);
                    processingTranscription = false;
                    return;
                  }
                  
                  // Enhance prompt with call context for better responses
                  let prompt = `Please help with this issue: ${transcription}`;
                  if (callDetails) {
                    prompt = `User ${callDetails.caller_name} is a ${callDetails.caller_role} from ${callDetails.caller_department}. 
                              They are reporting this issue: ${transcription}. 
                              Their original issue was: ${callDetails.caller_issue}.
                              Please provide a helpful, concise response.`;
                  }
                  
                  // Call OpenAI with timeout
                  const openAIResponse = await callOpenAIWithTimeout(prompt, model);
                  const aiResponse = openAIResponse.choices[0].message.content;
                  
                  // Calculate costs
                  const usage = openAIResponse.usage;
                  const modelPricing = Price(model);
                  const promptCost = usage.prompt_tokens * modelPricing.prompt / 1000;
                  const completionCost = usage.completion_tokens * modelPricing.completion / 1000;
                  const totalCost = promptCost + completionCost;
                  const totalCharge = totalCost.toFixed(6);
                  const totalTokens = usage.total_tokens;
                  
                  // Insert AI response details into database - do this asynchronously
                  insertQuery('INSERT INTO charges (calls_id, ai_charge, ai_balance_amount, ai_tokens_used, transcript, created_at, prompt_charges, completion_charges, prompt_Token, completion_Token, ai_model, prompt, google_stt_charge, google_audio_duration, ai_model_ui) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 
                    [callSid1, totalCharge, 0, totalTokens, aiResponse, new Date(), promptCost, completionCost, usage.prompt_tokens, usage.completion_tokens, model, transcription, googleCharge.toFixed(6), audioDurationInSeconds, 'Phone']
                  ).catch(err => console.error('Error inserting AI charge details:', err));
                  
                  // Format response for better TTS readability
                  const formattedResponse = aiResponse.replace(/\n+/g, ' ').replace(/\s+/g, ' ');
                  
                  // Respond to the caller with the AI response only if call is still active
                  await updateCallIfActive(callSid1, `<Response><Say>${formattedResponse}</Say><Gather input="speech" timeout="5" /></Response>`);
                } catch (error) {
                  console.error("Error processing transcription:", error);
                  
                  // Fallback response in case of error
                  await updateCallIfActive(callSid1, `<Response><Say>I'm sorry, I'm having trouble processing that. Could you please try again?</Say><Gather input="speech" timeout="5" /></Response>`);
                } finally {
                  processingTranscription = false;
                  currentTranscription = "";
                }
              }
            }
          });
        break;

      case "media":
        if (recognizeStream) {
          recognizeStream.write(msg.media.payload);
          lastAudioReceivedTime = Date.now();
        }
        break;

      case "stop":
        console.log(`Call Has Ended: ${callSid1}`);
        updateQuery('UPDATE calls SET call_status = ?, end_time = ? WHERE unique_identifier = ?',
          ['ended', new Date(), callSid1]
        ).catch(err => console.error('Error updating call status:', err));
        
        if (recognizeStream) {
          recognizeStream.destroy();
        }
        break;
    }
  });
});

app.use(express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "/index.html")));

// Initial endpoint for incoming calls - optimized for speed
app.post("/incoming-call", (req, res) => {
  const callSid = req.body.CallSid; 
  const from_number = req.body.Called;
  const to_number = process.env.TWILIO_PHONE_NUMBER;
  
  // Insert initial call record asynchronously - don't wait for it
  insertQuery('INSERT INTO calls (unique_identifier, from_number, to_number, caller_name, caller_role, caller_department, caller_issue, call_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 
    [callSid, from_number, to_number, 'Not provided', 'Not provided', 'Not provided', 'Not provided', 'started', new Date()]
  )
  .catch(err => console.error('Error inserting call details:', err));

  // Respond immediately with a shorter greeting
  res.set("Content-Type", "text/xml");
  res.send(`
    <Response>
       <Say voice="alice">Hello and welcome to the Epic Clinical Help Desk. I'm your automated support assistant.</Say>
      <Gather input="speech" action="/process-details" method="POST" timeout="7">
        <Say voice="alice">Please provide Your name ,role and department.What is the issue you're experiencing and what is the severity of this issue ?</Say>
      </Gather>
      <Redirect>/process-details?CallSid=${callSid}</Redirect>
    </Response>
  `);
});

// New endpoint to process all details at once with optimizations
app.post("/process-details", async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || "";
  
  console.log(`Details collected: ${speechResult}`);
  
  // Send immediate acknowledgment response
  res.type('text/xml');
  res.send(`
    <Response>
      <Say>Thank you, I'm processing that information.</Say>
      <Pause length="1"/>
      <Redirect method="GET">/process-details-background?CallSid=${callSid}&amp;SpeechResult=${encodeURIComponent(speechResult)}</Redirect>
    </Response>
  `);
  
  // Continue processing in the background
});

// Background processing endpoint to avoid blocking the response
app.get("/process-details-background", async (req, res) => {
  const callSid = Array.isArray(req.query.CallSid) ? req.query.CallSid[0] : req.query.CallSid;
  console.log("callsid:", callSid);
  const speechResult = req.query.SpeechResult || "";
  
  // Check if call is still active
  if (!await isCallActive(callSid)) {
    console.log(`Call ${callSid} is no longer active, skipping processing`);
    res.type('text/xml');
    res.send('<Response></Response>');
    return;
  }
  
  try {
    // Quick check for role using regex patterns before calling OpenAI
    const quickRole = extractRoleFromText(speechResult);
    
    // Extract all details from speech result using OpenAI with a simplified prompt
    const prompt = `Extract from this text: name, role, department, and issue. Format as JSON with these fields. If any field is missing, set it to "Not provided": "${speechResult}"`;
    
    // Call OpenAI with a timeout to prevent hanging
    const response = await callOpenAIWithTimeout(prompt, "gpt-3.5-turbo");
    
    let extractedInfo;
    try {
      extractedInfo = JSON.parse(response.choices[0].message.content);
      
      // Use quick role detection if OpenAI couldn't find it
      if (extractedInfo.role === "Not provided" && quickRole) {
        extractedInfo.role = quickRole;
      }
    } catch (parseError) {
      console.error("Error parsing JSON response:", parseError);
      extractedInfo = {
        name: speechResult.match(/(?:name is|I am|I'm) ([A-Za-z]+)/) ? speechResult.match(/(?:name is|I am|I'm) ([A-Za-z]+)/)[1] : "Not provided",
        role: quickRole || "Not provided",
        department: speechResult.match(/(?:department|dept|from) ([A-Za-z]+)/) ? speechResult.match(/(?:department|dept|from) ([A-Za-z]+)/)[1] : "Not provided",
        issue: "Not provided"
      };
    }
    
    console.log("extracted :", extractedInfo);
    
    // Update database with extracted information asynchronously
    updateQuery('UPDATE calls SET caller_name = ?, caller_role = ?, caller_department = ?, caller_issue = ? WHERE unique_identifier = ?', 
      [extractedInfo.name, extractedInfo.role, extractedInfo.department, extractedInfo.issue, callSid])
      .catch(err => console.error('Error updating call details:', err));
    
    // Check if any required fields are missing
    const missingFields = [];
    if (extractedInfo.name === "Not provided") missingFields.push("name");
    if (extractedInfo.role === "Not provided") missingFields.push("role");
    if (extractedInfo.department === "Not provided") missingFields.push("department");
    if (extractedInfo.issue === "Not provided") missingFields.push("issue");
    
    // Get retry count from query params or set to 0
    const retryCount = parseInt(req.query.retryCount || '0');
    
    // If missing fields and under retry limit, ask for them
    if (missingFields.length > 0 && retryCount < 2) {
      const missingFieldsText = missingFields.join(", ");
      
      await updateCallIfActive(callSid, `
        <Response>
          <Say>I need more information about your ${missingFieldsText}.</Say>
          <Gather input="speech" action="/collect-missing-fields?missingFields=${encodeURIComponent(missingFieldsText)}&amp;retryCount=${retryCount + 1}" method="POST" timeout="7">
            <Say>Please tell me your ${missingFieldsText}.</Say>
          </Gather>
          <Redirect>/collect-missing-fields?CallSid=${callSid}&amp;missingFields=${encodeURIComponent(missingFieldsText)}&amp;retryCount=${retryCount + 1}</Redirect>
        </Response>
      `);
    } else {
      // If we have all fields or exceeded retries, start the conversation
      await updateCallIfActive(callSid, `
        <Response>
          <Say>Thank you for the information. Connecting you with our AI assistant now.</Say>
          <Start>
            <Stream url="wss://${req.headers.host}/"/>
          </Start>
          <Gather input="speech" timeout="30" />
        </Response>
      `);
    }
    
    // Send empty response since we've already handled the call via API
    res.type('text/xml');
    res.send('<Response></Response>');
  } catch (error) {
    console.error("Error in process-details-background:", error);
    
    await updateCallIfActive(callSid, `
      <Response>
        <Say>I'm sorry, there was an error processing your information. Let's try again.</Say>
        <Gather input="speech" action="/process-details" method="POST" timeout="15">
          <Say>Please tell me your name, role, department, and the issue you're facing.</Say>
        </Gather>
      </Response>
    `);
      
    res.type('text/xml');
    res.send('<Response></Response>');
  }
});

// Optimized endpoint to collect missing fields
app.post("/collect-missing-fields", async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || "";
  const missingFields = req.query.missingFields || "";
  const retryCount = parseInt(req.query.retryCount || '0');
  
  console.log(`Collecting missing fields: ${missingFields}`);
  console.log(`Speech result: ${speechResult}`);
  
  // Send immediate acknowledgment
  res.type('text/xml');
  res.send(`
    <Response>
      <Say>Thank you, processing that information.</Say>
      <Redirect method="GET">/collect-missing-background?CallSid=${callSid}&amp;SpeechResult=${encodeURIComponent(speechResult)}&amp;missingFields=${encodeURIComponent(missingFields)}&amp;retryCount=${retryCount}</Redirect>
    </Response>
  `);
});

// Background processing for collecting missing fields
app.get("/collect-missing-background", async (req, res) => {
  const callSid = Array.isArray(req.query.CallSid) ? req.query.CallSid[0] : req.query.CallSid;
  const speechResult = req.query.SpeechResult || "";
  const missingFields = req.query.missingFields || "";
  const retryCount = parseInt(req.query.retryCount || '0');
  
  // Check if call is still active
  if (!await isCallActive(callSid)) {
    console.log(`Call ${callSid} is no longer active, skipping processing`);
    res.type('text/xml');
    res.send('<Response></Response>');
    return;
  }
  
  try {
    // Quick check for role using regex patterns
    const quickRole = missingFields.includes("role") ? extractRoleFromText(speechResult) : null;
    
    // Simplified prompt focused only on missing fields
    const prompt = `Extract ${missingFields} from: "${speechResult}". Return JSON with keys: ${missingFields}`;
    
    // Call OpenAI with timeout
    const response = await callOpenAIWithTimeout(prompt, "gpt-3.5-turbo", 3000);
    
    let extractedInfo;
    try {
      extractedInfo = JSON.parse(response.choices[0].message.content);
      
      // Use quick role detection if OpenAI couldn't find it
      if (extractedInfo.role === "Not provided" && quickRole) {
        extractedInfo.role = quickRole;
      }
    } catch (parseError) {
      console.error("Error parsing JSON:", parseError);
      extractedInfo = {};
      missingFields.split(", ").forEach(field => {
        if (field === "role" && quickRole) {
          extractedInfo[field] = quickRole;
        } else {
          extractedInfo[field] = "Not provided";
        }
      });
    }
    
    // Prepare SQL update
    let sqlFields = [];
    let sqlValues = [];
    
    missingFields.split(", ").forEach(field => {
      if (extractedInfo[field] && extractedInfo[field] !== "Not provided") {
        const fieldMap = {
          name: "caller_name",
          role: "caller_role",
          department: "caller_department",
          issue: "caller_issue"
        };
        
        sqlFields.push(`${fieldMap[field]} = ?`);
        sqlValues.push(extractedInfo[field]);
      }
    });
    
    // Update database if we have values
    if (sqlFields.length > 0) {
      sqlValues.push(callSid);
      const sqlQuery = `UPDATE calls SET ${sqlFields.join(", ")} WHERE unique_identifier = ?`;
      
      try {
        await updateQuery(sqlQuery, sqlValues);
      } catch (dbError) {
        console.error('Database update error:', dbError);
      }
    }
    
    // Check if any fields are still missing
    const stillMissingFields = [];
    missingFields.split(", ").forEach(field => {
      if (!extractedInfo[field] || extractedInfo[field] === "Not provided") {
        stillMissingFields.push(field);
      }
    });
    
    // If we've tried too many times, just move on
    if (stillMissingFields.length > 0 && retryCount < 2) {
      const stillMissingFieldsText = stillMissingFields.join(", ");
      
      await updateCallIfActive(callSid, `
        <Response>
          <Say>I still need your ${stillMissingFieldsText}.</Say>
          <Gather input="speech" action="/collect-missing-fields?missingFields=${encodeURIComponent(stillMissingFieldsText)}&amp;retryCount=${retryCount + 1}" method="POST" timeout="10">
            <Say>Please clearly tell me your ${stillMissingFieldsText}.</Say>
          </Gather>
          <Redirect>/collect-missing-fields?CallSid=${callSid}&amp;missingFields=${encodeURIComponent(stillMissingFieldsText)}&amp;retryCount=${retryCount + 1}</Redirect>
        </Response>
      `);
    } else {
      // Use Unknown for any still missing fields
      if (stillMissingFields.length > 0) {
        const updateFields = {};
        stillMissingFields.forEach(field => {
          const fieldMap = {
            name: "caller_name",
            role: "caller_role",
            department: "caller_department",
            issue: "caller_issue"
          };
          updateFields[fieldMap[field]] = "Unknown";
        });
        
        const setClause = Object.keys(updateFields).map(key => `${key} = ?`).join(", ");
        const updateValues = [...Object.values(updateFields), callSid];
        
        try {
          await updateQuery(`UPDATE calls SET ${setClause} WHERE unique_identifier = ?`, updateValues);
        } catch (dbError) {
          console.error('Error updating missing fields with Unknown:', dbError);
        }
      }
      
      // Start the conversation
      await updateCallIfActive(callSid, `
        <Response>
          <Say>Thank you. I'll connect you with our AI assistant now.</Say>
          <Start>
            <Stream url="wss://${req.headers.host}/"/>
          </Start>
          <Gather input="speech" timeout="30" />
        </Response>
      `);
    }
    
    res.type('text/xml');
    res.send('<Response></Response>');
  } catch (error) {
    console.error("Error in collect-missing-background:", error);
    
    // If there's an error, just move on with the conversation
    await updateCallIfActive(callSid, `
      <Response>
        <Say>I'm having trouble with that information, but let's move forward. I'll connect you with our AI assistant now.</Say>
        <Start>
          <Stream url="wss://${req.headers.host}/"/>
        </Start>
        <Gather input="speech" timeout="30" />
      </Response>
    `);
      
    res.type('text/xml');
    res.send('<Response></Response>');
  }
});

// Fallback route for collection endpoint
app.get("/process-details", async (req, res) => {
  const callSid = Array.isArray(req.query.CallSid) ? req.query.CallSid[0] : req.query.CallSid;
  
  // Check if call is still active before responding
  if (!await isCallActive(callSid)) {
    console.log(`Call ${callSid} is no longer active, skipping fallback`);
    res.type('text/xml');
    res.send('<Response></Response>');
    return;
  }
  
  res.type('text/xml');
  res.send(`
    <Response>
      <Gather input="speech" action="/process-details" method="POST" timeout="15">
        <Say>Please tell me your name, role, department, and the issue you're facing.</Say>
      </Gather>
    </Response>
  `);
});

app.get("/collect-missing-fields", async (req, res) => {
  const callSid = Array.isArray(req.query.CallSid) ? req.query.CallSid[0] : req.query.CallSid;
  const missingFields = req.query.missingFields || "";
  
  // Check if call is still active before responding
  if (!await isCallActive(callSid)) {
    console.log(`Call ${callSid} is no longer active, skipping fallback`);
    res.type('text/xml');
    res.send('<Response></Response>');
    return;
  }
  
  res.type('text/xml');
  res.send(`
    <Response>
      <Gather input="speech" action="/collect-missing-fields?missingFields=${encodeURIComponent(missingFields)}" method="POST" timeout="10">
        <Say>Please tell me your ${missingFields}.</Say>
      </Gather>
    </Response>
  `);
});

// Initialize by warming up API connections
async function initializeServices() {
  try {
    // Pre-warm OpenAI connection
    await callOpenAIWithTimeout("Hello", "gpt-3.5-turbo", 2000);
    console.log("OpenAI connection pre-warmed");
  } catch (error) {
    console.error("Error pre-warming connections:", error);
  }
}

// Start the server
console.log("Listening on Port 3000");
server.listen(3000, () => {
  initializeServices(); // Warm up connections on startup
});