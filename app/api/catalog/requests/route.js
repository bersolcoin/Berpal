/**
 * POST /api/catalog/requests — ask us to add something to the catalog.
 * Body: { kind: 'category'|'variety'|'option'|'field', category_id?,
 *         field_key?, family?, value, note? }. category_id is required
 * except for kind 'category'.
 */

const { getCurrentUser } = require('../../../../src/auth/current-user');
const { requestStandard } = require('../../../../src/catalog');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, error: 'Not signed in.' }, { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON.' }, { status: 400 });
  }

  try {
    const req = await requestStandard(user, body?.category_id ?? null, body || {});
    console.log(`[catalog-request] user=${user.id} ${req.kind} ${req.field_key || ''} "${req.value}"`);
    return Response.json({ ok: true, request: req });
  } catch (err) {
    if (err.userMessage) return Response.json({ ok: false, error: err.userMessage }, { status: 400 });
    console.error('[api/catalog/requests] failed:', err);
    return Response.json({ ok: false, error: 'Could not send the request.' }, { status: 500 });
  }
}
