/**
 * For /api/team/* routes: the active business, the signed-in person and
 * their role in it — or an error Response.
 *
 *   const ctx = await teamContext();
 *   if (ctx.error) return ctx.error;
 *   const { business, person, role } = ctx;
 */

const { getCurrentUser } = require('./current-user');
const { getSession } = require('./session');
const { query } = require('../db');
const { canManageTeam } = require('../team');

async function teamContext() {
  const business = await getCurrentUser();
  if (!business) return { error: Response.json({ ok: false, error: 'Not signed in.' }, { status: 401 }) };
  const { phone } = await getSession();
  const r = await query(
    `SELECT p.*, m.role FROM people p JOIN memberships m ON m.person_id = p.id
      WHERE p.phone = $1 AND m.user_id = $2`,
    [phone, business.id]
  );
  const person = r.rows[0];
  if (!person || !canManageTeam(person.role)) {
    return { error: Response.json({ ok: false, error: 'You can’t manage this team.' }, { status: 403 }) };
  }
  return { business, person, role: person.role };
}

/** TeamError → its status; anything else → 500. */
function teamErrorResponse(err, where) {
  if (err.status) return Response.json({ ok: false, error: err.message }, { status: err.status });
  console.error(`[${where}] failed:`, err);
  return Response.json({ ok: false, error: 'Something went wrong.' }, { status: 500 });
}

module.exports = { teamContext, teamErrorResponse };
