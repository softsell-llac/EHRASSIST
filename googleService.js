const speech = require("@google-cloud/speech");
const textToSpeech = require("@google-cloud/text-to-speech");
require("dotenv").config();

const client = new speech.SpeechClient();
const ttsClient = new textToSpeech.TextToSpeechClient();

const request = {
  config: {
    encoding: "MULAW",
    sampleRateHertz: 8000,
    languageCode: "en-GB",
    model: "phone_call",
    useEnhanced: true,
  },
  interimResults: true,
};

function createRecognizeStream(callback) {
  return client.streamingRecognize(request)
    .on("error", console.error)
    .on("data", (data) => {
      if (data.results[0]) {
        const transcription = data.results[0].alternatives[0].transcript;
        const isFinal = data.results[0].isFinal;
        callback(data, transcription, isFinal);
      }
    });
}

async function textToSpeechConvert(text, voiceName = "en-US-Wavenet-F") {
  const request = {
    input: { text },
    voice: { languageCode: "en-US", name: voiceName },
    audioConfig: { audioEncoding: "MP3" },
  };

  try {
    const [response] = await ttsClient.synthesizeSpeech(request);
    return response.audioContent;
  } catch (error) {
    console.error("Text-to-speech error:", error);
    throw error;
  }
}

module.exports = {
  createRecognizeStream,
  textToSpeechConvert,
};
