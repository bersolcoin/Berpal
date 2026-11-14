/**
 * POST /api/inventory/opening — add opening stock (lots the business holds
 * that didn't come from a purchase). Body: see src/web-forms/opening-stock.js.
 */

const { getCurrentUser } = require('../../../../src/auth/current-user');
const { createOpeningStock } = require('../../../../src/web-forms/opening-stock');
const erpnext = require('../../../../src/erpnext');
const { revalidatePath } = require('next/cache');

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

  let result;
  try {
    result = await createOpeningStock(user, erpnext.forUser(user), body);
  } catch (err) {
    console.error('[api/inventory/opening] failed:', err);
    const msg = String(err.message || 'Save failed').replace(/<[^>]+>/g, '').slice(0, 300);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
  if (!result.ok) return Response.json(result, { status: 400 });

  revalidatePath('/inventory');
  return Response.json(result);
}
