const { query } = require('./db');
const { normalizeAddress } = require('./channels/address');

/**
 * users.phone holds the user's ADDRESS (src/channels/address.js): "+66…" for WhatsApp,
 * "line:U…" for LINE. Name kept for the existing callers.
 */
function normalizePhone(raw) {
  return normalizeAddress(raw);
}

async function findByPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const result = await query('SELECT * FROM users WHERE phone = $1', [normalized]);
  return result.rows[0] || null;
}

module.exports = { findByPhone, normalizePhone };
