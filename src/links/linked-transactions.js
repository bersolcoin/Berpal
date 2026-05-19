/**
 * Dual-post B2B flow — seller's Sales Invoice optionally mirrors as a
 * Purchase Invoice on a linked buyer's side after their WhatsApp confirmation.
 *
 * Lifecycle:
 *   1. Seller posts Sales Invoice → proposeLink() inserts a
 *      linked_transactions row (status='pending_buyer_confirmation') and
 *      sends a WhatsApp proposal to the buyer.
 *   2. Buyer replies "yes LINK-N" / "no LINK-N" (or just "yes"/"no" if a
 *      single link is pending). The whatsapp.js handler intercepts the
 *      reply before the LLM via tryHandleLinkCommand().
 *   3. confirmLink() creates a mirror Purchase Invoice in the buyer's
 *      ERPNext, records buyer_doc_name, status='confirmed', then notifies
 *      the seller.
 *   4. rejectLink() / cancel paths handled the same way.
 *
 * Mirror creation is intentionally minimal: per-tenant generic GEN-PURCHASE
 * item, default per-currency Creditors account, no per-line expense
 * classification. The buyer can re-categorize later via the bot or web.
 */

const { query } = require('../db');
const { ts } = require('../log');
const twilio = require('../twilio-client');
const erpnext = require('../erpnext');
const { resolveOrCreateSupplier } = require('../erp-sync/supplier');
const { resolvePartyAccount } = require('../erp-sync/party-account');
const { ensureGenericPurchaseItem } = require('../erp-sync/item');

function fmtMoney(n, ccy) {
  return `${ccy} ${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Render the WhatsApp proposal body for a linked_transactions row.
 * Used by both proposeLink (in-the-moment) and bindPendingByPhone
 * (catch-up after the buyer onboards). Keep the shape stable — the
 * buyer-side reply parser only looks at the "LINK-N" code, not the
 * surrounding text.
 */
function buildProposalMessage({ sellerLabel, linkCode, items, currency, totalAmount }) {
  const itemLines = (items || [])
    .map((it) => `• ${it.qty} × ${it.description || ''} @ ${fmtMoney(it.rate, currency)} = ${fmtMoney(it.amount, currency)}`)
    .join('\n');
  return (
    `🔗 ${sellerLabel} says they sold you:\n\n` +
    `${itemLines || `Amount: ${fmtMoney(totalAmount, currency)}`}\n\n` +
    `Total: ${fmtMoney(totalAmount, currency)}\n\n` +
    `Reply "yes ${linkCode}" to add to your books as a purchase, or "no ${linkCode}" to decline.`
  );
}

/**
 * Insert a linked_transactions row + (when the buyer is already a Berpal
 * user) send a WhatsApp proposal asking them to accept / reject.
 *
 * Two paths:
 *  (A) buyerUserId provided → status='pending_buyer_confirmation', WhatsApp fires immediately
 *  (B) only buyerPhone provided → status='pending_buyer_signup', no message
 *      (sandbox can't reach un-joined numbers anyway). When that phone
 *      later signs up, bindPendingByPhone() upgrades the row to path A
 *      so it appears in the new user's /inbox.
 *
 * Fire-and-forget — failures are logged and don't bubble up to the seller's
 * normal "invoice saved" flow.
 */
async function proposeLink({
  sellerUser,
  sellerDoctype,
  sellerDocName,
  buyerUserId = null,
  buyerPhone = null,
  currency,
  totalAmount,
  items,        // [{ description, qty, rate, amount }]
  notes = null,
}) {
  if (!buyerUserId && !buyerPhone) {
    // Nothing to propose — no buyer at all. Don't write a row.
    return null;
  }

  try {
    const now = new Date().toISOString();
    const initialStatus = buyerUserId ? 'pending_buyer_confirmation' : 'pending_buyer_signup';
    const r = await query(
      `INSERT INTO linked_transactions
         (seller_user_id, seller_doctype, seller_doc_name,
          buyer_user_id, buyer_phone,
          currency, total_amount, items, notes,
          status, proposed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5,
               $6, $7, $8, $9,
               $10, $11, $11, $11)
       RETURNING id`,
      [
        sellerUser.id,
        sellerDoctype,
        sellerDocName,
        buyerUserId,
        buyerPhone,
        currency,
        totalAmount,
        JSON.stringify(items || []),
        notes,
        initialStatus,
        now,
      ]
    );
    const txnId = r.rows[0].id;
    const linkCode = `LINK-${txnId}`;

    if (!buyerUserId) {
      console.log(`• [linked-txn] [${ts()}] parked ${linkCode} for unregistered phone ${buyerPhone}`);
      return txnId;
    }

    // Buyer is on Berpal — send the WhatsApp proposal.
    const buyer = (await query(
      `SELECT id, phone, display_name FROM users WHERE id = $1`,
      [buyerUserId]
    )).rows[0];
    if (!buyer?.phone) {
      console.warn(`• [linked-txn] [${ts()}] ${linkCode} created but buyer has no phone — won't be notified`);
      return txnId;
    }

    const sellerLabel = sellerUser.erpnext_company || sellerUser.display_name || 'A Berpal user';
    const body = buildProposalMessage({
      sellerLabel,
      linkCode,
      items,
      currency,
      totalAmount,
    });

    await twilio.sendText(buyer.phone, body);
    console.log(`• [linked-txn] [${ts()}] proposed ${linkCode} to user_id=${buyer.id} (${buyer.phone})`);
    return txnId;
  } catch (err) {
    console.error('[linked-txn] proposeLink failed:', err.message);
    return null;
  }
}

/**
 * Called at the end of provisioning: claim any linked_transactions parked
 * for this user's phone and move them to the active queue so they show up
 * in /inbox. Returns the count of rows bound.
 */
async function bindPendingByPhone(newUserId, phone) {
  if (!newUserId || !phone) return 0;
  // Match exact + with/without leading + (same logic as findLinkedUserId).
  const stripped = phone.startsWith('+') ? phone.slice(1) : phone;
  const plussed = phone.startsWith('+') ? phone : `+${phone}`;
  const r = await query(
    `UPDATE linked_transactions
       SET buyer_user_id = $1,
           status = 'pending_buyer_confirmation',
           updated_at = $2
     WHERE buyer_user_id IS NULL
       AND status = 'pending_buyer_signup'
       AND buyer_phone IN ($3, $4, $5)
     RETURNING id, seller_user_id, currency, total_amount, items`,
    [newUserId, new Date().toISOString(), phone, stripped, plussed]
  );
  if (r.rowCount === 0) return 0;

  console.log(`• [linked-txn] [${ts()}] bound ${r.rowCount} pending invoice(s) to new user_id=${newUserId}`);

  // Catch-up WhatsApp send: the original proposeLink couldn't message
  // an unregistered phone, so do it now that the buyer is on Berpal.
  // Per row, fire-and-forget — a failed send shouldn't roll back the
  // bind (the row still shows in /inbox).
  for (const row of r.rows) {
    try {
      const linkCode = `LINK-${row.id}`;
      const seller = (await query(
        `SELECT id, phone, display_name, erpnext_company
           FROM users WHERE id = $1`,
        [row.seller_user_id]
      )).rows[0];
      const sellerLabel = seller?.erpnext_company || seller?.display_name || 'A Berpal user';
      const items = safeParseItems(row.items);
      const body = buildProposalMessage({
        sellerLabel,
        linkCode,
        items,
        currency: row.currency,
        totalAmount: row.total_amount,
      });
      await twilio.sendText(phone, body);
      console.log(`• [linked-txn] [${ts()}] catch-up sent ${linkCode} to user_id=${newUserId} (${phone})`);
    } catch (err) {
      console.warn(`• [linked-txn] [${ts()}] catch-up send failed for row id=${row.id}: ${err.message}`);
    }
  }

  return r.rowCount;
}

function safeParseItems(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Parse a buyer-side inbound message for an accept/reject command. */
function parseInboundLinkCommand(text) {
  if (!text) return null;
  const t = String(text).trim();
  const re = /^(yes|accept|confirm|no|reject|decline)\s*(?:LINK-?(\d+))?\s*$/i;
  const m = t.match(re);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const id = m[2] ? Number(m[2]) : null;
  const action = ['yes', 'accept', 'confirm'].includes(verb) ? 'accept' : 'reject';
  return { action, linkId: id };
}

/**
 * Called by whatsapp.js BEFORE the LLM. Returns a reply string if the
 * inbound message was a link command we handled, otherwise null (so the
 * LLM gets to process it normally).
 */
async function tryHandleLinkCommand(user, body) {
  const cmd = parseInboundLinkCommand(body);
  if (!cmd) return null;

  // Resolve target link: explicit id wins, else latest pending if only one.
  let target;
  if (cmd.linkId) {
    target = (await query(
      `SELECT * FROM linked_transactions
         WHERE id = $1 AND buyer_user_id = $2`,
      [cmd.linkId, user.id]
    )).rows[0];
    if (!target) {
      return `I don't see LINK-${cmd.linkId} pending for you.`;
    }
  } else {
    const pending = await query(
      `SELECT * FROM linked_transactions
         WHERE buyer_user_id = $1 AND status = 'pending_buyer_confirmation'
         ORDER BY id DESC LIMIT 2`,
      [user.id]
    );
    if (pending.rowCount === 0) {
      return null; // fall through to LLM
    }
    if (pending.rowCount > 1) {
      const codes = pending.rows.map((r) => `LINK-${r.id}`).join(', ');
      return `You have more than one pending link: ${codes}. Please specify (e.g. "yes ${codes.split(',')[0].trim()}").`;
    }
    target = pending.rows[0];
  }

  if (target.status !== 'pending_buyer_confirmation') {
    return `LINK-${target.id} is already ${target.status.replace(/_/g, ' ')}.`;
  }

  if (cmd.action === 'accept') {
    return await confirmLink(target, user);
  }
  return await rejectLink(target, user);
}

async function confirmLink(linkRow, buyerUser) {
  try {
    // Build buyer's ERPNext client. The full buyer user row was loaded by
    // findByPhone() in whatsapp.js, so it has the API creds.
    const erp = erpnext.forUser(buyerUser);

    // Resolve the seller as a Supplier in buyer's books.
    const sellerRow = (await query(
      `SELECT erpnext_company, phone FROM users WHERE id = $1`,
      [linkRow.seller_user_id]
    )).rows[0];
    if (!sellerRow?.erpnext_company) {
      throw new Error('seller user row not found');
    }
    const supplierName = await resolveOrCreateSupplier(buyerUser, erp, sellerRow.erpnext_company, {
      currency: linkRow.currency,
      phone: sellerRow.phone,
    });

    // Generic purchase item in buyer's namespace.
    const itemCode = await ensureGenericPurchaseItem(buyerUser, erp);

    // Per-currency Payable account.
    const creditTo = await resolvePartyAccount(erp, 'Payable', linkRow.currency);

    // Build items array.
    const items = JSON.parse(linkRow.items || '[]');
    const piItems = (items.length > 0 ? items : [{ qty: 1, rate: linkRow.total_amount, description: 'Linked invoice', amount: linkRow.total_amount }])
      .map((it) => ({
        item_code: itemCode,
        qty: Number(it.qty) || 1,
        rate: Number(it.rate) || 0,
        description: it.description || `From ${supplierName}`,
      }));

    const today = new Date().toISOString().slice(0, 10);
    const piPayload = {
      supplier: supplierName,
      posting_date: today,
      due_date: today,
      currency: linkRow.currency,
      items: piItems,
      credit_to: creditTo,
      docstatus: 1,
    };

    // Multi-currency Purchase Invoice needs conversion_rate.
    if (linkRow.currency !== (buyerUser.reporting_currency || buyerUser.default_currency)) {
      piPayload.conversion_rate = 1; // best-effort default — buyer can edit if they want a specific rate
    }

    const result = await erp.createPurchaseInvoice(piPayload);
    const buyerDoc = result.data?.name;

    await query(
      `UPDATE linked_transactions
         SET status = 'confirmed',
             buyer_doctype = 'Purchase Invoice',
             buyer_doc_name = $1,
             responded_at = $2,
             updated_at = $2
       WHERE id = $3`,
      [buyerDoc, new Date().toISOString(), linkRow.id]
    );

    console.log(`• [linked-txn] [${ts()}] LINK-${linkRow.id} confirmed → buyer doc ${buyerDoc}`);

    // Notify seller too — bonus, fire-and-forget.
    notifySellerOfResponse(linkRow.seller_user_id, linkRow, 'accepted', buyerDoc).catch(() => {});

    return `✅ Added to your books as ${buyerDoc}. The supplier (${supplierName}) is now in your suppliers list and the bill is in /transactions.`;
  } catch (err) {
    console.error(`[linked-txn] confirmLink LINK-${linkRow.id} failed:`, err.message);
    return `Sorry, I couldn't create the matching invoice in your books: ${err.message}. The link is still pending; try again or check with the seller.`;
  }
}

async function rejectLink(linkRow, buyerUser) {
  await query(
    `UPDATE linked_transactions
       SET status = 'rejected',
           responded_at = $1,
           updated_at = $1
     WHERE id = $2`,
    [new Date().toISOString(), linkRow.id]
  );
  console.log(`• [linked-txn] [${ts()}] LINK-${linkRow.id} rejected by user_id=${buyerUser.id}`);
  notifySellerOfResponse(linkRow.seller_user_id, linkRow, 'rejected').catch(() => {});
  return `Got it — LINK-${linkRow.id} rejected. Nothing was added to your books.`;
}

async function notifySellerOfResponse(sellerUserId, linkRow, outcome, buyerDoc = null) {
  try {
    const seller = (await query(`SELECT phone FROM users WHERE id = $1`, [sellerUserId])).rows[0];
    if (!seller?.phone) return;
    const msg =
      outcome === 'accepted'
        ? `✅ Your invoice ${linkRow.seller_doc_name} was accepted${buyerDoc ? ` (their ref: ${buyerDoc})` : ''}.`
        : `❌ Your invoice ${linkRow.seller_doc_name} was declined by the buyer. The invoice stays on your books — issue a credit note if you need to reverse it.`;
    await twilio.sendText(seller.phone, msg);
  } catch (err) {
    console.warn(`[linked-txn] seller notification failed: ${err.message}`);
  }
}

module.exports = {
  proposeLink,
  parseInboundLinkCommand,
  tryHandleLinkCommand,
  bindPendingByPhone,
  confirmLink,
  rejectLink,
};
