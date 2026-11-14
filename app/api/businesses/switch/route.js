/**
 * POST /api/businesses/switch  { id }
 * Opens another of the signed-in person's businesses (sidebar switcher).
 * Only businesses they're a member of; remembered for the next sign-in.
 *   → { ok: true }
 */

const { getSession } = require('../../../../src/auth/session');
const { loadActiveBusiness, rememberBusiness } = require('../../../../src/auth/business');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const sess = await getSession();
  if (!sess.phone) return Response.json({ ok: false, error: 'Not signed in.' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const id = parseInt(body.id, 10);
  const business = await loadActiveBusiness(sess.phone, id);
  if (!business) return Response.json({ ok: false, error: 'Business not found.' }, { status: 404 });

  sess.user_id = business.id;
  sess.onboarded = true;
  delete sess.onboarding_started_at;
  await sess.save();
  await rememberBusiness(sess.phone, business.id);
  return Response.json({ ok: true });
}
