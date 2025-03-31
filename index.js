const express = require('express');
const app = express();
const server = require('http').createServer(app);
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { processTranscription, client, request } = require('./googleSTT'); // Ensure googleSTT.js is imported
const { getAIResponse } = require('./openaiservices'); // OpenAI Response
const { insertCallDetails, insertChargeDetails, updateCallStatus } = require('./database'); // Database Operations
const path = require('path');  // Ensure path is imported for routing

require('dotenv').config();

// WebSocket server setup
const wss = new WebSocket.Server({ server });

wss.on("connection", function connection(ws) {
  console.log("New WebSocket connection established.");
  let recognizeStream = null;
  let callSid1 = uuidv4(); // Unique call identifier

  // Handle incoming WebSocket messages
  ws.on("message", async function incoming(message) {
    const msg = JSON.parse(message);
    console.log("Received WebSocket message:", msg); // Log the incoming message
    
    switch (msg.event) {
      case "connected":
        console.log("A new call has connected.");
        break;
        
      case "start":
        console.log('Starting Media Stream', JSON.stringify(msg));  // Log the incoming start message
        callSid1 = msg.start.callSid;
        
        try {
          recognizeStream = client
            .streamingRecognize(request)
            .on("error", (error) => {
              console.error("Error in streaming recognition:", error);
            })
            .on("data", async (data) => {
              console.log("Received data from streaming recognition:", data);  // Log the data received
              const transcriptionResult = await processTranscription(data);
              
              if (transcriptionResult) {
                const { name, role, department, issue, transcribedText, googleCharge, audioDurationInSeconds } = transcriptionResult;
                console.log(`Transcription Result: Name: ${name}, Role: ${role}, Department: ${department}, Issue: ${issue}`);

                // Get AI Response
                const aiResponse = await getAIResponse(transcribedText);

                // Insert charge details into the database
                await insertChargeDetails(callSid1, {
                  aiResponse,
                  transcribedText,
                  googleCharge,
                  audioDurationInSeconds,
                  totalCharge: aiResponse.totalCost
                });

                // Send playback data back to the client
                ws.send(JSON.stringify({
                  event: "twilio-playback",
                  twilioTwiML: "Twilio TwiML response here", // You can replace this with the actual TwiML
                }));
              } else {
                console.error("No transcription result.");
              }
            });
        } catch (err) {
          console.error("Error while setting up streaming recognition:", err);
        }
        break;

      case "stop":
        console.log(`Stopping recognition for CallSid: ${callSid1}`);
        await updateCallStatus(callSid1); // Update call status
        if (recognizeStream) {
          recognizeStream.destroy(); // Stop the stream if it exists
        } else {
          console.error("No active stream to destroy.");
        }
        break;
        
      default:
       // console.error("Unknown event received:", msg.event);
    }
  });
});

app.use(express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve HTML page for testing
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "/index.html"));
});

// Handle incoming call from Twilio
app.post("/incoming-call", async (req, res) => {
  const { CallSid, Called } = req.body;
  const to_number = process.env.TWILIO_PHONE_NUMBER;
  const caller_name = "Megha"; // Or fetch from caller ID
  
  await insertCallDetails(CallSid, Called, to_number, caller_name);
  
  res.set("Content-Type", "text/xml");
  res.send(`
    <Response>
      <Start>
        <Stream url="wss://${req.headers.host}/"/>
      </Start>
      <Say>Hi, welcome to Epic Health Desk, please tell me your name, role, department, and the issue you are facing.</Say>
      <Pause length="60" />
    </Response>
  `);
});

server.listen(3000, () => console.log("Server is listening on port 3000"));
