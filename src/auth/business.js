/**
 * People ↔ businesses (see the people / memberships tables in src/db.js).
 *
 * The signed-in PERSON is identified by the SMS-verified phone in the
 * session (sess.phone). The ACTIVE BUSINESS is sess.user_id — a `users`
 * row. These helpers are the only place that decides which businesses a
 * person may open; set sess.user_id only from what they return.
 *
 *   ensurePerson(phone, { display_name, email, login }) → person row (created if new;
 *                                                  login: true stamps last_login_at)
 *   addMembership(personId, userId, role)         → link a business to a person
 *   listBusinesses(phone)                         → [{ id, name, abbr, role }], A–Z
 *   loadActiveBusiness(phone, userId)             → full users row, or null if not a member
 *   pickBusiness(phone)                           → business id to open at login (last used, else first)
 *   rememberBusiness(phone, userId)               → store the last opened business
 */

const { query } = require('../db');

async function ensurePerson(phone, { display_name = null, email = null, login = false } = {}) {
  const now = new Date().toISOString();
  const r = await query(
    `INSERT INTO people (phone, display_name, email, last_login_at, created_at, updated_at)
     VALUES ($1, $2, $3, $5, $4, $4)
     ON CONFLICT (phone) DO UPDATE SET
       display_name = COALESCE(people.display_name, EXCLUDED.display_name),
       email = COALESCE(people.email, EXCLUDED.email),
       last_login_at = COALESCE(EXCLUDED.last_login_at, people.last_login_at),
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [phone, display_name, email, now, login ? now : null]
  );
  return r.rows[0];
}

async function addMembership(personId, userId, role = 'owner') {
  await query(
    `INSERT INTO memberships (person_id, user_id, role, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (person_id, user_id) DO NOTHING`,
    [personId, userId, role, new Date().toISOString()]
  );
}

/** Businesses this person can open (provisioned ones only), A–Z. */
async function listBusinesses(phone) {
  if (!phone) return [];
  const r = await query(
    `SELECT u.id, u.erpnext_company AS name, u.erpnext_company_abbr AS abbr, m.role
       FROM people p
       JOIN memberships m ON m.person_id = p.id
       JOIN users u ON u.id = m.user_id
      WHERE p.phone = $1 AND u.erpnext_company IS NOT NULL
      ORDER BY lower(u.erpnext_company)`,
    [phone]
  );
  return r.rows;
}

/** The active business's full users row — only if this person is a member and it's provisioned. */
async function loadActiveBusiness(phone, userId) {
  if (!phone || !userId) return null;
  const r = await query(
    `SELECT u.*
       FROM users u
       JOIN memberships m ON m.user_id = u.id
       JOIN people p ON p.id = m.person_id
      WHERE u.id = $1 AND p.phone = $2`,
    [userId, phone]
  );
  const user = r.rows[0];
  if (!user || !user.erpnext_company || !user.erpnext_api_key || !user.erpnext_api_secret) return null;
  return user;
}

/** Business to open after login: the last one used if still a member, else the first A–Z. */
async function pickBusiness(phone) {
  const list = await listBusinesses(phone);
  if (!list.length) return null;
  const r = await query(`SELECT last_business_id FROM people WHERE phone = $1`, [phone]);
  const last = r.rows[0]?.last_business_id;
  return (list.find((b) => b.id === last) || list[0]).id;
}

async function rememberBusiness(phone, userId) {
  await query(`UPDATE people SET last_business_id = $2, updated_at = $3 WHERE phone = $1`, [
    phone,
    userId,
    new Date().toISOString(),
  ]);
}

module.exports = { ensurePerson, addMembership, listBusinesses, loadActiveBusiness, pickBusiness, rememberBusiness };
