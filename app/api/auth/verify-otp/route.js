/**
 * POST /api/auth/verify-otp
 * Body: { phone, code }
 * On success: sets a session cookie; returns whether the user is provisioned
 * (existing user → ready) or new (→ /onboarding).
 */

const { verifyOtp } = require('../../../../src/auth/otp');
const { getSession } = require('../../../../src/auth/session');
const { query } = require('../../../../src/db');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizePhone(raw) {
  if (!raw) return null;
  return String(raw).trim().replace(/\s+/g, '');
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON.' }, { status: 400 });
  }

  const phone = normalizePhone(body.phone);
  const code = body.code ? String(body.code).trim() : null;

  if (!phone || !/^\+\d{8,15}$/.test(phone)) {
    return Response.json({ ok: false, error: 'Invalid phone.' }, { status: 400 });
  }
  if (!code) {
    return Response.json({ ok: false, error: 'Missing code.' }, { status: 400 });
  }

  const result = await verifyOtp(phone, code);
  if (!result.ok) {
    return Response.json(result, { status: 401 });
  }

  // Look up user — they may or may not be provisioned yet.
  const u = await query(
    `SELECT id, phone, display_name, erpnext_company FROM users WHERE phone = $1`,
    [phone]
  );
  const userRow = u.rows[0] || null;

  // Set session. If user is provisioned, link to their id. If not yet, stash
  // the phone so the onboarding endpoint can complete provisioning under it.
  // For un-onboarded users, also stamp onboarding_started_at — the
  // /onboarding page enforces a 30-minute window before forcing re-login.
  const sess = await getSession();
  sess.phone = phone;
  if (userRow && userRow.erpnext_company) {
    sess.user_id = userRow.id;
    sess.onboarded = true;
    delete sess.onboarding_started_at;
  } else {
    sess.user_id = userRow ? userRow.id : null;
    sess.onboarded = false;
    sess.onboarding_started_at = new Date().toISOString();
  }
  await sess.save();

  return Response.json({
    ok: true,
    onboarded: !!(userRow && userRow.erpnext_company),
    display_name: userRow?.display_name || null,
  });
}
