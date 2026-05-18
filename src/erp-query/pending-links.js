/**
 * Inbox queries — pending linked_transactions for the current user as
 * the BUYER (i.e. invoices proposed by sellers, waiting for acceptance).
 */

const { query } = require('../db');

async function listPendingLinks(buyerUserId, { limit = 100 } = {}) {
  if (!buyerUserId) return [];
  const r = await query(
    `SELECT
       lt.id,
       lt.seller_doctype, lt.seller_doc_name,
       lt.currency, lt.total_amount, lt.items, lt.notes,
       lt.proposed_at,
       u.erpnext_company AS seller_company,
       u.display_name    AS seller_name,
       u.phone           AS seller_phone
     FROM linked_transactions lt
     JOIN users u ON u.id = lt.seller_user_id
     WHERE lt.buyer_user_id = $1
       AND lt.status = 'pending_buyer_confirmation'
     ORDER BY lt.proposed_at DESC
     LIMIT $2`,
    [buyerUserId, limit]
  );
  return r.rows.map((row) => ({
    id: row.id,
    sellerDoctype: row.seller_doctype,
    sellerDocName: row.seller_doc_name,
    currency: row.currency,
    totalAmount: Number(row.total_amount) || 0,
    items: safeParse(row.items),
    notes: row.notes,
    proposedAt: row.proposed_at,
    seller: {
      company: row.seller_company,
      name: row.seller_name,
      phone: row.seller_phone,
    },
  }));
}

async function countPendingLinks(buyerUserId) {
  if (!buyerUserId) return 0;
  const r = await query(
    `SELECT COUNT(*)::int AS n
       FROM linked_transactions
      WHERE buyer_user_id = $1
        AND status = 'pending_buyer_confirmation'`,
    [buyerUserId]
  );
  return r.rows[0]?.n || 0;
}

function safeParse(json) {
  try {
    return typeof json === 'string' ? JSON.parse(json) : (json || []);
  } catch {
    return [];
  }
}

module.exports = { listPendingLinks, countPendingLinks };
