/**
 * POST /api/links/[id]/reject — buyer declines a proposed linked invoice.
 * No mirror is created. Seller gets a WhatsApp notification.
 */

const { getSession } = require('../../../../../src/auth/session');
const { query } = require('../../../../../src/db');
const { rejectLink } = require('../../../../../src/links/linked-transactions');

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

  const userRow = (await query(`SELECT id FROM users WHERE id = $1`, [sess.user_id])).rows[0];
  if (!userRow) {
    return Response.json({ ok: false, error: 'User not found.' }, { status: 404 });
  }

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

  const reply = await rejectLink(linkRow, userRow);
  return Response.json({ ok: true, message: reply });
}
