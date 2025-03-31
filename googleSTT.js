const { SpeechClient } = require('@google-cloud/speech');
require("dotenv").config();
const { extractDetails } = require('./openaiservices'); // OpenAI Response

const client = new SpeechClient();

const request = {
  config: {
    encoding: "MULAW",
    sampleRateHertz: 8000,
    languageCode: "en-GB" 
  },
  interimResults: true, 
};

async function processTranscription(data) {
  if (data.results[0] && data.results[0].isFinal) {
    const transcribedText = data.results[0].alternatives[0].transcript;
    console.log("Transcribed Text:", transcribedText);

    // Calculate audio duration and Google STT charge
    const audioDurationInSeconds = data.results[0].resultEndTime.seconds;
    const audioDurationInMinutes = audioDurationInSeconds / 60;
    const googleCharge = (audioDurationInMinutes * 0.006);

    console.log(`Audio Duration (seconds): ${audioDurationInSeconds}`);
    console.log(`Estimated Google STT charge: $${googleCharge.toFixed(6)}`);

    // Extract details using OpenAI
    const extractedDetails = await extractDetails(transcribedText);
    console.log("extracted details:", extractedDetails);

    return {
      transcribedText,
      googleCharge,
      audioDurationInSeconds,
      ...extractedDetails,
    };
  }
}

module.exports = { client, request,processTranscription };  // Exporting client
