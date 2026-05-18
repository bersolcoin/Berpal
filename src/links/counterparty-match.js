/**
 * Counterparty ↔ platform-user matching by phone number.
 *
 * When a seller creates a customer with a WhatsApp number that matches
 * another Berpal user's phone, we link them — this enables the dual-post
 * B2B flow (seller's Sales Invoice automatically proposes a Purchase
 * Invoice on the linked buyer's side after WhatsApp confirmation).
 *
 * Matching strategy: normalize both sides to bare digits with a leading +
 * (E.164-ish), then compare. Handles common formatting variants:
 *   "+66 838 883 866" ≈ "+66838883866" ≈ "+66-838-883-866"
 *
 * Always uses the OWNER side's phone numbers — we never expose other
 * users' contact details to a tenant.
 */

const { query } = require('../db');

function normalizePhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/^whatsapp:/i, '')
    .replace(/[^\d+]/g, '')
    .trim();
  if (!cleaned) return null;
  // If it starts with + keep it, otherwise leave as-is (the matching SQL
  // tries both forms). We don't auto-add + because that could mis-match
  // a national-format number to the wrong country code.
  return cleaned;
}

/**
 * Return the users.id of a platform user with this phone, or null.
 * Does NOT return any other PII — caller only needs the foreign-key ref.
 *
 * If selfUserId is provided, exclude that user (a customer cannot be
 * linked to its own owner — that would be a sale to oneself).
 */
async function findLinkedUserId(rawPhone, { selfUserId = null } = {}) {
  const normalized = normalizePhone(rawPhone);
  if (!normalized) return null;

  // Match exact, or with a stripped leading + on either side.
  const stripped = normalized.startsWith('+') ? normalized.slice(1) : normalized;
  const plussed = normalized.startsWith('+') ? normalized : `+${normalized}`;

  const r = await query(
    `SELECT id FROM users
       WHERE phone IN ($1, $2, $3)
         AND ($4::int IS NULL OR id <> $4)
       LIMIT 1`,
    [normalized, stripped, plussed, selfUserId]
  );
  return r.rows[0]?.id || null;
}

/**
 * After a counterparty has been cached for a given owner, attempt to
 * resolve a platform-user link by phone and persist the link FK.
 * Returns the linked_user_id (or null).
 */
async function linkCounterparty({ ownerUserId, counterpartyName, phone }) {
  if (!ownerUserId || !counterpartyName) return null;
  const linkedUserId = await findLinkedUserId(phone, { selfUserId: ownerUserId });
  if (!linkedUserId) return null;
  await query(
    `UPDATE counterparty_cache
       SET linked_user_id = $1, updated_at = $2
     WHERE owner_user_id = $3 AND name = $4 AND linked_user_id IS DISTINCT FROM $1`,
    [linkedUserId, new Date().toISOString(), ownerUserId, counterpartyName]
  );
  return linkedUserId;
}

module.exports = { normalizePhone, findLinkedUserId, linkCounterparty };
