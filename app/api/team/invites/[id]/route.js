/**
 * POST   /api/team/invites/:id  — text the invite again (when invite SMS is on)
 * DELETE /api/team/invites/:id  — cancel a waiting invite
 */

const { teamContext, teamErrorResponse } = require('../../../../../src/auth/team-access');
const { resendInvite, revokeInvite } = require('../../../../../src/team');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_request, { params }) {
  const ctx = await teamContext();
  if (ctx.error) return ctx.error;
  const { id } = await params;
  try {
    const { sms } = await resendInvite(ctx.business, parseInt(id, 10), ctx.person);
    return Response.json({ ok: true, sms });
  } catch (err) {
    return teamErrorResponse(err, 'api/team/invites');
  }
}

export async function DELETE(_request, { params }) {
  const ctx = await teamContext();
  if (ctx.error) return ctx.error;
  const { id } = await params;
  try {
    await revokeInvite(ctx.business.id, parseInt(id, 10));
    return Response.json({ ok: true });
  } catch (err) {
    return teamErrorResponse(err, 'api/team/invites');
  }
}
