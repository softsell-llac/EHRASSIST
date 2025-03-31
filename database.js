const { selectQuery, insertQuery, updateQuery, deleteQuery } = require('./db');

// Insert call details into the database
async function insertCallDetails(callSid, from_number, to_number, caller_name) {
  return insertQuery('INSERT INTO calls (unique_identifier, from_number, to_number, caller_name, call_status, start_time) VALUES (?, ?, ?, ?, ?, ?)', 
    [callSid, from_number, to_number, caller_name, 'started', new Date()]
  );
}

// Insert charge details into the database
async function insertChargeDetails(callSid, chargeDetails) {
  return insertQuery('INSERT INTO charges (calls_id, ai_charge, ai_balance_amount, ai_tokens_used, transcript, created_at, prompt_charges, completion_charges, prompt_Token, completion_Token, ai_model, prompt, google_stt_charge, google_audio_duration, prompt_charges_ui, completion_charges_ui, prompt_token_ui, completion_token_ui,  ai_model_ui) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', 
    [
      callSid,
      chargeDetails.totalCharge,
      0,
      chargeDetails.totalTokens,
      chargeDetails.aiResponse,
      new Date(),
      chargeDetails.promptCost,
      chargeDetails.completionCost,
      chargeDetails.usage.prompt_tokens,
      chargeDetails.usage.completion_tokens,
      chargeDetails.model,
      chargeDetails.transcribedText,
      chargeDetails.googleCharge.toFixed(6),
      chargeDetails.audioDurationInSeconds,
      chargeDetails.promptCostUI,
      chargeDetails.completionCostUI,
      chargeDetails.usageUI.prompt_tokens,
      chargeDetails.usageUI.completion_tokens,
      'Phone'
    ]
  );
}

// Update call status in the database
async function updateCallStatus(callSid) {
  return updateQuery('UPDATE calls SET call_status = ?, end_time = ? WHERE unique_identifier = ?', 
    ['ended', new Date(), callSid]
  );
}

module.exports = { insertCallDetails, insertChargeDetails, updateCallStatus };
