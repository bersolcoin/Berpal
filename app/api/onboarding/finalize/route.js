/**
 * POST /api/onboarding/finalize
 *
 * Called by the onboarding UI after the /api/onboarding progress stream
 * reports 'done'. Opens the freshly provisioned business (a streamed
 * response can't set cookies). Trusts nothing from the client: provisioning
 * stored the new business as this person's last-used one, and it must be a
 * business the OTP-verified session phone is a member of.
 */

const { getSession } = require('../../../../src/auth/session');
const { query } = require('../../../../src/db');
const { loadActiveBusiness } = require('../../../../src/auth/business');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const sess = await getSession();
  if (!sess.phone) {
    return Response.json({ ok: false, error: 'Not signed in.' }, { status: 401 });
  }

  const r = await query(`SELECT last_business_id FROM people WHERE phone = $1`, [sess.phone]);
  const business = await loadActiveBusiness(sess.phone, r.rows[0]?.last_business_id);
  const userId = business?.id;
  if (!userId) {
    return Response.json({ ok: false, error: 'Workspace not found. Please try again.' }, { status: 404 });
  }

  // Stamp the Magic identity (parked /api/auth/magic flow) if present.
  if (sess.magic_issuer) {
    await query(
      `UPDATE users SET magic_issuer = $1, wallet_address = $2 WHERE id = $3`,
      [sess.magic_issuer, sess.wallet_address || null, userId]
    );
  }

  sess.user_id = userId;
  sess.onboarded = true;
  delete sess.onboarding_started_at;
  await sess.save();

  return Response.json({ ok: true });
}
