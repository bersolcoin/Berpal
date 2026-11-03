const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const confirmationContentSid = process.env.TWILIO_CONFIRMATION_CONTENT_SID;

function resolveFromNumber() {
  const env = (process.env.TWILIO_ENV || 'sandbox').toLowerCase();
  const sandbox = process.env.TWILIO_WHATSAPP_NUMBER_SANDBOX;
  const live = process.env.TWILIO_WHATSAPP_NUMBER_LIVE;
  const legacy = process.env.TWILIO_WHATSAPP_NUMBER;

  if (env === 'live') {
    if (live) return live;
    console.warn('[twilio] TWILIO_ENV=live but TWILIO_WHATSAPP_NUMBER_LIVE not set');
  }
  return sandbox || legacy || null;
}

const fromNumber = resolveFromNumber();
console.log(`[twilio] env=${process.env.TWILIO_ENV || 'sandbox'} from=${fromNumber || '(none)'}`);

const client = accountSid && authToken ? twilio(accountSid, authToken) : null;

if (!client) {
  console.warn('[twilio] missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN — outbound messaging disabled');
}

function normalizeWhatsappAddress(addr) {
  if (!addr) return null;
  const s = String(addr).trim();
  return s.startsWith('whatsapp:') ? s : `whatsapp:${s}`;
}

async function sendConfirmation(toAddress, summaryText) {
  if (!client) {
    console.error('[twilio] cannot send confirmation: client not configured');
    return null;
  }
  if (!confirmationContentSid) {
    console.error('[twilio] cannot send confirmation: TWILIO_CONFIRMATION_CONTENT_SID not set');
    return null;
  }
  if (!fromNumber) {
    console.error('[twilio] cannot send confirmation: TWILIO_WHATSAPP_NUMBER not set');
    return null;
  }

  const to = normalizeWhatsappAddress(toAddress);

  try {
    const message = await client.messages.create({
      from: fromNumber,
      to,
      contentSid: confirmationContentSid,
      contentVariables: JSON.stringify({ '1': summaryText }),
    });
    console.log(`[twilio] sent confirmation message_sid=${message.sid} to=${to}`);
    return message.sid;
  } catch (err) {
    console.error('[twilio] failed to send confirmation:', err.message);
    return null;
  }
}

async function sendText(toAddress, text) {
  if (!client) {
    console.error('[twilio] cannot send text: client not configured');
    return null;
  }
  if (!fromNumber) {
    console.error('[twilio] cannot send text: from number not set');
    return null;
  }
  if (!text || !String(text).trim()) {
    return null;
  }

  const to = normalizeWhatsappAddress(toAddress);

  try {
    const message = await client.messages.create({
      from: fromNumber,
      to,
      body: String(text),
    });
    console.log(`[twilio] sent text message_sid=${message.sid} to=${to}`);
    return message.sid;
  } catch (err) {
    console.error('[twilio] failed to send text:', err.message);
    return null;
  }
}

/**
 * Send text + media (PDFs, images). mediaUrls must be publicly fetchable — Twilio downloads them.
 *
 * WhatsApp accepts only ONE media item per message, so the first URL rides with the text (as its
 * caption) and each further URL goes out as its own message right after. If the first message
 * (the one carrying the text) fails, nothing else is sent — orphaned attachments would confuse
 * the recipient.
 *
 * Returns { sids, errors }: sids in send order; errors [{ index, code, message }] with Twilio's
 * error code, so callers can tell "nothing went out" (sids empty) from "partly sent".
 * Asks for a status callback when PUBLIC_BASE_URL is set, so async delivery failures (e.g. 63016,
 * outside the 24h window) reach POST /twilio/status.
 */
async function sendMedia(toAddress, text, mediaUrls = []) {
  const fail = (code, message) => {
    console.error(`[twilio] cannot send media: ${message}`);
    return { sids: [], errors: [{ index: 0, code, message }] };
  };
  if (!client) return fail('not_configured', 'client not configured');
  if (!fromNumber) return fail('no_from_number', 'from number not set');

  const urls = (mediaUrls || []).filter(Boolean);
  const body = text && String(text).trim() ? String(text) : null;
  if (!urls.length && !body) return fail('empty', 'nothing to send');
  const parts = urls.length
    ? urls.map((u, i) => ({ ...(i === 0 && body ? { body } : {}), mediaUrl: [u] }))
    : [{ body }];

  const to = normalizeWhatsappAddress(toAddress);
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const sids = [];
  const errors = [];
  for (let i = 0; i < parts.length; i++) {
    try {
      const message = await client.messages.create({
        from: fromNumber,
        to,
        ...parts[i],
        ...(base ? { statusCallback: `${base}/twilio/status` } : {}),
      });
      console.log(`[twilio] sent media message_sid=${message.sid} to=${to}`);
      sids.push(message.sid);
    } catch (err) {
      console.error('[twilio] failed to send media:', err.message);
      errors.push({ index: i, code: err.code ?? null, message: err.message });
      if (i === 0) break;
    }
  }
  return { sids, errors };
}

/**
 * Send an approved WhatsApp template (Twilio Content API). Needed for business-initiated
 * messages outside WhatsApp's 24h customer-service window: Twilio ACCEPTS free-form text there
 * and returns a SID, but delivery then fails asynchronously (error 63016).
 * `variables` is { '1': '…', '2': '…' }; WhatsApp rejects newlines/tabs inside variables.
 * Asks for a status callback when PUBLIC_BASE_URL is set, so failures reach POST /twilio/status.
 *
 * Unlike sendText, this THROWS (Error with .code / .status) instead of returning null, so the
 * caller can record why — "63112 template not approved" beats "no sid".
 */
async function sendTemplate(toAddress, contentSid, variables = {}) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  if (!client) throw fail('TWILIO_NOT_CONFIGURED', 'twilio template: client not configured');
  if (!contentSid) throw fail('TWILIO_NO_CONTENT_SID', 'twilio template: no content SID');
  if (!fromNumber) throw fail('TWILIO_NO_FROM', 'twilio template: TWILIO_WHATSAPP_NUMBER not set');

  const to = normalizeWhatsappAddress(toAddress);
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

  try {
    const message = await client.messages.create({
      from: fromNumber,
      to,
      contentSid,
      contentVariables: JSON.stringify(variables),
      ...(base ? { statusCallback: `${base}/twilio/status` } : {}),
    });
    console.log(`[twilio] sent template ${contentSid} message_sid=${message.sid} to=${to}`);
    return message.sid;
  } catch (err) {
    console.error(`[twilio] failed to send template: ${err.code || ''} ${err.message}`);
    const e = fail(err.code || 'TWILIO_ERROR', `twilio template send failed${err.code ? ` (${err.code})` : ''}: ${err.message}`);
    e.status = err.status;
    throw e;
  }
}

module.exports = { sendConfirmation, sendText, sendMedia, sendTemplate };
