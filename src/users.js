const { query } = require('./db');
const { normalizeAddress } = require('./channels/address');

// users.phone holds the user's ADDRESS (src/channels/address.js): "+66…" for WhatsApp, "line:U…"
// for LINE. normalizePhone IS normalizeAddress, under the name the existing callers use.
const normalizePhone = normalizeAddress;

async function findByPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const result = await query('SELECT * FROM users WHERE phone = $1', [normalized]);
  return result.rows[0] || null;
}

module.exports = { findByPhone, normalizePhone };
