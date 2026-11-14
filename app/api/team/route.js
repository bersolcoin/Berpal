/**
 * POST /api/team  { phone: '+E.164', role: 'admin'|'manager'|'staff' }
 * Invite a number to the active business. They accept after signing in
 * with that number (Join business on /onboarding). Sends an SMS only when
 * INVITE_SMS_ENABLED=true.
 *   → { ok, invite, sms: { sent, reason? } }
 */

import { parsePhoneNumberFromString } from 'libphonenumber-js';

const { teamContext, teamErrorResponse } = require('../../../src/auth/team-access');
const { inviteMember } = require('../../../src/team');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const ctx = await teamContext();
  if (ctx.error) return ctx.error;

  const body = await request.json().catch(() => ({}));
  const parsed = parsePhoneNumberFromString(String(body.phone || ''));
  if (!parsed || !parsed.isValid()) return Response.json({ ok: false, error: 'Enter a valid mobile number.' }, { status: 400 });

  try {
    const { invite, sms } = await inviteMember({
      business: ctx.business,
      phone: parsed.format('E.164'),
      role: String(body.role || ''),
      inviter: ctx.person,
    });
    return Response.json({ ok: true, invite: { id: invite.id, phone: invite.phone, role: invite.role }, sms });
  } catch (err) {
    return teamErrorResponse(err, 'api/team');
  }
}
