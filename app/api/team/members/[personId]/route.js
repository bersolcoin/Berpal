/**
 * PATCH  /api/team/members/:personId  { role }  — change a member's role
 * DELETE /api/team/members/:personId            — remove them from the business
 * Not the owner; you can't remove yourself.
 */

const { teamContext, teamErrorResponse } = require('../../../../../src/auth/team-access');
const { changeRole, removeMember } = require('../../../../../src/team');
const { getSession } = require('../../../../../src/auth/session');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(request, { params }) {
  const ctx = await teamContext();
  if (ctx.error) return ctx.error;
  const { personId } = await params;
  const body = await request.json().catch(() => ({}));
  try {
    await changeRole(ctx.business.id, parseInt(personId, 10), String(body.role || ''));
    return Response.json({ ok: true });
  } catch (err) {
    return teamErrorResponse(err, 'api/team/members');
  }
}

export async function DELETE(_request, { params }) {
  const ctx = await teamContext();
  if (ctx.error) return ctx.error;
  const { personId } = await params;
  const { phone } = await getSession();
  try {
    await removeMember(ctx.business.id, parseInt(personId, 10), phone);
    return Response.json({ ok: true });
  } catch (err) {
    return teamErrorResponse(err, 'api/team/members');
  }
}
