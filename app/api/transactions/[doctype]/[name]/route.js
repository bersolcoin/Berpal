/**
 * DELETE /api/transactions/[doctype]/[name]
 *
 * Removes a transaction (Sales Invoice, Purchase Invoice, Payment Entry,
 * or Journal Entry) from the user's ERPNext Company. Handles the
 * cancel-then-delete sequence ERPNext requires for submitted docs:
 *
 *   docstatus=1 (Submitted)  → cancel first (auto-flags GL Entries as
 *                              cancelled, then deletes the doc)
 *   docstatus=0 (Draft)       → direct delete
 *   docstatus=2 (Cancelled)   → direct delete (cleanup of orphan)
 *
 * Auth: must be logged in. The per-user ERPNext client is scoped to
 * the caller's Company, so they can only delete records they own.
 */

const { getSession } = require('../../../../../src/auth/session');
const { query } = require('../../../../../src/db');
const erpnext = require('../../../../../src/erpnext');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED = new Set(['Sales Invoice', 'Purchase Invoice', 'Payment Entry', 'Journal Entry']);

export async function DELETE(_request, { params }) {
  const sess = await getSession();
  if (!sess.user_id) {
    return Response.json({ ok: false, error: 'Not signed in.' }, { status: 401 });
  }

  const { doctype: dtParam, name: nameParam } = await params;
  const doctype = decodeURIComponent(dtParam);
  const name = decodeURIComponent(nameParam);

  if (!ALLOWED.has(doctype)) {
    return Response.json({ ok: false, error: `Doctype "${doctype}" not deletable.` }, { status: 400 });
  }

  const userRow = (await query(
    `SELECT id, erpnext_company, erpnext_api_key, erpnext_api_secret
       FROM users WHERE id = $1`,
    [sess.user_id]
  )).rows[0];
  if (!userRow?.erpnext_api_key) {
    return Response.json({ ok: false, error: 'User has no ERPNext credentials.' }, { status: 400 });
  }
  const erp = erpnext.forUser(userRow);

  // Fetch current state so we know whether to cancel first.
  let doc;
  try {
    const r = await erp.getResource(doctype, name);
    doc = r.data;
  } catch (err) {
    if (err.status === 404) {
      return Response.json({ ok: false, error: 'Already gone.' }, { status: 404 });
    }
    throw err;
  }

  // Cancel if submitted. frappe.client.cancel is the proper REST entry-
  // point for cancellation (PUT docstatus=2 doesn't always trigger the
  // cancellation hooks that handle GL Entry cleanup).
  if (doc.docstatus === 1) {
    try {
      await erp.callMethodPost('frappe.client.cancel', { doctype, name });
    } catch (err) {
      console.error(`[txn-delete] cancel failed for ${doctype}/${name}:`, err.message);
      return Response.json(
        { ok: false, error: `Could not cancel: ${err.message}` },
        { status: 500 }
      );
    }
  }

  // Delete.
  try {
    await erp.deleteResource(doctype, name);
  } catch (err) {
    // ERPNext v16 keeps a cancelled voucher's (reversed) GL Entries as an
    // audit trail and refuses to delete the voucher itself. Cancelled is
    // the end state then — its effect on the books is gone and lists hide
    // docstatus=2 — so report success.
    if (/LinkExistsError/.test(err.message) && /GL Entry/.test(err.message)) {
      console.log(`[txn-delete] user_id=${sess.user_id} cancelled ${doctype}/${name} (kept as cancelled — GL audit trail)`);
      return Response.json({ ok: true, cancelled: true });
    }
    console.error(`[txn-delete] delete failed for ${doctype}/${name}:`, err.message);
    return Response.json(
      { ok: false, error: `Could not delete: ${err.message}` },
      { status: 500 }
    );
  }

  console.log(`[txn-delete] user_id=${sess.user_id} deleted ${doctype}/${name}`);
  return Response.json({ ok: true });
}
