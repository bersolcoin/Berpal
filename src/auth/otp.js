/**
 * Phone OTP via Twilio Verify. Twilio generates, sends (SMS), expires and
 * checks the code — we store nothing. Verify sends from Twilio's own
 * pre-registered senders, so no phone number / A2P registration is needed.
 *
 * Which countries can receive codes is controlled in Twilio Console →
 * Verify → Settings → Geo permissions (keep it to target markets — open
 * geo permissions invite SMS-pumping fraud).
 *
 * Rate limits are Verify's: max 5 sends per number per 10 min, max 5
 * check attempts per code, code valid 10 min.
 *
 * Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID.
 */

const twilio = require('twilio');

let _client = null;
function getVerifyService() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!sid || !token) throw new Error('Twilio credentials not configured');
  if (!serviceSid) throw new Error('TWILIO_VERIFY_SERVICE_SID not set');
  if (!_client) _client = twilio(sid, token);
  return _client.verify.v2.services(serviceSid);
}

// Twilio Verify error codes → user-facing copy.
// https://www.twilio.com/docs/api/errors
function friendlyError(err) {
  switch (err.code) {
    case 60200: return 'That phone number doesn’t look right.';
    case 60203: return 'Too many codes requested. Please wait a few minutes and try again.';
    case 60205: return 'This number can’t receive SMS. Please use a mobile number.';
    case 60410: return 'SMS to this country isn’t available yet.';
    case 60605: return 'SMS to this country isn’t available yet.';
    case 20404: return 'Code expired or already used. Request a new one.';
    case 60202: return 'Too many attempts. Request a new code.';
    default: return 'Could not process the code. Please try again.';
  }
}

async function sendOtp(phone) {
  if (!phone) throw new Error('phone required');
  try {
    const v = await getVerifyService().verifications.create({ to: phone, channel: 'sms' });
    console.log(`[otp] verify sent to ${phone} status=${v.status} sid=${v.sid}`);
    return { ok: true, channel: 'sms' };
  } catch (err) {
    console.error(`[otp] verify send failed (${err.code}): ${err.message}`);
    return { ok: false, error: friendlyError(err) };
  }
}

async function verifyOtp(phone, code) {
  if (!phone || !code) return { ok: false, error: 'Phone and code are required.' };
  try {
    const check = await getVerifyService().verificationChecks.create({
      to: phone,
      code: String(code).trim(),
    });
    if (check.status === 'approved') return { ok: true };
    return { ok: false, error: 'Incorrect code. Please try again.' };
  } catch (err) {
    console.error(`[otp] verify check failed (${err.code}): ${err.message}`);
    return { ok: false, error: friendlyError(err) };
  }
}

module.exports = { sendOtp, verifyOtp };
