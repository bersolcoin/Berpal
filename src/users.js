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

module.exports = { findByPhone, normalizePhone };
