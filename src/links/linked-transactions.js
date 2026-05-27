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
const { resolveOrCreateCustomer } = require('../erp-sync/customer');
const { resolvePartyAccount } = require('../erp-sync/party-account');
const { ensureGenericPurchaseItem, ensureGenericSalesItem } = require('../erp-sync/item');

function fmtMoney(n, ccy) {
  return `${ccy} ${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Render the WhatsApp proposal body for a linked_transactions row.
 * Used by both proposeLink (in-the-moment) and bindPendingByPhone
 * (catch-up after the buyer onboards).
 *
 * When sent via the b2b_link_proposal template, the buyer sees Accept /
 * Decline quick-reply buttons; the LINK-N footer is kept so sandbox
 * users (and any client where buttons fail to render) can fall back to
 * typing "yes LINK-N" / "no LINK-N".
 */
/**
 * Builds the proposal body. The direction flag flips the phrasing:
 *  - seller-initiated (initiatedByBuyer=false): "X sold you..."
 *      Payment line is from B's perspective: "received in cash" means
 *      A's books show cash received, so B is the one who paid out.
 *  - buyer-initiated (initiatedByBuyer=true):  "X bought from you..."
 *      Payment line is still from the responder's perspective: A paid
 *      from cash, so B (the seller / responder) received cash in.
 */
function buildProposalMessage({
  initiatorLabel,
  initiatedByBuyer = false,
  items,
  currency,
  totalAmount,
  paymentContext, // { type: 'cash'|'bank'|'card'|null, label?: string }
}) {
  const itemLines = (items || [])
    .map((it) => `• ${it.qty} × ${it.description || ''} @ ${fmtMoney(it.rate, currency)} = ${fmtMoney(it.amount, currency)}`)
    .join('\n');

  let paymentLine = '';
  if (paymentContext?.type === 'cash') {
    paymentLine = initiatedByBuyer
      ? `\nPayment: paid in cash${paymentContext.label ? ` (${paymentContext.label})` : ''}`
      : `\nPayment: received in cash${paymentContext.label ? ` (${paymentContext.label})` : ''}`;
  } else if (paymentContext?.type === 'bank' || paymentContext?.type === 'card') {
    const noun = paymentContext.type === 'card' ? 'card' : 'bank';
    paymentLine = initiatedByBuyer
      ? `\nPayment: paid via ${noun}${paymentContext.label ? ` (${paymentContext.label})` : ''}`
      : `\nPayment: received to ${noun}${paymentContext.label ? ` (${paymentContext.label})` : ''}`;
  } else if (paymentContext) {
    paymentLine = `\nPayment: on credit (no payment yet)`;
  }

  const verb = initiatedByBuyer ? 'bought from you' : 'sold you';
  return (
    `🔗 ${initiatorLabel} says they ${verb}:\n\n` +
    `${itemLines || `Amount: ${fmtMoney(totalAmount, currency)}`}\n` +
    `Total: ${fmtMoney(totalAmount, currency)}${paymentLine}`
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
/**
 * Park a linked_transactions row and (when the counterparty is on Berpal)
 * send a WhatsApp proposal.
 *
 * Symmetric across the two directions:
 *  - initiatorRole='seller' (legacy default): initiator just posted a Sales
 *    Invoice; we ask the buyer to accept and create a mirror Purchase Invoice.
 *  - initiatorRole='buyer': initiator just posted a Purchase Invoice; we
 *    ask the seller to accept and create a mirror Sales Invoice.
 *
 * The schema's seller_* and buyer_* columns always refer to the SI side
 * and the PI side respectively, regardless of who initiated. The
 * initiated_by_buyer flag drives the direction-specific branches in
 * confirmLink and the wallet-pick handler.
 */
async function proposeLink({
  initiatorUser,
  initiatorRole = 'seller',           // 'seller' | 'buyer'
  initiatorDoctype,                   // 'Sales Invoice' | 'Purchase Invoice'
  initiatorDocName,
  responderUserId = null,
  responderPhone = null,
  currency,
  totalAmount,
  items,
  notes = null,
  paidNow = false,                    // was money exchanged at time of post?
  paymentAccountCode = null,          // e.g. '1000'/'1100'/'2100' on initiator's side
  walletLabel = null,
  walletType = null,                  // 'cash' | 'bank' | 'card' | null (credit)
}) {
  if (!responderUserId && !responderPhone) {
    return null;
  }

  const initiatedByBuyer = initiatorRole === 'buyer';

  // Failsafe layer 1: if we only have a phone, try one last lookup
  // before parking — handles stale counterparty_cache.linked_user_id.
  if (!responderUserId && responderPhone) {
    try {
      const { findLinkedUserId } = require('./counterparty-match');
      const resolved = await findLinkedUserId(responderPhone, { selfUserId: initiatorUser.id });
      if (resolved) {
        responderUserId = resolved;
        console.log(`• [linked-txn] [${ts()}] fallback phone-lookup resolved responder user_id=${resolved} for ${responderPhone}`);
      }
    } catch (err) {
      console.warn(`• [linked-txn] [${ts()}] fallback phone-lookup failed: ${err.message}`);
    }
  }

  // Map initiator/responder to the schema's seller_* / buyer_* columns.
  // seller_* always = SI side, buyer_* always = PI side.
  // buyer_phone is overloaded to "responder's phone" in both directions
  // (it's the only contact-phone column we have, and it's what
  // bindPendingByPhone matches on for signup catch-up).
  let sellerUserId, sellerDoctype, sellerDocName;
  let buyerUserId, buyerDoctype, buyerDocName;
  const storedResponderPhone = responderPhone;
  if (initiatedByBuyer) {
    // Initiator IS the buyer (has the PI). Seller side is the responder.
    sellerUserId = responderUserId;
    sellerDoctype = null;             // SI gets created on responder's Accept
    sellerDocName = null;
    buyerUserId = initiatorUser.id;
    buyerDoctype = initiatorDoctype;  // 'Purchase Invoice' already on initiator
    buyerDocName = initiatorDocName;
  } else {
    sellerUserId = initiatorUser.id;
    sellerDoctype = initiatorDoctype; // 'Sales Invoice' already on initiator
    sellerDocName = initiatorDocName;
    buyerUserId = responderUserId;
    buyerDoctype = null;              // PI gets created on responder's Accept
    buyerDocName = null;
  }

  try {
    const now = new Date().toISOString();
    // Status stays 'pending_buyer_confirmation' for both directions — it
    // really means "pending the responder's confirmation". Renaming the
    // enum value would force a data migration; the current value is fine.
    const initialStatus = responderUserId ? 'pending_buyer_confirmation' : 'pending_buyer_signup';
    const r = await query(
      `INSERT INTO linked_transactions
         (seller_user_id, seller_doctype, seller_doc_name,
          buyer_user_id, buyer_phone, buyer_doctype, buyer_doc_name,
          currency, total_amount, items, notes,
          status, seller_paid_now,
          seller_payment_account_code, seller_wallet_label, seller_wallet_type,
          initiated_by_buyer,
          proposed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               $8, $9, $10, $11,
               $12, $13,
               $14, $15, $16,
               $17,
               $18, $18, $18)
       RETURNING id`,
      [
        sellerUserId,
        sellerDoctype,
        sellerDocName,
        buyerUserId,
        storedResponderPhone,
        buyerDoctype,
        buyerDocName,
        currency,
        totalAmount,
        JSON.stringify(items || []),
        notes,
        initialStatus,
        !!paidNow,
        paymentAccountCode,
        walletLabel,
        walletType,
        initiatedByBuyer,
        now,
      ]
    );
    const txnId = r.rows[0].id;
    const linkCode = `LINK-${txnId}`;

    if (!responderUserId) {
      console.log(`• [linked-txn] [${ts()}] parked ${linkCode} for unregistered phone ${responderPhone}`);
      return txnId;
    }

    // Responder is on Berpal — send the WhatsApp proposal.
    const responder = (await query(
      `SELECT id, phone, display_name FROM users WHERE id = $1`,
      [responderUserId]
    )).rows[0];
    if (!responder?.phone) {
      console.warn(`• [linked-txn] [${ts()}] ${linkCode} created but responder has no phone — won't be notified`);
      return txnId;
    }

    const initiatorLabel = initiatorUser.erpnext_company || initiatorUser.display_name || 'A Berpal user';
    const paymentContext = paidNow
      ? { type: walletType || 'cash', label: walletLabel }
      : { type: null };
    const body = buildProposalMessage({
      initiatorLabel,
      initiatedByBuyer,
      items,
      currency,
      totalAmount,
      paymentContext,
    });

    const messageSid = await twilio.sendB2BLinkProposal(responder.phone, body);
    if (messageSid) {
      await query(
        `UPDATE linked_transactions
           SET proposal_message_sid = $1, updated_at = $2
         WHERE id = $3`,
        [messageSid, new Date().toISOString(), txnId]
      );
    }
    console.log(`• [linked-txn] [${ts()}] proposed ${linkCode} to user_id=${responder.id} (${responder.phone}, initiated_by_buyer=${initiatedByBuyer})`);
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
  // Two-step bind so we can do direction-aware assignment:
  //  - seller-init rows: responder = buyer → set buyer_user_id
  //  - buyer-init rows:  responder = seller → set seller_user_id
  // We park with buyer_phone holding the responder's phone in both
  // directions, so the WHERE clause is the same; the SET differs by
  // initiated_by_buyer.
  const seller_init = await query(
    `UPDATE linked_transactions
       SET buyer_user_id = $1,
           status = 'pending_buyer_confirmation',
           updated_at = $2
     WHERE buyer_user_id IS NULL
       AND status = 'pending_buyer_signup'
       AND initiated_by_buyer = FALSE
       AND buyer_phone IN ($3, $4, $5)
     RETURNING id, seller_user_id, currency, total_amount, items,
               seller_paid_now, seller_wallet_label, seller_wallet_type,
               initiated_by_buyer`,
    [newUserId, new Date().toISOString(), phone, stripped, plussed]
  );
  const buyer_init = await query(
    `UPDATE linked_transactions
       SET seller_user_id = $1,
           status = 'pending_buyer_confirmation',
           updated_at = $2
     WHERE seller_user_id IS NULL
       AND status = 'pending_buyer_signup'
       AND initiated_by_buyer = TRUE
       AND buyer_phone IN ($3, $4, $5)
     RETURNING id, buyer_user_id, seller_user_id, currency, total_amount, items,
               seller_paid_now, seller_wallet_label, seller_wallet_type,
               initiated_by_buyer`,
    [newUserId, new Date().toISOString(), phone, stripped, plussed]
  );
  const allRows = [...seller_init.rows, ...buyer_init.rows];
  if (allRows.length === 0) return 0;

  console.log(`• [linked-txn] [${ts()}] bound ${allRows.length} pending invoice(s) to new user_id=${newUserId}`);

  // Catch-up WhatsApp send.
  for (const row of allRows) {
    try {
      const linkCode = `LINK-${row.id}`;
      // Initiator is the OTHER side of the just-bound responder. For a
      // seller-init row, initiator = seller_user_id. For a buyer-init
      // row, initiator = buyer_user_id (we never overwrote it).
      const initiatorUserId = row.initiated_by_buyer ? row.buyer_user_id : row.seller_user_id;
      const initiator = (await query(
        `SELECT id, phone, display_name, erpnext_company
           FROM users WHERE id = $1`,
        [initiatorUserId]
      )).rows[0];
      const initiatorLabel = initiator?.erpnext_company || initiator?.display_name || 'A Berpal user';
      const items = safeParseItems(row.items);
      const paymentContext = row.seller_paid_now
        ? { type: row.seller_wallet_type || 'cash', label: row.seller_wallet_label }
        : { type: null };
      const body = buildProposalMessage({
        initiatorLabel,
        initiatedByBuyer: !!row.initiated_by_buyer,
        items,
        currency: row.currency,
        totalAmount: row.total_amount,
        paymentContext,
      });
      const messageSid = await twilio.sendB2BLinkProposal(phone, body);
      if (messageSid) {
        await query(
          `UPDATE linked_transactions
             SET proposal_message_sid = $1, updated_at = $2
           WHERE id = $3`,
          [messageSid, new Date().toISOString(), row.id]
        );
      }
      console.log(`• [linked-txn] [${ts()}] catch-up sent ${linkCode} to user_id=${newUserId} (${phone})`);
    } catch (err) {
      console.warn(`• [linked-txn] [${ts()}] catch-up send failed for row id=${row.id}: ${err.message}`);
    }
  }

  return allRows.length;
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

/**
 * Parse a buyer-side inbound message for a link-proposal response.
 *
 * Matches:
 *  - Text fallback: "yes" / "no" with optional "LINK-N" suffix
 *  - Template buttons: exact "Accept" / "Decline" (the b2b_link_proposal
 *    template's button titles).
 *
 * Deliberately does NOT match "Confirm" / "Reject" — those are the seller
 * side's transaction_confirmation template buttons and must be left to
 * the LLM/save_transaction flow.
 */
function parseInboundLinkCommand(text) {
  if (!text) return null;
  const t = String(text).trim();
  const re = /^(yes|accept|no|decline)\s*(?:LINK-?(\d+))?\s*$/i;
  const m = t.match(re);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const id = m[2] ? Number(m[2]) : null;
  const action = ['yes', 'accept'].includes(verb) ? 'accept' : 'reject';
  return { action, linkId: id };
}

/**
 * Called by whatsapp.js BEFORE the LLM. Returns a reply string if the
 * inbound message was a link command we handled, otherwise null (so the
 * LLM gets to process it normally).
 *
 * `raw` is the Twilio webhook payload — used to read OriginalRepliedMessageSid
 * (Twilio includes it when a button is tapped) so we can route an "Accept" /
 * "Decline" tap back to the right linked_transactions row even if the buyer
 * has multiple pending links.
 */
async function tryHandleLinkCommand(user, body, raw = null) {
  const cmd = parseInboundLinkCommand(body);
  if (!cmd) return null;

  // Resolve target link in this priority:
  //  1. Explicit LINK-N in the text
  //  2. OriginalRepliedMessageSid from the Twilio webhook (button reply)
  //  3. Latest single pending row addressed to this responder
  //
  // The responder is whichever side is NOT the initiator:
  //   seller-init flow → responder = buyer_user_id
  //   buyer-init  flow → responder = seller_user_id
  // Encoded as: (initiated_by_buyer=FALSE AND buyer_user_id=$user)
  //          OR (initiated_by_buyer=TRUE  AND seller_user_id=$user)
  const RESPONDER_PRED = `(
    (initiated_by_buyer = FALSE AND buyer_user_id = $USER) OR
    (initiated_by_buyer = TRUE  AND seller_user_id = $USER)
  )`;
  let target;
  if (cmd.linkId) {
    target = (await query(
      `SELECT * FROM linked_transactions
         WHERE id = $1 AND ${RESPONDER_PRED.replace(/\$USER/g, '$2')}`,
      [cmd.linkId, user.id]
    )).rows[0];
    if (!target) {
      return `I don't see LINK-${cmd.linkId} pending for you.`;
    }
  } else if (raw?.OriginalRepliedMessageSid) {
    target = (await query(
      `SELECT * FROM linked_transactions
         WHERE proposal_message_sid = $1 AND ${RESPONDER_PRED.replace(/\$USER/g, '$2')}`,
      [raw.OriginalRepliedMessageSid, user.id]
    )).rows[0];
    if (!target) {
      console.log(`• [linked-txn] [${ts()}] button reply with unknown OriginalRepliedMessageSid=${raw.OriginalRepliedMessageSid}`);
    }
  }

  if (!target) {
    const pending = await query(
      `SELECT * FROM linked_transactions
         WHERE ${RESPONDER_PRED.replace(/\$USER/g, '$1')}
           AND status = 'pending_buyer_confirmation'
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

async function confirmLink(linkRow, responderUser) {
  try {
    const erp = erpnext.forUser(responderUser);
    const initiatedByBuyer = !!linkRow.initiated_by_buyer;

    // Identify the OTHER party (the initiator) so we know whose company
    // to materialize as a Customer/Supplier on the responder's side.
    const initiatorUserId = initiatedByBuyer ? linkRow.buyer_user_id : linkRow.seller_user_id;
    const initiator = (await query(
      `SELECT erpnext_company, phone FROM users WHERE id = $1`,
      [initiatorUserId]
    )).rows[0];
    if (!initiator?.erpnext_company) {
      throw new Error('initiator user row not found');
    }

    // Create the mirror doc on the responder's side. seller-init → PI;
    // buyer-init → SI. Both update the corresponding *_doc_name column.
    let mirrorDoctype, mirrorDocName, partyNameOnResponder;
    if (initiatedByBuyer) {
      const r = await createSalesInvoiceMirror({
        responderUser, erp, linkRow, initiatorCompany: initiator.erpnext_company, initiatorPhone: initiator.phone,
      });
      mirrorDoctype = 'Sales Invoice';
      mirrorDocName = r.docName;
      partyNameOnResponder = r.customerName;
      await query(
        `UPDATE linked_transactions
           SET status = 'confirmed',
               seller_doctype = $1,
               seller_doc_name = $2,
               responded_at = $3,
               updated_at = $3
         WHERE id = $4`,
        [mirrorDoctype, mirrorDocName, new Date().toISOString(), linkRow.id]
      );
    } else {
      const r = await createPurchaseInvoiceMirror({
        responderUser, erp, linkRow, initiatorCompany: initiator.erpnext_company, initiatorPhone: initiator.phone,
      });
      mirrorDoctype = 'Purchase Invoice';
      mirrorDocName = r.docName;
      partyNameOnResponder = r.supplierName;
      await query(
        `UPDATE linked_transactions
           SET status = 'confirmed',
               buyer_doctype = $1,
               buyer_doc_name = $2,
               responded_at = $3,
               updated_at = $3
         WHERE id = $4`,
        [mirrorDoctype, mirrorDocName, new Date().toISOString(), linkRow.id]
      );
    }

    console.log(`• [linked-txn] [${ts()}] LINK-${linkRow.id} confirmed → ${mirrorDoctype} ${mirrorDocName}`);

    let reply = `✅ Added to your books as ${mirrorDocName}.`;

    // Money exchanged at time of post? Either:
    //   seller-init: buyer needs to record paying out
    //   buyer-init:  seller needs to record receiving in
    // Same wallet-pick mechanism handles both via responder-wallet-pick.
    let postPEFlow = null;
    if (linkRow.seller_paid_now) {
      try {
        const fresh = (await query(
          `SELECT * FROM linked_transactions WHERE id = $1`,
          [linkRow.id]
        )).rows[0];
        const { handleAfterAccept } = require('./buyer-wallet-pick');
        postPEFlow = await handleAfterAccept({
          linkRow: fresh,
          responderUser,
          erp,
          partyName: partyNameOnResponder,
          mirrorDocName,
          initiatedByBuyer,
        });
      } catch (peErr) {
        console.warn(`• [linked-txn] [${ts()}]   wallet-pick handler failed: ${peErr.message}`);
        postPEFlow = { fallback: true };
      }
    }

    // Enqueue the fallback todo when the PE didn't post atomically.
    let followupTodoEnqueued = false;
    if (linkRow.seller_paid_now && !postPEFlow?.posted) {
      try {
        const { createTodo } = require('../todos');
        const todoId = await createTodo({
          userId: responderUser.id,
          kind: 'unrecorded_link_payment',
          payload: {
            link_id: linkRow.id,
            // payload field name kept as purchase_invoice_ref for back-compat
            // with existing /todos resolver; in buyer-init it holds the SI ref.
            purchase_invoice_ref: mirrorDocName,
            mirror_doctype: mirrorDoctype,
            party_label: partyNameOnResponder,
            seller_label: partyNameOnResponder, // legacy alias used by older code
            amount: Number(linkRow.total_amount) || 0,
            currency: linkRow.currency,
            initiated_by_buyer: initiatedByBuyer,
          },
          relatedDoctype: mirrorDoctype,
          relatedName: mirrorDocName,
        });
        if (todoId) {
          followupTodoEnqueued = true;
          console.log(`• [linked-txn] [${ts()}]   enqueued unrecorded_link_payment todo id=${todoId} (fallback)`);
        }
      } catch (todoErr) {
        console.warn(`• [linked-txn] [${ts()}]   could not enqueue payment todo: ${todoErr.message}`);
      }
    }

    // Notify the initiator that their proposal was accepted.
    notifyInitiatorOfResponse(initiatorUserId, linkRow, 'accepted', mirrorDocName).catch(() => {});

    if (postPEFlow?.posted) {
      const verb = initiatedByBuyer ? 'to' : 'from';
      reply += ` Payment ${verb} ${postPEFlow.walletLabel} recorded (${postPEFlow.posted}).`;
    } else if (postPEFlow?.asked) {
      // wallet-pick question is a separate send — don't duplicate it.
    } else if (followupTodoEnqueued) {
      const verb = initiatedByBuyer ? 'received to' : 'paid from';
      reply += ` Record which wallet you ${verb} at /todos.`;
    }
    return reply;
  } catch (err) {
    console.error(`[linked-txn] confirmLink LINK-${linkRow.id} failed:`, err.message);
    return `Sorry, I couldn't create the matching invoice in your books: ${err.message}. The link is still pending; try again or check with the other party.`;
  }
}

/**
 * seller-init mirror: create a Purchase Invoice on the buyer's books.
 */
async function createPurchaseInvoiceMirror({
  responderUser, erp, linkRow, initiatorCompany, initiatorPhone,
}) {
  const supplierName = await resolveOrCreateSupplier(responderUser, erp, initiatorCompany, {
    currency: linkRow.currency,
    phone: initiatorPhone,
  });
  const itemCode = await ensureGenericPurchaseItem(responderUser, erp);
  const creditTo = await resolvePartyAccount(erp, 'Payable', linkRow.currency);

  const items = JSON.parse(linkRow.items || '[]');
  const piItems = (items.length > 0 ? items : [{ qty: 1, rate: linkRow.total_amount, description: 'Linked invoice', amount: linkRow.total_amount }])
    .map((it) => ({
      item_code: itemCode,
      qty: Number(it.qty) || 1,
      rate: Number(it.rate) || 0,
      description: it.description || `From ${supplierName}`,
      delivered_by_supplier: 0,  // ERPNext controller guard, see history
    }));

  const today = new Date().toISOString().slice(0, 10);
  const payload = {
    supplier: supplierName,
    posting_date: today,
    due_date: today,
    currency: linkRow.currency,
    items: piItems,
    credit_to: creditTo,
    docstatus: 1,
  };
  if (linkRow.currency !== (responderUser.reporting_currency || responderUser.default_currency)) {
    payload.conversion_rate = 1;
  }
  const result = await erp.createPurchaseInvoice(payload);
  return { docName: result.data?.name, supplierName };
}

/**
 * buyer-init mirror: create a Sales Invoice on the seller's books.
 */
async function createSalesInvoiceMirror({
  responderUser, erp, linkRow, initiatorCompany, initiatorPhone,
}) {
  const customerName = await resolveOrCreateCustomer(responderUser, erp, initiatorCompany, {
    currency: linkRow.currency,
    phone: initiatorPhone,
  });
  const itemCode = await ensureGenericSalesItem(responderUser, erp);
  const debitTo = await resolvePartyAccount(erp, 'Receivable', linkRow.currency);

  const items = JSON.parse(linkRow.items || '[]');
  const siItems = (items.length > 0 ? items : [{ qty: 1, rate: linkRow.total_amount, description: 'Linked invoice', amount: linkRow.total_amount }])
    .map((it) => ({
      item_code: itemCode,
      qty: Number(it.qty) || 1,
      rate: Number(it.rate) || 0,
      description: it.description || `To ${customerName}`,
    }));

  const today = new Date().toISOString().slice(0, 10);
  const payload = {
    customer: customerName,
    posting_date: today,
    due_date: today,
    currency: linkRow.currency,
    items: siItems,
    debit_to: debitTo,
    docstatus: 1,
  };
  if (linkRow.currency !== (responderUser.reporting_currency || responderUser.default_currency)) {
    payload.conversion_rate = 1;
  }
  const result = await erp.createSalesInvoice(payload);
  return { docName: result.data?.name, customerName };
}

async function rejectLink(linkRow, responderUser) {
  await query(
    `UPDATE linked_transactions
       SET status = 'rejected',
           responded_at = $1,
           updated_at = $1
     WHERE id = $2`,
    [new Date().toISOString(), linkRow.id]
  );
  console.log(`• [linked-txn] [${ts()}] LINK-${linkRow.id} rejected by user_id=${responderUser.id}`);
  const initiatorUserId = linkRow.initiated_by_buyer ? linkRow.buyer_user_id : linkRow.seller_user_id;
  notifyInitiatorOfResponse(initiatorUserId, linkRow, 'rejected').catch(() => {});
  return `Got it — LINK-${linkRow.id} rejected. Nothing was added to your books.`;
}

async function notifyInitiatorOfResponse(initiatorUserId, linkRow, outcome, responderDoc = null) {
  try {
    const initiator = (await query(`SELECT phone FROM users WHERE id = $1`, [initiatorUserId])).rows[0];
    if (!initiator?.phone) return;
    // The initiator's doc name lives in seller_doc_name (seller-init) or
    // buyer_doc_name (buyer-init). The counterparty is the OTHER side.
    const initiatorDocName = linkRow.initiated_by_buyer ? linkRow.buyer_doc_name : linkRow.seller_doc_name;
    const counterpartyUserId = linkRow.initiated_by_buyer ? linkRow.seller_user_id : linkRow.buyer_user_id;
    const counterparty = counterpartyUserId
      ? (await query(`SELECT erpnext_company, display_name FROM users WHERE id = $1`, [counterpartyUserId])).rows[0]
      : null;
    const counterpartyLabel =
      counterparty?.erpnext_company || counterparty?.display_name || 'the counterparty';
    const noun = linkRow.initiated_by_buyer ? 'purchase' : 'invoice';
    const counterpartyRole = linkRow.initiated_by_buyer ? 'supplier' : 'buyer';
    const msg =
      outcome === 'accepted'
        ? `✅ Your ${noun} ${initiatorDocName} with ${counterpartyLabel} was accepted.`
        : `❌ Your ${noun} ${initiatorDocName} with ${counterpartyLabel} was declined by the ${counterpartyRole}. The ${noun} stays on your books — issue a credit note if you need to reverse it.`;
    await twilio.sendText(initiator.phone, msg);
  } catch (err) {
    console.warn(`[linked-txn] initiator notification failed: ${err.message}`);
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
