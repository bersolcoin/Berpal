/**
 * POST /api/invites/:id  { accept: true | false, name? }
 * The invitee answers an invite sent to their (SMS-verified) number.
 * Accepting joins the business and opens it; `name` is the person's own
 * (required if we don't have one for them yet).
 *   → { ok, next: '/dashboard' | null }
 */

const { getSession } = require('../../../../src/auth/session');
const { respondToInvite } = require('../../../../src/team');
const { rememberBusiness } = require('../../../../src/auth/business');
const { teamErrorResponse } = require('../../../../src/auth/team-access');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request, { params }) {
  const sess = await getSession();
  if (!sess.phone) return Response.json({ ok: false, error: 'Not signed in.' }, { status: 401 });
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  try {
    const businessId = await respondToInvite(sess.phone, parseInt(id, 10), body.accept === true, body.name);
    if (!businessId) return Response.json({ ok: true, next: null });
    sess.user_id = businessId;
    sess.onboarded = true;
    delete sess.onboarding_started_at;
    await sess.save();
    await rememberBusiness(sess.phone, businessId);
    return Response.json({ ok: true, next: '/dashboard' });
  } catch (err) {
    return teamErrorResponse(err, 'api/invites');
  }
}
