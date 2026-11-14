/**
 * POST /api/auth/magic
 * Header: Authorization: Bearer <DID token from magic.auth.loginWithSMS>
 * On success: sets the session cookie; returns whether the user is
 * provisioned (existing user → ready) or new (→ /onboarding).
 *
 * Replaces the Twilio-WhatsApp OTP pair (send-otp / verify-otp): Magic
 * sends the SMS and verifies the code; we only validate its token.
 */

const { verifyDidToken } = require('../../../../src/auth/magic');
const { getSession } = require('../../../../src/auth/session');
const { query } = require('../../../../src/db');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const auth = request.headers.get('authorization') || '';
  const didToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!didToken) {
    return Response.json({ ok: false, error: 'Missing login token.' }, { status: 400 });
  }

  let identity;
  try {
    identity = await verifyDidToken(didToken);
  } catch (err) {
    console.error('[auth/magic] token validation failed:', err.message);
    return Response.json({ ok: false, error: 'Login could not be verified. Please try again.' }, { status: 401 });
  }

  const phone = identity.phone;
  if (!phone || !/^\+\d{8,15}$/.test(phone)) {
    return Response.json({ ok: false, error: 'No verified phone number on this login.' }, { status: 400 });
  }

  // Match by Magic issuer first (stable id), then by phone (users created
  // before Magic, or a re-provisioned tenant). Keep the Magic fields fresh.
  const u = await query(
    `SELECT id, phone, display_name, erpnext_company FROM users
      WHERE magic_issuer = $1 OR phone = $2
      ORDER BY (magic_issuer = $1) DESC
      LIMIT 1`,
    [identity.issuer, phone]
  );
  const userRow = u.rows[0] || null;
  if (userRow) {
    await query(
      `UPDATE users SET magic_issuer = $1, wallet_address = COALESCE($2, wallet_address) WHERE id = $3`,
      [identity.issuer, identity.wallet_address, userRow.id]
    );
  }

  // Same session shape as the old OTP flow so /onboarding and the app
  // layout work unchanged. Magic fields ride along so onboarding can stamp
  // them on the user row it creates.
  const sess = await getSession();
  sess.phone = phone;
  sess.magic_issuer = identity.issuer;
  sess.wallet_address = identity.wallet_address;
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
