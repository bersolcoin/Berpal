/**
 * POST /api/todos/[id]/resolve — apply the user's answer to a pending TODO.
 *
 * Body shape is kind-specific. For unknown_item_purchase it's:
 *   {
 *     branch: 'open_stock' | 'purchased_paid' | 'purchased_credit' | 'skip',
 *     // branch-specific fields (unit_cost, supplier_name, purchase_date,
 *     // payment_account_code, wallet_name, due_date, opening_date, qty)
 *   }
 *
 * The kind's resolve() function validates the input and writes to ERPNext.
 * On ok=true the todo row is deleted server-side.
 */

const { getSession } = require('../../../../../src/auth/session');
const { query } = require('../../../../../src/db');
const { resolveTodo } = require('../../../../../src/todos');
const erpnext = require('../../../../../src/erpnext');
const { revalidatePath } = require('next/cache');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request, { params }) {
  const sess = await getSession();
  if (!sess.user_id) {
    return Response.json({ ok: false, error: 'Not signed in.' }, { status: 401 });
  }

  const { id: idParam } = await params;
  const todoId = parseInt(idParam, 10);
  if (!todoId) return Response.json({ ok: false, error: 'Invalid id.' }, { status: 400 });

  let userInput;
  try {
    userInput = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const userRow = (await query(
    `SELECT id, phone, display_name, default_currency, reporting_currency,
            erpnext_company, erpnext_company_abbr,
            erpnext_api_key, erpnext_api_secret, business_type
       FROM users WHERE id = $1`,
    [sess.user_id]
  )).rows[0];
  if (!userRow) {
    return Response.json({ ok: false, error: 'User not found.' }, { status: 404 });
  }
  userRow.reporting_currency = userRow.reporting_currency || userRow.default_currency;

  const erp = erpnext.forUser(userRow);
  const result = await resolveTodo({ user: userRow, erp, todoId, userInput });

  if (!result?.ok) {
    return Response.json(result || { ok: false, error: 'Resolution failed.' }, { status: 400 });
  }

  // Bust the server-component cache for the routes that show todo data:
  //   - the (app) layout (sidebar badge count)
  //   - the /todos list page
  //   - any /todos/[id] detail page (this one will 404 after delete, but
  //     keep the path purge for completeness)
  // Without this, router.push('/todos') re-renders from the cached layout
  // and the badge count stays stale.
  try {
    revalidatePath('/(app)', 'layout');
    revalidatePath('/todos');
  } catch (err) {
    console.warn('[api/todos/resolve] revalidatePath failed:', err.message);
  }

  return Response.json(result);
}
