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
      <Say voice="alice">Hello and welcome to the Epic Clinical Help Desk. I'm your automated support assistant.</Say>
      <Gather input="speech" action="/process-basic-details" method="POST" timeout="7">
        <Say voice="alice">Please provide your name and department.</Say>
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
    const prompt = `Extract these fields from the text: name and department. Format your response as valid JSON with these exact field names. If any field information is missing, use "Not provided" as the value. Text: "${speechResult}" Return only the JSON object with no additional text.`;    
    
    // Call OpenAI with a timeout to prevent hanging
    const response = await callOpenAIWithTimeout(prompt, "gpt-3.5-turbo");
    
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
    
    // Continue to collect issue and severity with TwiML response
    res.type('text/xml');
    res.send(`
      <Response>
        <Say voice="alice">Thank you. I've got that information.</Say>
        <Say voice="alice">Now, please describe the issue you're experiencing and its severity.</Say>
        <Gather input="speech" action="/process-issue-severity" method="POST" timeout="10">
          <Say voice="alice">Is this a high, moderate, or low severity issue?</Say>
        </Gather>
        <Redirect method="POST">/process-issue-severity-fallback?CallSid=${callSid}</Redirect>
      </Response>
    `);
    
  } catch (error) {
    console.error("Error in process-basic-details:", error);
    
    // Continue to collect issue and severity even if there was an error
    res.type('text/xml');
    res.send(`
      <Response>
        <Say voice="alice">Thank you. Now, please describe the issue you're experiencing and its severity.</Say>
        <Gather input="speech" action="/process-issue-severity" method="POST" timeout="10">
          <Say voice="alice">Is this a high, moderate, or low severity issue?</Say>
        </Gather>
        <Redirect method="POST">/process-issue-severity-fallback?CallSid=${callSid}</Redirect>
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
      <Say voice="alice">I didn't hear your response.</Say>
      <Gather input="speech" action="/process-basic-details" method="POST" timeout="10">
        <Say voice="alice">Please tell me your name and department.</Say>
      </Gather>
      <Redirect method="POST">/collect-issue-severity?CallSid=${callSid}</Redirect>
    </Response>
  `);
});

// Helper route to collect issue and severity
router.post("/collect-issue-severity", async (req, res) => {
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
      <Say voice="alice">Now, please describe the issue you're experiencing and its severity.</Say>
      <Gather input="speech" action="/process-issue-severity" method="POST" timeout="10">
        <Say voice="alice">Is this a high, moderate, or low severity issue?</Say>
      </Gather>
      <Redirect method="POST">/process-issue-severity-fallback?CallSid=${callSid}</Redirect>
    </Response>
  `);
});

// Process issue and severity details
router.post("/process-issue-severity", async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || "";
  
  console.log(`Issue and severity details collected: ${speechResult}`);
  
  try {
    // Extract issue and severity from speech result using OpenAI
    const prompt = `Extract these fields from the text: issue and severity. For severity, categorize as "High", "Medium", or "Low" based on context. Format your response as valid JSON with these exact field names. If any field information is missing, use "Not provided" for issue and "Medium" for severity. Text: "${speechResult}" Return only the JSON object with no additional text.`;    
    
    // Call OpenAI with a timeout to prevent hanging
    const response = await callOpenAIWithTimeout(prompt, "gpt-3.5-turbo");
    
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
        issue: speechResult,
        severity: "Medium"
      };
    }
    
    // Ensure all fields exist with default values
    extractedInfo = {
      issue: extractedInfo.issue || speechResult || "Not provided",
      severity: extractedInfo.severity || "Medium"
    };
    
    console.log("Final extracted issue info:", extractedInfo);
    
    // Update database with extracted information
    await updateQuery('UPDATE calls SET caller_issue = ?, severity = ? WHERE unique_identifier = ?', 
      [extractedInfo.issue, extractedInfo.severity, callSid])
      .then(() => console.log("Issue details updated successfully"))
      .catch(err => console.error('Error updating issue details:', err));
    
    // Start the conversation
    res.type('text/xml');
    res.send(`
      <Response>
        <Say voice="alice">Thank you for all the information. Connecting you with our AI assistant now.</Say>
        <Start>
          <Stream url="wss://${req.headers.host}/"/>
        </Start>
        <Gather input="speech" timeout="30" />
      </Response>
    `);
  } catch (error) {
    console.error("Error in process-issue-severity:", error);
    
    // Start conversation anyway if there was an error
    res.type('text/xml');
    res.send(`
      <Response>
        <Say voice="alice">Thank you for the information. Connecting you with our AI assistant now.</Say>
        <Start>
          <Stream url="wss://${req.headers.host}/"/>
        </Start>
        <Gather input="speech" timeout="30" />
      </Response>
    `);
  }
});

// Fallback route if no speech is detected for issue and severity
router.post("/process-issue-severity-fallback", async (req, res) => {
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
      <Say voice="alice">I didn't hear your response about the issue.</Say>
      <Gather input="speech" action="/process-issue-severity" method="POST" timeout="15">
        <Say voice="alice">Please describe the issue you're experiencing and whether it's high, moderate, or low severity.</Say>
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
      <Say voice="alice">Thank you for all the information. Connecting you with our AI assistant now.</Say>
      <Start>
        <Stream url="wss://${req.headers.host}/"/>
      </Start>
      <Gather input="speech" timeout="30" />
    </Response>
  `);
});

module.exports = router;