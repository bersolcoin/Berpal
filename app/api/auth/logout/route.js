/**
 * POST /api/auth/logout — destroys the session cookie. Returns JSON; the
 * client redirects on success.
 */

const { destroySession } = require('../../../../src/auth/session');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  await destroySession();
  return Response.json({ ok: true });
}
