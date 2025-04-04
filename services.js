const WebSocket = require("ws");
const express = require("express");
const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });
const path = require("path");
require("dotenv").config();
const { selectQuery, updateQuery, insertQuery } = require('./db');
const { isCallActive, updateCallIfActive } = require('./twilioService');
const { createRecognizeStream } = require('./googleService');
const { callOpenAIWithTimeout, Price } = require('./openaiService');
const { searchDocuments } = require('./weaviateservices.mjs');

// Helper function to limit context size
function limitContextSize(documents, maxTokens = 2000) {
    let tokenCount = 0;
    const estimatedTokensPerChar = 0.25; // Rough estimate: 4 chars ≈ 1 token
    const result = [];

    for (const doc of documents) {
        // Estimate tokens in this document
        const docContent = `Document: ${doc.title || 'Untitled'}\n${doc.content || 'No content available'}`;
        const estimatedTokens = Math.ceil(docContent.length * estimatedTokensPerChar);

        // Check if adding this document would exceed our limit
        if (tokenCount + estimatedTokens > maxTokens) {
            break;
        }

        result.push(doc);
        tokenCount += estimatedTokens;
    }

    return {
        documents: result,
        estimatedTokens: tokenCount,
        truncated: result.length < documents.length
    };
}

// Helper function to format TTS responses
function formatTTSResponse(text) {
    // Remove excessive newlines and whitespace
    let formatted = text.replace(/\n+/g, ' ').replace(/\s+/g, ' ');

    // Break very long responses into digestible chunks if needed
    if (formatted.length > 1000) {
        // Add strategic pauses for better listening experience
        formatted = formatted.replace(/\. /g, '. <break time="500ms"/> ');
    }

    return formatted;
}

// WebSocket connections
wss.on("connection", function connection(ws) {
    console.log("New Connection Initiated");
    let callSid = null;
    let callDetails = null;
    let recognizeStream = null;

    // Store partial transcriptions for faster processing
    let currentTranscription = "";
    let processingTranscription = false;
    let isFirstInteraction = true;

    ws.on("message", async function incoming(message) {
        const msg = JSON.parse(message);
        switch (msg.event) {
            case "connected":
                console.log(`A new call has connected.`);
                break;
            case "start":
                callSid = msg.start.callSid;
                console.log(`Starting media stream for call: ${callSid}`);

                // Fetch call details - do this once and store for later use
                try {
                    const result = await selectQuery('SELECT * FROM calls WHERE unique_identifier = ?', [callSid]);

                    if (result.length > 0) {
                        callDetails = result[0];
                        console.log(`Call details loaded: ${JSON.stringify(callDetails)}`);
                    }
                } catch (err) {
                    console.error('Error fetching call details:', err);
                }
                // Update start time immediately
                const start_time = new Date();
                updateQuery('UPDATE calls SET start_time = ? WHERE unique_identifier = ?', [start_time, callSid])
                    .catch(err => console.error('Error updating start time:', err));
                recognizeStream = createRecognizeStream(async (data, transcription, isFinal) => {
                    // Skip if we're already processing
                    if (processingTranscription) return;

                    // Store the transcription
                    currentTranscription = transcription;

                    // Only process final results
                    if (isFinal) {
                        processingTranscription = true;

                        console.log("Final Transcribed Text:", transcription);

                        try {
                            // Calculate audio duration and costs
                            const audioDurationInSeconds = data.results[0].resultEndTime.seconds || 1;
                            const googleCharge = (audioDurationInSeconds / 60) * 0.006;

                            // Process the transcribed text with OpenAI - use a faster model for short texts
                            const model = "gpt-3.5-turbo";

                            // Check if call is still active before sending acknowledgment
                            if (await isCallActive(callSid)) {
                                // Send immediate acknowledgment to keep the call responsive
                                await updateCallIfActive(callSid, `<Response><Say>Processing your request...</Say><Gather input="speech" timeout="1" /></Response>`);
                            } else {
                                console.log(`Call ${callSid} is no longer active, skipping processing`);
                                processingTranscription = false;
                                return;
                            }

                            // Determine which content to use for processing
                            let userIssue = '';
                            let useOriginalIssue = false;
                            const dept = callDetails?.caller_department || 'unknown';

                            // Check if this is the first interaction or if transcription is minimal
                            console.log("isFirstInteraction", isFirstInteraction);
                            if (isFirstInteraction === true) {
                                if (callDetails && callDetails.caller_issue) {
                                    userIssue = callDetails.caller_issue;
                                    useOriginalIssue = true;
                                    console.log("Using original issue from database:", userIssue);
                                } else {
                                    userIssue = transcription;
                                    console.log("No original issue available, using transcription:", userIssue);
                                }
                            } else {
                                // Use the current transcription for subsequent interactions
                                userIssue = transcription;
                                console.log("Using current transcription as user issue:", userIssue);
                            }

                            // Mark that we've processed the first interaction
                            isFirstInteraction = false;

                            // Step 1: Extract keywords from the issue using OpenAI
                            const keywordExtractionPrompt = `Extract the main keywords (maximum 5) from this text that would be useful for a knowledge base search. Return only the keywords separated by commas: "${userIssue}"`;
                            let keywordResponse;
                            try {
                                keywordResponse = await callOpenAIWithTimeout(keywordExtractionPrompt, "gpt-3.5-turbo");
                                const keywords = keywordResponse.choices[0].message.content.trim();
                                console.log("Extracted keywords:", keywords);

                                // keywords extracting insertion into database
                                const modelPricing = Price(model);
                                const keywordUsage = keywordResponse.usage;
                                const keywordPromptCost = keywordUsage.prompt_tokens * modelPricing.prompt / 1000;
                                const keywordCompletionCost = keywordUsage.completion_tokens * modelPricing.completion / 1000;
                                const keywordTotalCost = keywordPromptCost + keywordCompletionCost;
                                const keywordTotalTokens = keywordUsage.prompt_tokens+keywordUsage.completion_tokens;

                                insertQuery('INSERT INTO charges (calls_id, ai_charge, ai_balance_amount, ai_tokens_used, transcript, created_at, prompt_charges, completion_charges, prompt_Token, completion_Token, ai_model, prompt, google_stt_charge, google_audio_duration, ai_model_ui) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                                    [callSid, keywordTotalCost, 0, keywordTotalTokens, keywords, new Date(), keywordPromptCost, keywordCompletionCost, keywordUsage.prompt_tokens,  keywordUsage.completion_tokens, model, keywordExtractionPrompt, 0, 0, 'Phone']
                                ).catch(err => console.error('Error inserting AI charge details:', err));

                                // Step 2: Search the knowledge base with error handling 
                                let searchResults = [];
                                try {
                                    searchResults = await Promise.race([
                                        searchDocuments(keywords, dept),
                                        new Promise((_, reject) =>
                                            setTimeout(() => reject(new Error('Weaviate search timeout')), 5000)
                                        )
                                    ]);
                                    console.log("Search results count:", searchResults ? searchResults.length : 0);
                                } catch (searchError) {
                                    console.error("Error or timeout during document search:", searchError);
                                    // Continue with empty results if search fails
                                    searchResults = [];
                                }

                               
                                // Step 3: Process the results and create a prompt for OpenAI
                                let prompt = '';

                                if (searchResults && searchResults.length > 0) {
                                    console.log("Processing search results");

                                    // Limit context size to prevent token overflow
                                    const limitedResults = limitContextSize(searchResults);
                                    console.log(`Using ${limitedResults.documents.length} of ${searchResults.length} documents (est. ${limitedResults.estimatedTokens} tokens)`);

                                    // Extract relevant content from limited search results
                                    const contextualInformation = limitedResults.documents.map(doc => {
                                        return `Document: ${doc.title || 'Untitled'}\n${doc.content || 'No content available'}`;
                                    }).join('\n\n');

                                    // Add a warning if we truncated results
                                    const truncationNotice = limitedResults.truncated ?
                                        "Note: Some knowledge base results were omitted due to size constraints." : "";

                                    if (useOriginalIssue) {
                                        prompt = `User ${callDetails?.caller_name || 'A caller'} initially reported: "${userIssue}".Knowledge base information:
                                                  ${contextualInformation}${truncationNotice}                        
                                                  Provide a concise answer using only the most relevant information from the knowledge base above.`;
                                    } else {
                                        prompt = `User ${callDetails?.caller_name || 'A caller'} is saying: "${transcription}".Knowledge base information:
                                                  ${contextualInformation}${truncationNotice}                        
                                                  Provide a concise answer using only the most relevant information from the knowledge base above.`;
                                    }

                                    // Call OpenAI with the enhanced prompt
                                    const openAIResponse = await callOpenAIWithTimeout(prompt, model,false);
                                    const aiResponse = openAIResponse.choices[0].message.content;
                                    console.log("AI response is:", aiResponse);
                                    console.log("AI response size:", aiResponse.length, "characters");

                                    // Calculate costs
                                    const usage = openAIResponse.usage;
                                    const modelPricing = Price(model);
                                    const promptCost = usage.prompt_tokens * modelPricing.prompt / 1000;
                                    const completionCost = usage.completion_tokens * modelPricing.completion / 1000;
                                    const totalCost = promptCost + completionCost;

                                    // Insert AI response details into database
                                    insertQuery('INSERT INTO charges (calls_id, ai_charge, ai_balance_amount, ai_tokens_used, transcript, created_at, prompt_charges, completion_charges, prompt_Token, completion_Token, ai_model, prompt, google_stt_charge, google_audio_duration, ai_model_ui) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                                        [callSid, totalCost, 0, usage.total_tokens, aiResponse, new Date(), promptCost , completionCost , usage.prompt_tokens, usage.completion_tokens , model, prompt, googleCharge.toFixed(6), audioDurationInSeconds, 'Phone']
                                    ).catch(err => console.error('Error inserting AI charge details:', err));

                                    // Format response for better TTS readability
                                    const formattedResponse = formatTTSResponse(aiResponse);

                                    // Send the response to the user with appropriate timeout
                                    if (await isCallActive(callSid)) {
                                        await updateCallIfActive(callSid, `<Response><Say>${formattedResponse}</Say><Gather input="speech" timeout="15" /></Response>`);
                                    }
                                } else {
                                    console.log("No search results found, using fixed response");

                                    // Fixed response text for no search results (no OpenAI call)
                                    const fixedResponse = "I couldn't find specific information about this in our knowledge base. Please provide a helpful response that acknowledges their input and asks for more specific details.";
                                    //console.log("Total tokens used:", finalTotalTokens);

                                    // Log the fixed response usage
                                    insertQuery('INSERT INTO charges (calls_id, ai_charge, ai_balance_amount, ai_tokens_used, transcript, created_at, prompt_charges, completion_charges, prompt_Token, completion_Token, ai_model, prompt, google_stt_charge, google_audio_duration, ai_model_ui) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                                        [callSid, 0, 0, 0, fixedResponse, new Date(), 0, 0, 0, 0, 'NA', fixedResponse, 0, 0, 'Phone']
                                    ).catch(err => console.error('Error inserting fixed response details:', err));


                                    // Send the fixed response to the user with longer timeout for user to respond
                                    if (await isCallActive(callSid)) {
                                        await updateCallIfActive(callSid, `<Response><Say>${fixedResponse}</Say><Gather input="speech" timeout="10" /></Response>`);
                                    }
                                }

                                // Also log the keywords and search results for analytics
                                insertQuery('INSERT INTO search_logs (calls_id, keywords, search_results_count, created_at) VALUES (?, ?, ?, ?)',
                                    [callSid, keywords, searchResults ? searchResults.length : 0, new Date()]
                                ).catch(err => console.error('Error logging search details:', err));

                            } catch (keywordError) {
                                console.error("Error in keyword extraction:", keywordError);
                                // Fallback for keyword extraction error
                                await updateCallIfActive(callSid, `<Response><Say>I'm having trouble processing your request. Could you please try rephrasing your question?</Say><Gather input="speech" timeout="5" /></Response>`);
                            }
                        } catch (error) {
                            console.error("Error processing transcription:", error);

                            // Attempt to capture error details for diagnosis
                            let errorMessage = "Unknown error";
                            if (error.response && error.response.data) {
                                errorMessage = JSON.stringify(error.response.data);
                            } else if (error.message) {
                                errorMessage = error.message;
                            }
                            console.error("Error details:", errorMessage);

                            // Log error to database for later analysis
                            try {
                                insertQuery('INSERT INTO error_logs (calls_id, error_message, created_at) VALUES (?, ?, ?)',
                                    [callSid, errorMessage.substring(0, 500), new Date()]
                                ).catch(err => console.error('Error logging error details:', err));
                            } catch (logError) {
                                console.error("Failed to log error:", logError);
                            }

                            // Fallback response in case of error
                            await updateCallIfActive(callSid, `<Response><Say>I'm sorry, I'm having trouble processing that. Could you please try again with more details about your issue?</Say><Gather input="speech" timeout="5" /></Response>`);
                        } finally {
                            processingTranscription = false;
                        }
                    }
                });
                break;
            case "media":
                if (recognizeStream) {
                    recognizeStream.write(msg.media.payload);
                }
                break;
            case "stop":
                console.log(`Call Has Ended: ${callSid}`);
                updateQuery('UPDATE calls SET call_status = ?, end_time = ? WHERE unique_identifier = ?',
                    ['ended', new Date(), callSid]
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

// Import and use route handlers
const callRoutes = require('./callRoutes');
app.use('/', callRoutes);

// Start the server
console.log("Listening on Port 3000");
server.listen(3000, () => {
    // Warm up connections on startup
    require('./openaiService').initializeServices();
});