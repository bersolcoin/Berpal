/**
 * Media intake for an inbound message (any channel): receipt/bill photos and PDFs are scanned and
 * stored, voice notes are transcribed. Items come from inbound.media and are downloaded through
 * the channel that produced them (channel.downloadMedia(item)); shared contacts arrive already
 * parsed in inbound.contacts and are left to whatsapp.js.
 *
 * HEIC/HEIF photos are converted to JPEG first (src/media/heic.js) and then treated exactly like a
 * JPEG; only when conversion fails does the user get the "send it as JPEG" reply.
 *
 * Each item is handled independently: one unreadable photo doesn't throw away the caption or the
 * other attachments, it just becomes a "[receipt could not be read]" marker for the model.
 *
 * Result:
 *   lines       synthetic "[receipt scanned] {…}" / failure-marker lines, appended after the caption
 *   transcript  sanitised voice-note text (whatsapp.js sends it on as "[voice note] …")
 *   mediaIds    blobs stored for this message (whatsapp.js discards them if the turn fails)
 *   reply       when set, send this plain text to the user and stop — nothing usable arrived
 *   silent      when true, do nothing at all (e.g. a lone sticker)
 */
const { enforceMaxBytes } = require('./download');
const channels = require('../channels');
const { scanDocument, formatScanLine, cleanText } = require('./vision');
const { transcribe } = require('./transcribe');
const { heicToJpeg } = require('./heic');
const store = require('./store');
const { query } = require('../db');
const { contentHash } = require('../trust/duplicates');
const { ts } = require('../erp-sync/common');

const SCAN_FAILED_REPLY =
  "Sorry, I couldn't read that receipt. Please try a clearer photo, or just type the details (e.g. \"paid 185 at Starbucks\").";
const TOO_LARGE_REPLY =
  "Sorry, that file is too large for me to read. Please send a smaller photo, or type the details.";
const VOICE_FAILED_REPLY =
  "Sorry, I couldn't make out that voice note. Please try again, or type the message instead.";
const HEIC_REPLY =
  "Sorry, I couldn't open that HEIC photo. Please send it as a regular photo (JPEG/PNG), or type the details.";
const UNSUPPORTED_REPLY =
  "Sorry, I can't read that kind of file yet. I can handle receipt photos (JPEG, PNG, HEIC), PDF bills, voice notes and shared contacts.";

const SCAN_FAILED_MARKER = '[receipt could not be read]';
const VOICE_FAILED_MARKER = '[voice note could not be transcribed]';
const MAX_TRANSCRIPT_CHARS = 2000;

function kindOf(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (/vcard/.test(ct)) return 'vcard';
  if (ct === 'image/jpeg' || ct === 'image/png' || ct === 'application/pdf') return 'document';
  // WhatsApp stickers are webp; only treat a webp as a receipt when the user captioned it.
  if (ct === 'image/webp') return 'webp';
  if (ct === 'image/heic' || ct === 'image/heif') return 'heic';
  if (ct.startsWith('audio/')) return 'audio';
  return 'unsupported';
}

/** inbound.media with content types normalised (the channel should already have done it). */
function listMedia(inbound) {
  if (!inbound || !Array.isArray(inbound.media)) return [];
  return inbound.media
    .filter((m) => m && m.contentType && (m.ref != null || m.url))
    .map((m) => ({ ...m, contentType: String(m.contentType).split(';')[0].trim().toLowerCase() }));
}

/** The channel that delivered this message (its own media refs only make sense to it). */
function channelFor(user, inbound) {
  return (inbound && inbound.channel && channels.get(inbound.channel)) || channels.forAddress(user.phone);
}

/**
 * Bytes of one item via its channel; the MEDIA_MAX_BYTES cap is re-checked whatever the channel.
 * → { bytes, contentType }. The type the download reports wins over the one the webhook declared
 * when it is one we can read in the same way (`kinds`): LINE declares every image as image/jpeg
 * and every voice note as audio/mp4, but serves the real type (e.g. a PNG). Anything else — a
 * missing, unknown or other-family type — keeps the declared one.
 */
async function fetchItem(channel, item, kinds) {
  const got = (await channel.downloadMedia(item)) || {};
  const bytes = enforceMaxBytes(got.bytes);
  const served = got.contentType ? String(got.contentType).split(';')[0].trim().toLowerCase() : '';
  const contentType = served && kinds.includes(kindOf(served)) ? served : item.contentType;
  return { bytes, contentType };
}

const SCAN_KINDS = ['document', 'webp', 'heic'];

/** Voice transcripts are user-controlled text going into the prompt: same flattening as scan values. */
function cleanTranscript(text) {
  return cleanText(text, MAX_TRANSCRIPT_CHARS);
}

async function scanItem(user, channel, item) {
  let { contentType } = item;
  let bytes;
  let scan;
  try {
    // The MEDIA_MAX_BYTES cap applies to the original download, HEIC included.
    ({ bytes, contentType } = await fetchItem(channel, item, SCAN_KINDS));
    if (kindOf(contentType) === 'heic') {
      try {
        bytes = await heicToJpeg(bytes);
      } catch (err) {
        console.error(`• [media] [${ts()}] ${err.message}`);
        return { ok: false, heic: true };
      }
      contentType = 'image/jpeg';
    }
    scan = await scanDocument(bytes, contentType, { timezone: user.timezone });
  } catch (err) {
    console.error(`• [media] [${ts()}] scan failed: ${err.message}`);
    return { ok: false, tooLarge: err.code === 'MEDIA_TOO_LARGE' };
  }
  // Stored only after a successful scan so failed reads don't leave orphan blobs. If storage
  // fails the scan is still useful — the receipt just won't be attached to the ERPNext doc.
  let mediaId = null;
  try {
    mediaId = await store.saveBlob(user.id, { contentType, bytes });
  } catch (err) {
    console.error(`• [media] [${ts()}] blob store failed: ${err.message}`);
  }
  // Content hash for the duplicate guard (src/trust): request_confirmation reads it by the
  // draft's receipt_media_id and puts it on the draft as receipt_hash. Best effort.
  if (mediaId != null) {
    try {
      await query('UPDATE media_blobs SET sha256 = $1 WHERE id = $2 AND user_id = $3', [contentHash(bytes), mediaId, user.id]);
    } catch (err) {
      console.error(`• [media] [${ts()}] receipt hash failed: ${err.message}`);
    }
  }
  return { ok: true, mediaId, line: formatScanLine(mediaId, scan) };
}

async function transcribeItem(channel, item) {
  try {
    const { bytes, contentType } = await fetchItem(channel, item, ['audio']);
    const text = cleanTranscript(await transcribe(bytes, contentType));
    if (!text) throw new Error('empty transcript after cleaning');
    return { ok: true, text };
  } catch (err) {
    console.error(`• [media] [${ts()}] transcription failed: ${err.message}`);
    return { ok: false };
  }
}

/**
 * @param {object} user  users row (id, timezone)
 * @param {object|null} inbound  the normalised inbound message (src/channels/index.js)
 * @param {string} body  the user's caption / text
 */
async function intake(user, inbound, body = '') {
  const result = { lines: [], transcript: null, mediaIds: [], reply: null, silent: false };
  const media = listMedia(inbound);
  if (!media.length) return result;
  const channel = channelFor(user, inbound);

  const hasCaption = Boolean(String(body || '').trim());
  // Anything for the model to act on? A shared contact counts, as the vCard item used to.
  let usable = hasCaption || Boolean(inbound.contacts && inbound.contacts.length);
  let scanFailed = false;
  let tooLarge = false;
  let voiceFailed = false;
  let heic = false;
  let sticker = false;
  let unsupported = false;
  const transcripts = [];

  for (const item of media) {
    const kind = kindOf(item.contentType);
    if (kind === 'vcard') {
      usable = true;
      continue;
    }
    if (kind === 'webp' && !hasCaption) {
      sticker = true;
      continue;
    }
    if (kind === 'unsupported') {
      console.log(`• [media] [${ts()}] ignoring unsupported ${item.contentType}`);
      unsupported = true;
      continue;
    }

    if (kind === 'document' || kind === 'webp' || kind === 'heic') {
      const r = await scanItem(user, channel, item);
      if (r.ok) {
        usable = true;
        if (r.mediaId != null) result.mediaIds.push(r.mediaId);
        result.lines.push(r.line);
      } else if (r.heic) {
        heic = true; // conversion failed: the HEIC-specific marker / reply below
      } else {
        scanFailed = true;
        tooLarge = tooLarge || r.tooLarge;
        result.lines.push(SCAN_FAILED_MARKER);
      }
      continue;
    }

    // kind === 'audio'
    const r = await transcribeItem(channel, item);
    if (r.ok) {
      usable = true;
      transcripts.push(r.text);
    } else {
      voiceFailed = true;
      result.lines.push(VOICE_FAILED_MARKER);
    }
  }

  if (transcripts.length) result.transcript = transcripts.join(' ');
  if (heic && usable) result.lines.push('[photo in HEIC format could not be read]');
  if (usable) return result;

  // Nothing to act on: answer directly instead of handing the model an empty message.
  // (No blobs can exist here — a stored blob means a successful scan, which is usable.)
  if (voiceFailed) result.reply = VOICE_FAILED_REPLY;
  else if (scanFailed) result.reply = tooLarge ? TOO_LARGE_REPLY : SCAN_FAILED_REPLY;
  else if (heic) result.reply = HEIC_REPLY;
  else if (unsupported) result.reply = UNSUPPORTED_REPLY;
  else if (sticker) result.silent = true;
  result.lines = [];
  return result;
}

/** Drop blobs stored for a message whose turn failed, so they don't linger until the purge. */
async function discard(userId, mediaIds) {
  for (const id of mediaIds || []) {
    try {
      await store.deleteBlob(userId, id);
    } catch (err) {
      console.error(`• [media] [${ts()}] discard ${id} failed: ${err.message}`);
    }
  }
}

module.exports = {
  intake, discard, kindOf, listMedia,
  SCAN_FAILED_REPLY, TOO_LARGE_REPLY, VOICE_FAILED_REPLY, HEIC_REPLY, UNSUPPORTED_REPLY,
  SCAN_FAILED_MARKER, VOICE_FAILED_MARKER,
};
