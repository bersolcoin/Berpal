/**
 * PATCH /api/me/prefs — merge UI preferences for the signed-in PERSON
 * (people.ui_prefs — they follow you across your businesses).
 * Body: { inventory_columns?: string[], inventory_view?: 'table'|'cards' }.
 * Only known keys are accepted.
 */

const { getCurrentUser } = require('../../../../src/auth/current-user');
const { getSession } = require('../../../../src/auth/session');
const { query } = require('../../../../src/db');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEYS = {
  inventory_view: (v) => v === 'table' || v === 'cards',
  inventory_columns: (v) => Array.isArray(v) && v.length <= 60 && v.every((x) => typeof x === 'string' && /^[a-z_0-9]{1,40}$/.test(x)),
};

export async function PATCH(request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: 'Not signed in.' }, { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON.' }, { status: 400 });
  }
  const patch = {};
  for (const [k, valid] of Object.entries(KEYS)) {
    if (body?.[k] !== undefined) {
      if (!valid(body[k])) return Response.json({ ok: false, error: `Invalid ${k}.` }, { status: 400 });
      patch[k] = body[k];
    }
  }
  const sess = await getSession();
  await query(`UPDATE people SET ui_prefs = COALESCE(ui_prefs, '{}'::jsonb) || $1::jsonb WHERE phone = $2`, [
    JSON.stringify(patch),
    sess.phone,
  ]);
  return Response.json({ ok: true });
}
