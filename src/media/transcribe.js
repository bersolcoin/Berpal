/**
 * Voice-note transcription. WhatsApp voice notes arrive from Twilio as audio/ogg (Opus), which the
 * OpenAI transcription endpoint accepts directly — no ffmpeg step.
 */
const { toFile } = require('openai');
const { getClient } = require('./openai-client');
const { ts } = require('../erp-sync/common');

const FALLBACK_MODEL = 'whisper-1';

// Models reported missing → time we may try them again. Keyed by name so changing
// MEDIA_TRANSCRIBE_MODEL takes effect at once; expiring so a model enabled later gets picked up.
const UNAVAILABLE_TTL_MS = 60 * 60 * 1000;
const unavailableUntil = new Map();

function isUnavailable(model) {
  const until = unavailableUntil.get(model);
  if (until == null) return false;
  if (Date.now() < until) return true;
  unavailableUntil.delete(model);
  return false;
}

function primaryModel() {
  return process.env.MEDIA_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
}

// The newer *-transcribe models aren't enabled on every OpenAI project. Only a genuine
// "no such model" degrades to whisper-1; any other 404 or error is a real failure.
function isModelNotFound(err) {
  if (!err) return false;
  return err.code === 'model_not_found' || (err.status === 404 && /model/i.test(err.message || ''));
}

function extensionFor(contentType) {
  const sub = String(contentType || '').split(';')[0].split('/')[1] || 'ogg';
  return { mpeg: 'mp3', 'x-m4a': 'm4a', mp4: 'm4a', amr: 'amr' }[sub] || sub;
}

/** @returns {Promise<string>} the transcript (trimmed); throws on failure or empty result. */
async function transcribe(bytes, contentType) {
  const client = getClient();
  if (!client) throw new Error('OPENAI_API_KEY not set');
  const filename = `voice.${extensionFor(contentType)}`;
  const run = async (model) => {
    // toFile per attempt: the upload stream is consumed by the first request.
    const file = await toFile(bytes, filename, { type: contentType });
    const res = await client.audio.transcriptions.create({ model, file });
    return (res && res.text ? res.text : '').trim();
  };
  const started = Date.now();
  const primary = primaryModel();
  let model = isUnavailable(primary) ? FALLBACK_MODEL : primary;
  let text;
  try {
    text = await run(model);
  } catch (err) {
    if (!isModelNotFound(err) || model === FALLBACK_MODEL) throw err;
    console.warn(`• [media] [${ts()}] ${model} unavailable, using ${FALLBACK_MODEL} for the next hour`);
    unavailableUntil.set(model, Date.now() + UNAVAILABLE_TTL_MS);
    model = FALLBACK_MODEL;
    text = await run(model);
  }
  if (!text) throw new Error('empty transcript');
  // Transcript text is PII: log its length only.
  console.log(`• [media] [${ts()}] transcribed ${bytes.length} bytes with ${model} in ${Date.now() - started}ms (${text.length} chars)`);
  return text;
}

/** Tests only: forget cached "model unavailable" decisions. */
function _resetForTests() {
  unavailableUntil.clear();
}

module.exports = { transcribe, isModelNotFound, FALLBACK_MODEL, UNAVAILABLE_TTL_MS, _resetForTests };
