const WebSocket = require("ws");
const express = require("express");
const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { selectQuery, insertQuery, updateQuery, deleteQuery } = require('./db');

require("dotenv").config();

// Include Google Speech to Text and Text-to-Speech
const speech = require("@google-cloud/speech");
const textToSpeech = require("@google-cloud/text-to-speech");
const client = new speech.SpeechClient();
const ttsClient = new textToSpeech.TextToSpeechClient();

// OpenAI API Setup
const { OpenAI } = require("openai");
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Configure Transcription Request
const request = {
  config: {
    encoding: "MULAW",
    sampleRateHertz: 8000,
    languageCode: "en-GB",
    model: "phone_call", 
  },
  //interimResults: true, // If you want interim results, set this to true
};

// Function to map any model version (like "gpt-3.5-turbo-0125") to base model name
function getBaseModelName(model) {
  if (model.startsWith("gpt-3.5-turbo")) {
    return "gpt-3.5-turbo";
  } else if (model.startsWith("gpt-4")) {
    return "gpt-4";
  }
  return model; // If model is not recognized, return as is
}

function Price(model){
  const baseModel = getBaseModelName(model); // Get the base model name
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
  const model_pricing = pricing[baseModel];
  return model_pricing; 

}

// Timer and Pause Detection Variables
let lastAudioReceivedTime = Date.now();
const PAUSE_THRESHOLD = 3000; // 3 seconds pause threshold
let recognizeStream = null;

wss.on("connection", function connection(ws) {
    console.log("New Connection Initiated");
  
    let callSid1 = uuidv4(); // Generate unique call SID
    let isNameCollected = false;
    let isRoleCollected = false;
    let isDepartmentCollected = false;
    let isIssueCollected = false;
  
    let callerName = '';
    let callerRole = '';
    let callerDepartment = '';
    let callerIssue = '';
  
    ws.on("message", function incoming(message) {
      const msg = JSON.parse(message);
  
      switch (msg.event) {
        case "connected":
          console.log(`A new call has connected.`);
          break;
          case "twilio-playback":
            const twiml = msg.twilioTwiML;
        console.log("TwiML for playback received: ", twiml);
        
        // Now you need to handle this TwiML to trigger playback or send it to Twilio
        // Example: if you need to call a Twilio API to initiate playback, do it here
        break;
  
        case "start":
          callSid1 = msg.start.callSid;
          recognizeStream = client.streamingRecognize(request)
            .on("error", console.error)
            .on("data", async (data) => {
              if (data.results[0] && data.results[0].isFinal) {
                const transcribedText = data.results[0].alternatives[0].transcript;
                console.log("Transcribed Text:", transcribedText);
                const audioDurationInSeconds = data.results[0].resultEndTime.seconds;
                const googleCharge = (audioDurationInSeconds / 60) * 0.006;
  
                // Pause detection logic
                if (Date.now() - lastAudioReceivedTime > PAUSE_THRESHOLD) {
                  //console.log("Speech finished, checking for missing data.");
  
                  // Fetch caller details from the database
                  selectQuery('SELECT * FROM calls WHERE unique_identifier = ?', [callSid1])
                    .then(async (result) => {
                      const callDetails = result[0];

                      // Check for missing data and prompt for each field if necessary
                      if (
                        callDetails.caller_name == null || callDetails.caller_name === 'Not provided' ||
                        callDetails.caller_role == null || callDetails.caller_role === 'Not provided' ||
                        callDetails.caller_department == null || callDetails.caller_department === 'Not provided' ||
                        callDetails.caller_issue == null || callDetails.caller_issue === 'Not provided'
                      ) {
                        // Missing data, need to ask for details
                        if (!isNameCollected) {
                            console.log("Extracting Name from the transcription...");
                            const prompt = `Extract the name from the following text: "${transcribedText}"`;
                            const response = await openai.chat.completions.create({
                              model: "gpt-3.5-turbo",
                              messages: [{ role: "user", content: prompt }],
                            });
                            callerName = response.choices[0].message.content;
                            console.log("Extracted Name:", callerName);
                            isNameCollected = true;

                            // Update database with name and move to next step
                            updateQuery('UPDATE calls SET caller_name = ?, start_time = ? WHERE unique_identifier = ?',
                              [callerName, new Date(), callSid1]
                            );
                            const twimlResponse = `
                            <Response>
                              <Say>Thank you, ${callerName}. Please tell me your role.</Say>
                            </Response>
                          `;
                          
                          console.log("twimlResponse: ", twimlResponse);
                          
                          // Send TwiML response via WebSocket with the correct event
                          ws.send(JSON.stringify({
                            event: "twilio-playback", 
                            twilioTwiML: twimlResponse
                          }));
                          
                        }
  
                        if (!isRoleCollected) {
                            console.log("Extracting Role from the transcription...");
                            const prompt = `Extract the role from the following text: "${transcribedText}"`;
                            const response = await openai.chat.completions.create({
                              model: "gpt-3.5-turbo",
                              messages: [{ role: "user", content: prompt }],
                            });
                            callerRole = response.choices[0].message.content;
                            console.log("Extracted role:", callerRole);
                            isRoleCollected = true;

                            // Update database with role and move to next step
                            updateQuery('UPDATE calls SET caller_role = ? WHERE unique_identifier = ?',
                              [callerRole, callSid1]
                            );
  
                            const twimlResponse = `
                              <Response>
                                <Say>Thank you, ${callerRole}. Please tell me your department.</Say>
                              </Response>
                            `;
                            ws.send(JSON.stringify({ event: "twilio-playback", twilioTwiML: twimlResponse }));
                            return;
                        }
  
                        if (!isDepartmentCollected) {
                          console.log("Extracting Department from the transcription...");
                          const prompt = `Extract the department from the following text: "${transcribedText}"`;
                          const response = await openai.chat.completions.create({
                            model: "gpt-3.5-turbo",
                            messages: [{ role: "user", content: prompt }],
                          });
                          callerDepartment = response.choices[0].message.content;
                          console.log("Extracted department:", callerDepartment);
                          isDepartmentCollected = true;

                          // Update database with department and move to next step
                          updateQuery('UPDATE calls SET caller_department = ? WHERE unique_identifier = ?',
                            [callerDepartment, callSid1]
                          );
  
                          const twimlResponse = `
                            <Response>
                              <Say>Thank you, ${callerDepartment}. Please tell me the issue you're facing and its severity.</Say>
                            </Response>
                          `;
                          ws.send(JSON.stringify({ 
                            event: "media", 
                            streamSid: callSid1,
                            media: {
                              payload: Buffer.from(twimlResponse).toString('base64')
                            }
                          }));
                          return;
                        }
  
                        if (!isIssueCollected) {
                          console.log("Extracting Issue from the transcription...");
                          const prompt = `Extract the issue from the following text: "${transcribedText}"`;
                          const response = await openai.chat.completions.create({
                            model: "gpt-3.5-turbo",
                            messages: [{ role: "user", content: prompt }],
                          });
                          callerIssue = response.choices[0].message.content;
                          console.log("Extracted issue:", callerIssue);
                          isIssueCollected = true;

                          // Update database with issue and finalize the process
                          updateQuery('UPDATE calls SET caller_issue = ? WHERE unique_identifier = ?',
                            [callerIssue, callSid1]
                          );
  
                          const twimlResponse = `
                            <Response>
                              <Say>Thank you for providing the information. Please hold while we process your request.</Say>
                            </Response>
                          `;
                          ws.send(JSON.stringify({ event: "twilio-playback", twilioTwiML: twimlResponse }));
  
                          // Continue with the OpenAI processing
                          const openAIResponse = await openai.chat.completions.create({
                            model: "gpt-3.5-turbo",
                            messages: [{ role: "user", content: `Please help with this issue: ${callerIssue}` }],
                          });
                          const aiResponse = openAIResponse.choices[0].message.content;

                          const usage = openAIResponse.usage;
                          const model = openAIResponse.model;
                          const modelPricing = Price(model);
                          const promptCost = usage.prompt_tokens * modelPricing.prompt / 1000;
                          const completionCost = usage.completion_tokens * modelPricing.completion / 1000;
                          const totalCost = promptCost + completionCost;
                          const totalCharge = totalCost.toFixed(6);
                          const totalTokens = usage.total_tokens;
  
                          insertQuery('INSERT INTO charges (calls_id, ai_charge, ai_balance_amount, ai_tokens_used, transcript, created_at, prompt_charges, completion_charges, prompt_Token, completion_Token, ai_model, prompt, google_stt_charge, google_audio_duration, ai_model_ui) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 
                            [callSid1, totalCharge, 0, totalTokens, aiResponse, new Date(), promptCost, completionCost, usage.prompt_tokens, usage.completion_tokens, model, callerIssue, googleCharge.toFixed(6), audioDurationInSeconds, 'Phone']
                          )
                            .then(result => {
                              console.log('AI charge details inserted into the database');
                            })
                            .catch(err => {
                              console.error('Error inserting AI charge details:', err);
                            });
                        }
                      }
                    });
                }
              } else {
                lastAudioReceivedTime = Date.now();
              }
            });
          break;
  
        case "media":
          recognizeStream.write(msg.media.payload);
          break;
  
        case "stop":
          console.log(`Call Has Ended`);
          updateQuery('UPDATE calls SET call_status = ?, end_time = ? WHERE unique_identifier = ?',
            ['ended', new Date(), callSid1]
          )
            .then(result => {
              console.log('Call status updated to "ended"');
            })
            .catch(err => {
              console.error('Error updating call status:', err);
            });
          recognizeStream.destroy();
          break;
      }
    });
  });


app.use(express.static("public"));
app.use(express.json()); // Middleware to parse JSON body
app.use(express.urlencoded({ extended: true })); // Middleware to parse x-www-form-urlencoded data

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "/index.html")));

app.post("/incoming-call", (req, res) => {
  // Insert a new call record into the database
  //console.log("request details", JSON.stringify(req.body));

  const callSid = req.body.CallSid; 
  const from_number = req.body.Called;
  const to_number = process.env.TWILIO_PHONE_NUMBER;  // Accessing environment variable
  const caller_name = " ";

  insertQuery('INSERT INTO calls (unique_identifier, from_number, to_number, caller_name, call_status, created_at) VALUES (?, ?, ?, ?, ?, ?)', 
    [callSid, from_number, to_number, caller_name, 'started', new Date()]
  )
  .then(result => {
    console.log('Call details inserted into the database');
  })
  .catch(err => {
    console.error('Error inserting call details:', err);
  });

  res.set("Content-Type", "text/xml");// se
  res.send(`
    <Response>
      <Start>
        <Stream url="wss://${req.headers.host}/"/>
      </Start>
      <Say>Hello, welcome to Epic Health Desk, please tell me your name, role, department, and the issue you are facing.</Say>
      <Pause length="60" />
    </Response>
  `);
});

console.log("Listening on Port 3000");
server.listen(3000);
