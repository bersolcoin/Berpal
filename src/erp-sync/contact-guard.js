/**
 * Phone-uniqueness guard for contacts.
 *
 * Within a single owner_user's contacts, the same phone number must
 * always point to the same logical contact. Phone is the strongest
 * identifier we have (it's what determines B2B linking too), so two
 * contacts sharing a phone would create ambiguity:
 *   - which contact does the linked B2B invoice route to?
 *   - which contact does an inbound payment from that number settle?
 *
 * Call findExistingContactByPhone() BEFORE creating a new contact with
 * a phone. If it returns a row whose name differs from what the user
 * is trying to use, throw / return an error so the LLM can surface it.
 */

const { query } = require('../db');
const { normalizePhone } = require('../links/counterparty-match');

/**
 * Returns the existing counterparty_cache row (any doctype) for this
 * owner that already uses this phone, or null. Tries with and without
 * a leading "+" to catch common formatting variants.
 */
async function findExistingContactByPhone(ownerUserId, phone) {
  if (!ownerUserId || !phone) return null;
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const stripped = normalized.startsWith('+') ? normalized.slice(1) : normalized;
  const plussed = normalized.startsWith('+') ? normalized : `+${normalized}`;

  const r = await query(
    `SELECT id, name, erpnext_name, erpnext_doctype, phone
       FROM counterparty_cache
      WHERE owner_user_id = $1
        AND phone IN ($2, $3, $4)
      ORDER BY id ASC
      LIMIT 1`,
    [ownerUserId, normalized, stripped, plussed]
  );
  return r.rows[0] || null;
}

/**
 * Higher-level guard. Returns:
 *   { ok: true } — safe to proceed (no phone, or phone is unused, or
 *                  matches the SAME contact name)
 *   { ok: false, conflictsWith } — phone already maps to a different
 *                                  contact; caller should surface to user.
 */
async function assertPhoneUnused(ownerUserId, contactName, phone) {
  if (!phone) return { ok: true };
  const existing = await findExistingContactByPhone(ownerUserId, phone);
  if (!existing) return { ok: true };
  if (sameName(existing.name, contactName)) return { ok: true };
  return { ok: false, conflictsWith: existing };
}

function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

module.exports = { findExistingContactByPhone, assertPhoneUnused };
