/**
 * PATCH /api/catalog/roots/[id] — switch a catalog category on/off for this
 * business. Body: { enabled: boolean }. At least one category stays on.
 * (The catalog itself is admin-only; businesses can't edit it.)
 */

const { getCurrentUser } = require('../../../../../src/auth/current-user');
const { setCategoryEnabled } = require('../../../../../src/catalog');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(request, { params }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: 'Not signed in.' }, { status: 401 });
  const { id } = await params;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON.' }, { status: 400 });
  }

  try {
    await setCategoryEnabled(user, parseInt(id, 10), !!body?.enabled);
    return Response.json({ ok: true });
  } catch (err) {
    if (err.userMessage) return Response.json({ ok: false, error: err.userMessage }, { status: 400 });
    console.error('[api/catalog/roots] toggle failed:', err);
    return Response.json({ ok: false, error: 'Could not update the category.' }, { status: 500 });
  }
}
