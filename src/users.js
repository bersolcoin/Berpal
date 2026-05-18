const { query } = require('./db');

function normalizePhone(raw) {
  if (!raw) return null;
  return String(raw).replace(/^whatsapp:/i, '').trim();
}

async function findByPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const result = await query('SELECT * FROM users WHERE phone = $1', [normalized]);
  return result.rows[0] || null;
}

/**
 * Capture / refresh the user's display_name from WhatsApp's ProfileName field
 * (Twilio includes it in the inbound webhook payload). Idempotent — only
 * updates when the stored value is empty, so we don't overwrite a name the
 * user has explicitly set later.
 */
async function captureProfileName(userId, profileName) {
  if (!userId || !profileName) return;
  const trimmed = String(profileName).trim();
  if (!trimmed) return;
  await query(
    `UPDATE users SET display_name = $1, updated_at = $2
     WHERE id = $3 AND (display_name IS NULL OR display_name = '' OR display_name = 'Test User')`,
    [trimmed, new Date().toISOString(), userId]
  );
}

module.exports = { findByPhone, normalizePhone, captureProfileName };
