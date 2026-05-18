/**
 * POST /api/links/[id]/confirm — buyer accepts a proposed linked invoice.
 * Creates the mirror Purchase Invoice in the buyer's ERPNext and updates
 * linked_transactions.status='confirmed'. Same code path as the WhatsApp
 * "yes LINK-N" handler — just a different entry point.
 */

const { getSession } = require('../../../../../src/auth/session');
const { query } = require('../../../../../src/db');
const { confirmLink } = require('../../../../../src/links/linked-transactions');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_request, { params }) {
  const sess = await getSession();
  if (!sess.user_id) {
    return Response.json({ ok: false, error: 'Not signed in.' }, { status: 401 });
  }

  const { id: idParam } = await params;
  const id = parseInt(idParam, 10);
  if (!id) return Response.json({ ok: false, error: 'Invalid id.' }, { status: 400 });

  // Load full buyer user row for erpnext.forUser() inside confirmLink.
  const userRow = (await query(
    `SELECT id, phone, display_name, default_currency, reporting_currency,
            erpnext_company, erpnext_company_abbr,
            erpnext_api_key, erpnext_api_secret
       FROM users WHERE id = $1`,
    [sess.user_id]
  )).rows[0];
  if (!userRow) {
    return Response.json({ ok: false, error: 'User not found.' }, { status: 404 });
  }
  userRow.reporting_currency = userRow.reporting_currency || userRow.default_currency;

  const linkRow = (await query(
    `SELECT * FROM linked_transactions WHERE id = $1 AND buyer_user_id = $2`,
    [id, sess.user_id]
  )).rows[0];
  if (!linkRow) {
    return Response.json({ ok: false, error: 'Link not found.' }, { status: 404 });
  }
  if (linkRow.status !== 'pending_buyer_confirmation') {
    return Response.json(
      { ok: false, error: `Already ${linkRow.status.replace(/_/g, ' ')}.` },
      { status: 409 }
    );
  }

  const reply = await confirmLink(linkRow, userRow);
  // confirmLink returns a string for the WhatsApp path; here we just
  // need a JSON response that the client can react to.
  const fresh = (await query(
    `SELECT status, buyer_doc_name FROM linked_transactions WHERE id = $1`,
    [id]
  )).rows[0];

  if (fresh?.status !== 'confirmed') {
    return Response.json({ ok: false, error: reply || 'Could not confirm.' }, { status: 500 });
  }
  return Response.json({
    ok: true,
    buyer_doc_name: fresh.buyer_doc_name,
    message: reply,
  });
}
