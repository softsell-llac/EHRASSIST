const express = require('express');
const router = express.Router();
const { insertQuery, updateQuery, selectQuery } = require('./db');
const { isCallActive, updateCallIfActive } = require('./twilioService');
const { callOpenAIWithTimeout } = require('./openaiService');

// Initial endpoint for incoming calls - first collecting name and department
router.post("/incoming-call", (req, res) => {
  const callSid = req.body.CallSid; 
  const from_number = req.body.Called;
  const to_number = process.env.TWILIO_PHONE_NUMBER;
  
  // Insert initial call record asynchronously - don't wait for it
  insertQuery('INSERT INTO calls (unique_identifier, from_number, to_number, caller_name, caller_department, caller_issue, severity, call_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 
    [callSid, from_number, to_number, 'Not provided', 'Not provided', 'Not provided', 'Not provided', 'started', new Date()]
  )
  .catch(err => console.error('Error inserting call details:', err));

  // Respond immediately with a greeting
  res.set("Content-Type", "text/xml");
  res.send(`
    <Response>
      <Say voice="Polly.Danielle-Generative">Hello and welcome to the Epic Clinical Help Desk. I'm your automated support assistant.</Say>
      <Gather input="speech" action="/process-basic-details" method="POST" timeout="7">
        <Say voice="Polly.Danielle-Generative">Please provide your name and department.</Say>
      </Gather>
      <Redirect method="POST">/process-basic-details-fallback?CallSid=${callSid}</Redirect>
    </Response>
  `);
});

// Process basic details (name and department)
router.post("/process-basic-details", async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || "";
  
  
  console.log(`Basic details collected: ${speechResult}`);
  
  try {
    // Extract name and department from speech result using OpenAI
    const prompt = `Extract the name and department from this text: "${speechResult}". Return only a JSON object with fields "name" and "department". Use "Not provided" for missing information.`;
    const model = "gpt-3.5-turbo";
    
    // Call OpenAI with a timeout to prevent hanging
    const response = await callOpenAIWithTimeout(prompt, model);
    
    // Calculate and store charges for this OpenAI call
    const usage = response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    
    // Cost rates (adjust these according to your actual rates)
    const promptRate = 0.0015 / 1000; // $0.0015 per 1K tokens
    const completionRate = 0.002 / 1000; // $0.002 per 1K tokens
    
    // Calculate costs
    const promptCost = usage.prompt_tokens * promptRate;
    const completionCost = usage.completion_tokens * completionRate;
    const totalCost = promptCost + completionCost;
    const totalTokens = usage.total_tokens || (usage.prompt_tokens + usage.completion_tokens);
    
    // Store charge information in database
    await insertQuery('INSERT INTO charges (calls_id, ai_charge, ai_balance_amount, ai_tokens_used, transcript, created_at, prompt_charges, completion_charges, prompt_Token, completion_Token, ai_model, prompt, google_stt_charge, google_audio_duration, ai_model_ui) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [callSid, totalCost, 0, totalTokens, response.choices[0].message.content, new Date(), promptCost, completionCost, usage.prompt_tokens, usage.completion_tokens, model, prompt, 0, 0, 'Phone']
    ).catch(err => console.error('Error inserting AI charge details:', err));
    
    let extractedInfo;
    try {
      let jsonStr = response.choices[0].message.content.trim();
      // Remove any potential non-JSON text before or after the JSON object
      jsonStr = jsonStr.replace(/^[^{]*/, '').replace(/[^}]*$/, '');
      extractedInfo = JSON.parse(jsonStr);
      console.log("extractedInfo from JSON:", extractedInfo);
    } catch (parseError) {
      console.error("Error parsing JSON response:", parseError);
      // Fallback extraction if JSON parsing fails
      extractedInfo = {
        name: speechResult.match(/(?:name is|I am|I'm) ([A-Za-z]+)/) ? speechResult.match(/(?:name is|I am|I'm) ([A-Za-z]+)/)[1] : "Not provided",
        department: speechResult.match(/(?:department|dept|from) ([A-Za-z]+)/) ? speechResult.match(/(?:department|dept|from) ([A-Za-z]+)/)[1] : "Not provided"
      };
    }
    
    // Ensure all fields exist with default values
    extractedInfo = {
      name: extractedInfo.name || "Not provided",
      department: extractedInfo.department || "Not provided"
    };
    
    console.log("Final extracted info:", extractedInfo);
    
    // Update database with extracted information
    await updateQuery('UPDATE calls SET caller_name = ?, caller_department = ? WHERE unique_identifier = ?', 
      [extractedInfo.name, extractedInfo.department, callSid])
      .then(() => console.log("Basic call details updated successfully"))
      .catch(err => console.error('Error updating basic call details:', err));
    
    // Continue to collect issue with TwiML response
    res.type('text/xml');
    res.send(`
      <Response>
        <Say voice="Polly.Danielle-Generative">Thank you. I've got that information.</Say>
        <Gather input="speech" action="/process-issue" method="POST" timeout="10">
          <Say voice="Polly.Danielle-Generative">Please describe the issue you're experiencing.</Say>
        </Gather>
        <Redirect method="POST">/process-issue-fallback?CallSid=${callSid}</Redirect>
      </Response>
    `);
    
  } catch (error) {
    console.error("Error in process-basic-details:", error);
    
    // Continue to collect issue even if there was an error
    res.type('text/xml');
    res.send(`
      <Response>
        <Say voice="Polly.Danielle-Generative">Thank you. Let's continue.</Say>
        <Gather input="speech" action="/process-issue" method="POST" timeout="10">
          <Say voice="Polly.Danielle-Generative">Please describe the issue you're experiencing.</Say>
        </Gather>
        <Redirect method="POST">/process-issue-fallback?CallSid=${callSid}</Redirect>
      </Response>
    `);
  }
});

// Fallback route if no speech is detected for basic details
router.post("/process-basic-details-fallback", async (req, res) => {
  const callSid = req.body.CallSid;
  
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
      <Say voice="Polly.Danielle-Generative">I didn't hear your response.</Say>
      <Gather input="speech" action="/process-basic-details" method="POST" timeout="10">
        <Say voice="Polly.Danielle-Generative">Please tell me your name and department.</Say>
      </Gather>
      <Redirect method="POST">/process-issue?CallSid=${callSid}</Redirect>
    </Response>
  `);
});

// Process issue separately
router.post("/process-issue", async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || "";
  
  console.log(`Issue details collected: ${speechResult}`);
  
  try {
    // Simply save the raw speech result as the issue
    await updateQuery('UPDATE calls SET caller_issue = ? WHERE unique_identifier = ?', 
      [speechResult, callSid])
      .then(() => console.log("Issue details updated successfully"))
      .catch(err => console.error('Error updating issue details:', err));
    
    // Now continue to collect severity separately
    res.type('text/xml');
    res.send(`
      <Response>
        <Say voice="Polly.Danielle-Generative">Thank you for describing your issue.</Say>
        <Gather input="speech" action="/process-severity" method="POST" timeout="7">
          <Say voice="Polly.Danielle-Generative">Please tell me the severity of this issue. Is it high, medium, or low?</Say>
        </Gather>
        <Redirect method="POST">/process-severity-fallback?CallSid=${callSid}</Redirect>
      </Response>
    `);
  } catch (error) {
    console.error("Error in process-issue:", error);
    
    // Continue to severity question even if there was an error
    res.type('text/xml');
    res.send(`
      <Response>
        <Say voice="Polly.Danielle-Generative">Thank you for that information.</Say>
        <Gather input="speech" action="/process-severity" method="POST" timeout="7">
          <Say voice="Polly.Danielle-Generative">Please tell me the severity of this issue. Is it high, medium, or low?</Say>
        </Gather>
        <Redirect method="POST">/process-severity-fallback?CallSid=${callSid}</Redirect>
      </Response>
    `);
  }
});

// Fallback route if no speech is detected for issue
router.post("/process-issue-fallback", async (req, res) => {
  const callSid = req.body.CallSid;
  
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
      <Say voice="Polly.Danielle-Generative">I didn't hear your response about the issue.</Say>
      <Gather input="speech" action="/process-issue" method="POST" timeout="10">
        <Say voice="Polly.Danielle-Generative">Please describe the issue you're experiencing.</Say>
      </Gather>
      <Redirect method="POST">/process-severity?CallSid=${callSid}</Redirect>
    </Response>
  `);
});

// Process severity separately
router.post("/process-severity", async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || "";
  
  console.log(`Severity details collected: ${speechResult}`);
  
  try {
    // Check if we want to use AI for severity classification
    const useAIForSeverity = true; // Set to true to use OpenAI for severity classification if open ai call is required then set as true else false
    
    let severity = "Medium"; // Default
    
    if (useAIForSeverity) {
      // Optional: Use OpenAI to classify severity with more nuance
      const prompt = `Classify the severity of this issue as either "High", "Medium", or "Low": "${speechResult}". Return only the severity level as a single word.`;
      const model = "gpt-3.5-turbo";
      
      const response = await callOpenAIWithTimeout(prompt, model);
      
      // Calculate and store charges for this OpenAI call
      const usage = response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      
      // Cost rates
      const promptRate = 0.0015 / 1000;
      const completionRate = 0.002 / 1000;
      
      // Calculate costs
      const promptCost = usage.prompt_tokens * promptRate;
      const completionCost = usage.completion_tokens * completionRate;
      const totalCost = promptCost + completionCost;
      const totalTokens = usage.total_tokens || (usage.prompt_tokens + usage.completion_tokens);
      
      // Store charge information in database
      await insertQuery('INSERT INTO charges (calls_id, ai_charge, ai_balance_amount, ai_tokens_used, transcript, created_at, prompt_charges, completion_charges, prompt_Token, completion_Token, ai_model, prompt, google_stt_charge, google_audio_duration, ai_model_ui) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [callSid, totalCost, 0, totalTokens, response.choices[0].message.content, new Date(), promptCost, completionCost, usage.prompt_tokens, usage.completion_tokens, model, prompt, 0, 0, 'Phone']
      ).catch(err => console.error('Error inserting AI charge details:', err));
      
      // Extract severity from response
      const responseTxt = response.choices[0].message.content.trim().toLowerCase();
      if (responseTxt.includes("high")) {
        severity = "High";
      } else if (responseTxt.includes("low")) {
        severity = "Low";
      }
    } else {
      // Simple keyword check for severity (no AI)
      const speechLower = speechResult.toLowerCase();
      if (speechLower.includes("high") || speechLower.includes("urgent") || 
          speechLower.includes("critical") || speechLower.includes("emergency")) {
        severity = "High";
      } else if (speechLower.includes("low") || speechLower.includes("minor")) {
        severity = "Low";
      }
    }
    
    // Update database with severity
    await updateQuery('UPDATE calls SET severity = ? WHERE unique_identifier = ?', 
      [severity, callSid])
      .then(() => console.log("Severity updated successfully"))
      .catch(err => console.error('Error updating severity:', err));
    
    // Start the conversation
    res.type('text/xml');
    res.send(`
      <Response>
        <Say voice="Polly.Danielle-Generative">Thank you for all the information. Connecting you with our AI assistant now.</Say>
        <Start>
          <Stream url="wss://${req.headers.host}/"/>
        </Start>
        <Gather input="speech" timeout="10" />
      </Response>
    `);
  } catch (error) {
    console.error("Error in process-severity:", error);
    
    // Start conversation anyway if there was an error
    res.type('text/xml');
    res.send(`
      <Response>
        <Say voice="Polly.Danielle-Generative">Thank you for the information. Connecting you with our AI assistant now.</Say>
        <Start>
          <Stream url="wss://${req.headers.host}/"/>
        </Start>
        <Gather input="speech" timeout="30" />
      </Response>
    `);
  }
});

// Fallback route if no speech is detected for severity
router.post("/process-severity-fallback", async (req, res) => {
  const callSid = req.body.CallSid;
  
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
      <Say voice="Polly.Danielle-Generative">I didn't hear your response about the severity.</Say>
      <Gather input="speech" action="/process-severity" method="POST" timeout="7">
        <Say voice="Polly.Danielle-Generative">Is this a high, medium, or low severity issue?</Say>
      </Gather>
      <Redirect method="POST">/start-conversation?CallSid=${callSid}</Redirect>
    </Response>
  `);
});

// Helper route to start the conversation directly
router.post("/start-conversation", async (req, res) => {
  const callSid = req.body.CallSid;
  
  // Check if call is still active
  if (!await isCallActive(callSid)) {
    console.log(`Call ${callSid} is no longer active, skipping`);
    res.type('text/xml');
    res.send('<Response></Response>');
    return;
  }
  
  res.type('text/xml');
  res.send(`
    <Response>
      <Say voice="Polly.Danielle-Generative">Thank you for all the information. Connecting you with our AI assistant now.</Say>
      <Start>
        <Stream url="wss://${req.headers.host}/"/>
      </Start>
      <Gather input="speech" timeout="30" />
    </Response>
  `);
});

module.exports = router;