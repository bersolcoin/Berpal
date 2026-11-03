/**
 * Shared OpenAI client for media intake (vision + transcription). Kept separate from the one in
 * conversation.js so tests can swap in a stub without touching the chat loop.
 */
const OpenAI = require('openai');

let _client;

/** The OpenAI client, or null when OPENAI_API_KEY is unset (callers treat that as "can't read media"). */
function getClient() {
  if (_client !== undefined) return _client;
  // Media calls run while the user waits on WhatsApp: bound them hard rather than letting the
  // SDK's defaults (10 min, 2 retries) hold the per-user queue hostage.
  _client = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30000, maxRetries: 1 })
    : null;
  return _client;
}

/** Tests only: inject a stub shaped like the SDK ({ chat.completions.create, audio.transcriptions.create }). */
function _setClientForTests(client) {
  _client = client;
}

module.exports = { getClient, _setClientForTests };
