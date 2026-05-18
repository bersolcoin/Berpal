/**
 * Phone-based OTP. Generates a 6-digit code, hashes it with bcrypt, stores
 * the hash in `otp_attempts` with a 10-minute expiry, and sends the plain
 * code to the user via their preferred channel (WhatsApp / SMS / Verify).
 *
 * Channel abstraction:
 *   'whatsapp' (default): send via Twilio WhatsApp Sandbox or Business sender.
 *                         Only works for numbers that have joined our Sandbox
 *                         (or have an active session with our Business sender).
 *   'sms':                 send via Twilio SMS — works to any phone, paid.
 *
 * Rate limits:
 *   • Min 30s between OTP requests for the same phone.
 *   • Max 3 incorrect verify attempts per code; on the 4th, the code is invalidated.
 *
 * The `otp_attempts` table is created in src/db.js SCHEMA.
 */

const bcrypt = require('bcryptjs');
const { query } = require('../db');
const twilio = require('twilio');

const CODE_LENGTH = 6;
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MIN_RESEND_GAP_MS = 30 * 1000; // 30s
const MAX_VERIFY_ATTEMPTS = 3;

function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += Math.floor(Math.random() * 10);
  }
  return code;
}

function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Twilio credentials not configured');
  return twilio(sid, token);
}

function getFromAddress(channel) {
  if (channel === 'sms') {
    const num = process.env.TWILIO_SMS_NUMBER;
    if (!num) throw new Error('TWILIO_SMS_NUMBER not set for sms channel');
    return num;
  }
  // WhatsApp: prefer the env-appropriate sender
  const env = process.env.TWILIO_ENV || 'sandbox';
  const from =
    env === 'live'
      ? process.env.TWILIO_WHATSAPP_NUMBER_LIVE
      : process.env.TWILIO_WHATSAPP_NUMBER_SANDBOX || process.env.TWILIO_WHATSAPP_NUMBER;
  if (!from) throw new Error('Twilio WhatsApp sender not configured');
  return from;
}

function buildToAddress(phone, channel) {
  return channel === 'sms' ? phone : `whatsapp:${phone}`;
}

async function sendOtp(phone, { channel = 'whatsapp' } = {}) {
  if (!phone) throw new Error('phone required');

  // Rate limit: no more than one request per 30 seconds per phone
  const recent = await query(
    `SELECT created_at FROM otp_attempts
     WHERE phone = $1
       AND consumed_at IS NULL
     ORDER BY id DESC LIMIT 1`,
    [phone]
  );
  if (recent.rowCount > 0) {
    const last = new Date(recent.rows[0].created_at).getTime();
    if (Date.now() - last < MIN_RESEND_GAP_MS) {
      return { ok: false, error: 'Please wait a moment before requesting another code.' };
    }
  }

  // Generate + hash code
  const code = generateCode();
  const hash = await bcrypt.hash(code, 10);
  const now = new Date();
  const expires = new Date(now.getTime() + CODE_TTL_MS);

  await query(
    `INSERT INTO otp_attempts (phone, code_hash, attempts, expires_at, created_at)
     VALUES ($1, $2, 0, $3, $4)`,
    [phone, hash, expires.toISOString(), now.toISOString()]
  );

  // Send via chosen channel
  const client = getTwilioClient();
  const from = getFromAddress(channel);
  const to = buildToAddress(phone, channel);

  // For WhatsApp live mode: prefer approved Content Template (required by
  // WhatsApp for first-touch / out-of-window messages). Sandbox always uses
  // plain text — sandbox sender accepts freeform once the user has joined,
  // and crucially we DON'T want to fire an unapproved template even if the
  // SID is in .env (Meta approval pending). SMS channel never uses templates.
  const isLive = (process.env.TWILIO_ENV || 'sandbox') === 'live';
  const otpTemplateSid =
    channel === 'whatsapp' && isLive && process.env.TWILIO_OTP_CONTENT_SID;
  const plainBody = `🔐 Your Berpal login code: *${code}*\n\nExpires in 10 minutes. Don't share it with anyone.`;

  try {
    let msg;
    if (otpTemplateSid) {
      msg = await client.messages.create({
        from,
        to,
        contentSid: otpTemplateSid,
        contentVariables: JSON.stringify({ 1: code }),
      });
    } else {
      msg = await client.messages.create({ from, to, body: plainBody });
    }
    console.log(`[otp] sent code to ${phone} via ${channel}${otpTemplateSid ? ' (template)' : ' (plain)'} sid=${msg.sid}`);
    return { ok: true, channel, expires_at: expires.toISOString() };
  } catch (err) {
    console.error('[otp] send failed:', err.message);
    return { ok: false, error: `Could not send code: ${err.message}` };
  }
}

async function verifyOtp(phone, code) {
  if (!phone || !code) return { ok: false, error: 'Phone and code are required.' };

  const r = await query(
    `SELECT id, code_hash, attempts, expires_at, consumed_at
       FROM otp_attempts
      WHERE phone = $1 AND consumed_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [phone]
  );
  if (!r.rowCount) return { ok: false, error: 'No active code for this number. Request a new one.' };

  const row = r.rows[0];
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: 'Code expired. Request a new one.' };
  }
  if (row.attempts >= MAX_VERIFY_ATTEMPTS) {
    return { ok: false, error: 'Too many attempts. Request a new code.' };
  }

  const match = await bcrypt.compare(String(code).trim(), row.code_hash);
  if (!match) {
    await query(`UPDATE otp_attempts SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    const remaining = MAX_VERIFY_ATTEMPTS - (row.attempts + 1);
    return {
      ok: false,
      error: remaining > 0 ? `Incorrect code. ${remaining} tries left.` : 'Too many attempts. Request a new code.',
    };
  }

  // Match — mark consumed
  await query(`UPDATE otp_attempts SET consumed_at = $1 WHERE id = $2`, [new Date().toISOString(), row.id]);
  return { ok: true };
}

module.exports = { sendOtp, verifyOtp };
