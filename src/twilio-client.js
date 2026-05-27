const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const confirmationContentSid = process.env.TWILIO_CONFIRMATION_CONTENT_SID;
const b2bLinkContentSid = process.env.TWILIO_B2B_LINK_CONTENT_SID;

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

/**
 * Send a B2B link proposal — Accept / Decline quick-reply template.
 * Falls back to sendText if the template SID is missing (e.g. before
 * the one-off template-creation script has been run).
 *
 * Returns the outbound Twilio MessageSid so callers can persist it on
 * linked_transactions.proposal_message_sid; inbound button replies
 * carry OriginalRepliedMessageSid which lets us route them back.
 */
async function sendB2BLinkProposal(toAddress, bodyText) {
  if (!client) {
    console.error('[twilio] cannot send B2B proposal: client not configured');
    return null;
  }
  if (!fromNumber) {
    console.error('[twilio] cannot send B2B proposal: from number not set');
    return null;
  }

  const to = normalizeWhatsappAddress(toAddress);

  if (!b2bLinkContentSid) {
    console.warn('[twilio] TWILIO_B2B_LINK_CONTENT_SID not set — falling back to plain text');
    return await sendText(toAddress, bodyText);
  }

  try {
    const message = await client.messages.create({
      from: fromNumber,
      to,
      contentSid: b2bLinkContentSid,
      contentVariables: JSON.stringify({ '1': bodyText }),
    });
    console.log(`[twilio] sent B2B proposal message_sid=${message.sid} to=${to}`);
    return message.sid;
  } catch (err) {
    console.error('[twilio] failed to send B2B proposal:', err.message);
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

module.exports = { sendConfirmation, sendB2BLinkProposal, sendText };
