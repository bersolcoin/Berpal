/**
 * POST /api/purchases — save a purchase from the web "New purchase" form.
 * Body: see src/web-forms/purchase.js. On success returns the ERPNext
 * Purchase Invoice name so the client can open its detail page.
 */

const { getCurrentUser } = require('../../../src/auth/current-user');
const { createPurchase } = require('../../../src/web-forms/purchase');
const erpnext = require('../../../src/erpnext');
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
    result = await createPurchase(user, erpnext.forUser(user), body);
  } catch (err) {
    console.error('[api/purchases] save failed:', err);
    // ERPNext validation messages are often HTML-wrapped — strip tags.
    const msg = String(err.message || 'Save failed').replace(/<[^>]+>/g, '').slice(0, 300);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
  if (!result?.ok) return Response.json(result || { ok: false, error: 'Save failed.' }, { status: 400 });

  revalidatePath('/(app)', 'layout');
  return Response.json(result);
}
