const twilio = require('twilio');
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function isCallActive(callSid) {
  try {
    if (!callSid) return false;
    const call = await client.calls(callSid).fetch();
    return ['in-progress', 'ringing', 'queued'].includes(call.status);
  } catch (error) {
    console.error(`Error checking call status for ${callSid}:`, error.message);
    return false;
  }
}

async function updateCallIfActive(callSid, twiml) {
  try {
    if (!callSid) {
      console.log("No callSid provided for update");
      return false;
    }
    if (await isCallActive(callSid)) {
      await client.calls(callSid).update({ twiml: twiml });
      console.log("Call updated successfully");
      return true;
    } else {
      console.log(`Call ${callSid} is no longer active, skipping update`);
      return false;
    }
  } catch (error) {
    if (error.code === 21220) {
      console.log(`Call ${callSid} is no longer active, skipping update`);
    } else {
      console.error(`Error updating call: ${error}`);
    }
    return false;
  }
}

module.exports = {
  isCallActive,
  updateCallIfActive,
};