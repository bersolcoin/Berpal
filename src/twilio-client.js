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

module.exports = { sendConfirmation, sendText };
