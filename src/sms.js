/**
 * Plain outbound SMS (not WhatsApp, not Verify codes) — used for team
 * invites. Twilio Verify can't send custom text, so this needs its own
 * sender: TWILIO_MESSAGING_SERVICE_SID (preferred) or TWILIO_SMS_NUMBER.
 *
 *   sendSms(to, body) → { sent: true, sid } | { sent: false, reason }
 *
 * Never throws — callers carry on (the invite exists either way).
 */

const twilio = require('twilio');

let _client = null;

async function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const service = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const from = process.env.TWILIO_SMS_NUMBER;
  if (!sid || !token) return { sent: false, reason: 'Twilio not configured' };
  if (!service && !from) return { sent: false, reason: 'No SMS sender configured' };
  try {
    if (!_client) _client = twilio(sid, token);
    const msg = await _client.messages.create({
      to,
      body,
      ...(service ? { messagingServiceSid: service } : { from }),
    });
    return { sent: true, sid: msg.sid };
  } catch (err) {
    console.error(`[sms] send to ${to} failed: ${err.code || ''} ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendSms };
