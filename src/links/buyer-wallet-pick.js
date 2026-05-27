/**
 * Buyer-side wallet pick for an accepted B2B link.
 *
 * After confirmLink posts the mirror Purchase Invoice, we still need to
 * post the matching Payment Entry — but only the buyer knows which of
 * their wallets the cash came out of. This module handles:
 *
 *   1. Listing the buyer's wallets that match the seller's payment
 *      context (same currency, same wallet type — cash vs bank vs card).
 *   2. Auto-resolving when there's exactly one match — post the PE
 *      atomically with the PI so the buyer sees "2 entries on Accept".
 *   3. Asking inline when there's 0 or 2+ matches. State is parked on
 *      linked_transactions.status = 'pending_buyer_wallet_pick' so the
 *      next inbound from the buyer routes here (not the LLM).
 *
 * The unrecorded_link_payment TODO remains the universal fallback —
 * enqueued only when the wallet-pick is genuinely ambiguous (count !== 1)
 * so the buyer can always finish from /todos.
 */

const { query } = require('../db');
const { ts } = require('../log');
const twilio = require('../twilio-client');
const paymentEntry = require('../erp-sync/payment-entry');
const { resolveWalletAccount } = require('../erp-sync/wallet');
const { recordOpeningBalance } = require('../erp-sync/opening-balance');
const exchange = require('../exchange');

const TYPE_TO_ERP = { cash: 'Cash', bank: 'Bank', card: 'Credit Card' };
const TYPE_TO_CODE = { cash: '1000', bank: '1100', card: '2100' };

/**
 * List the buyer's wallet leaves matching (currency, walletType).
 * Returns [{ name, account_name, account_type, currency }, ...].
 */
async function listBuyerWallets(erp, currency, walletType) {
  const erpType = TYPE_TO_ERP[walletType];
  if (!erpType) return [];
  const r = await erp.listResource('Account', {
    filters: [
      ['company', '=', erp.company],
      ['account_type', '=', erpType],
      ['account_currency', '=', currency],
      ['is_group', '=', 0],
    ],
    fields: ['name', 'account_name', 'account_type', 'account_currency'],
    limit: 25,
  });
  return r.data || [];
}

/**
 * Called from confirmLink AFTER the PI is created. Branches on wallet
 * count and either posts the PE inline or parks the row for a follow-up.
 *
 * Returns: { posted: PE name }  — auto-resolved
 *          { asked: 'choose' | 'name' }  — bot asked the buyer, state parked
 *          { fallback: true } — couldn't even ask (no payment context),
 *                                caller should fall back to the todo
 */
async function handleAfterAccept({
  linkRow,
  responderUser,
  erp,
  partyName,
  mirrorDocName,
  initiatedByBuyer = false,
}) {
  const walletType = linkRow.seller_wallet_type;
  const currency = linkRow.currency;
  if (!walletType || !TYPE_TO_ERP[walletType]) {
    return { fallback: true };
  }

  const wallets = await listBuyerWallets(erp, currency, walletType);

  // Exactly one match — post atomically.
  if (wallets.length === 1) {
    const w = wallets[0];
    const peResult = await postResponderPE({
      responderUser,
      erp,
      linkRow,
      partyName,
      mirrorDocName,
      walletAccountCode: TYPE_TO_CODE[walletType],
      walletName: w.account_name,
      initiatedByBuyer,
    });
    if (peResult?.ok) {
      const verb = initiatedByBuyer ? 'to' : 'from';
      console.log(`• [linked-txn] [${ts()}]   auto-posted PE ${peResult.erpnext_name} ${verb} ${w.account_name}`);
      return { posted: peResult.erpnext_name, walletLabel: w.account_name };
    }
    console.warn(`• [linked-txn] [${ts()}]   auto-PE failed, falling back to todo: ${peResult?.error}`);
    return { fallback: true };
  }

  // Park the row and ask the responder.
  const askKind = wallets.length === 0 ? 'name' : 'choose';
  const candidates = wallets.map((w) => ({
    name: w.name,
    label: w.account_name,
    code: TYPE_TO_CODE[walletType],
  }));
  await query(
    `UPDATE linked_transactions
       SET status = 'pending_buyer_wallet_pick',
           wallet_pick_candidates = $1,
           updated_at = $2
     WHERE id = $3`,
    [JSON.stringify(candidates), new Date().toISOString(), linkRow.id]
  );

  const question = buildWalletQuestion(walletType, currency, candidates, initiatedByBuyer);
  const messageSid = await twilio.sendText(responderUser.phone, question);
  if (messageSid) {
    await query(
      `UPDATE linked_transactions
         SET wallet_pick_message_sid = $1, updated_at = $2
       WHERE id = $3`,
      [messageSid, new Date().toISOString(), linkRow.id]
    );
  }
  return { asked: askKind, candidates };
}

function buildWalletQuestion(walletType, currency, candidates, initiatedByBuyer = false) {
  const inOut = initiatedByBuyer ? 'receive to' : 'pay from';
  const inOutPast = initiatedByBuyer ? 'receive' : 'pay';
  if (candidates.length === 0) {
    if (walletType === 'bank') {
      const verb = initiatedByBuyer ? 'receive payment to' : 'pay from';
      return `Which bank did you ${verb}? Reply with the bank name (e.g. "HSBC") and I'll set it up as a ${currency} bank account.`;
    }
    if (walletType === 'card') {
      // Card on the receive side is unusual but possible (merchant terminal).
      const verb = initiatedByBuyer ? 'receive payment to' : 'pay with';
      return `Which card did you ${verb}? Reply with the card name and I'll add it.`;
    }
    return `Which ${currency} cash wallet did you ${inOut}? Reply with the name and I'll set it up.`;
  }
  // 2+: text-numbered (simpler than list picker for V1).
  const numbered = candidates.map((c, i) => `${i + 1}. ${c.label}`).join('\n');
  const noun = walletType === 'bank' ? 'bank' : walletType === 'card' ? 'card' : 'wallet';
  const verb = initiatedByBuyer ? 'receive payment to' : 'pay from';
  return `Which ${noun} did you ${verb}?\n\n${numbered}\n\nReply with the number, or with the name. Reply "skip" to record later from /todos.`;
}

/**
 * Called from whatsapp.js BEFORE the LLM. Handles two follow-up states
 * for the same buyer:
 *   1. pending_buyer_wallet_pick — buyer answers "which wallet?"
 *   2. pending_buyer_opening_balance — buyer just typed a NEW wallet
 *      name in the 0-wallet branch; we created it and asked for its
 *      opening balance (mirrors the create_wallet tool's UX).
 *
 * Returns a reply string if handled, null to fall through to the LLM.
 */
async function tryHandleWalletPick(user, body, raw = null) {
  if (!body) return null;
  const text = String(body).trim();
  if (!text) return null;

  // Match the parked row across BOTH follow-up states. Prefer
  // OriginalRepliedMessageSid if it lines up.
  let row = null;
  if (raw?.OriginalRepliedMessageSid) {
    row = (await query(
      `SELECT * FROM linked_transactions
         WHERE wallet_pick_message_sid = $1 AND buyer_user_id = $2
           AND status IN ('pending_buyer_wallet_pick', 'pending_buyer_opening_balance')`,
      [raw.OriginalRepliedMessageSid, user.id]
    )).rows[0];
  }
  if (!row) {
    const r = await query(
      `SELECT * FROM linked_transactions
         WHERE buyer_user_id = $1
           AND status IN ('pending_buyer_wallet_pick', 'pending_buyer_opening_balance')
         ORDER BY id DESC LIMIT 1`,
      [user.id]
    );
    row = r.rows[0];
  }
  if (!row) return null;

  // ── State B: buyer is answering "what's the opening balance?" ───────
  if (row.status === 'pending_buyer_opening_balance') {
    return await handleOpeningBalanceReply(user, row, text);
  }

  // ── State A: buyer is picking which wallet to use ───────────────────
  const candidates = safeParseJSON(row.wallet_pick_candidates) || [];

  // "skip" → leave the todo (already enqueued by confirmLink), clear state.
  if (/^skip$/i.test(text)) {
    await query(
      `UPDATE linked_transactions
         SET status = 'confirmed', updated_at = $1
       WHERE id = $2`,
      [new Date().toISOString(), row.id]
    );
    return `Got it — you can record the payment from /todos when ready.`;
  }

  // Number reply → index into candidates.
  let pick = null;
  const numMatch = text.match(/^(\d+)$/);
  if (numMatch && candidates.length > 0) {
    const idx = Number(numMatch[1]) - 1;
    if (idx >= 0 && idx < candidates.length) {
      pick = { walletName: candidates[idx].label, accountCode: candidates[idx].code, isNew: false };
    } else {
      return `Reply with a number from 1 to ${candidates.length}, or with the wallet name. "skip" to record later.`;
    }
  }

  // Free-text reply → match against candidates by name (loose), else
  // treat as a brand-new wallet name (only valid when candidates is empty).
  if (!pick) {
    const { namesLooselyMatch } = require('./name-match');
    const match = candidates.find((c) => namesLooselyMatch(c.label, text));
    if (match) {
      pick = { walletName: match.label, accountCode: match.code, isNew: false };
    } else if (candidates.length === 0) {
      // 0-wallet case: brand-new wallet — create it now, ask balance next.
      if (/^\d+$/.test(text)) {
        return buildWalletQuestion(row.seller_wallet_type, row.currency, candidates);
      }
      const accountCode = TYPE_TO_CODE[row.seller_wallet_type] || '1100';
      pick = { walletName: text, accountCode, isNew: true };
    } else {
      // 2+ case, name didn't match any candidate — re-prompt.
      return buildWalletQuestion(row.seller_wallet_type, row.currency, candidates);
    }
  }

  // ── Branch A1: existing wallet (or 2+ pick) — post PE directly ──────
  if (!pick.isNew) {
    return await postPEAndClear(user, row, pick.walletName, pick.accountCode);
  }

  // ── Branch A2: brand-new wallet — create + ask opening balance ──────
  const erp = require('../erpnext').forUser(user);
  let walletErpName;
  try {
    walletErpName = await resolveWalletAccount(erp, pick.accountCode, row.currency, pick.walletName, user);
    console.log(`• [linked-txn] [${ts()}]   created wallet ${walletErpName} for buyer ${user.id}`);
  } catch (err) {
    console.error(`[linked-txn] new-wallet create failed: ${err.message}`);
    return `Sorry, I couldn't set up "${pick.walletName}": ${err.message}. Try a different name or "skip" to record later.`;
  }

  // Park the pending PE + opening-balance context on the row, then let
  // the caller send the follow-up question (single send path).
  const stash = [{
    label: pick.walletName,
    code: pick.accountCode,
    name: walletErpName,
  }];
  await query(
    `UPDATE linked_transactions
       SET status = 'pending_buyer_opening_balance',
           wallet_pick_candidates = $1,
           updated_at = $2
     WHERE id = $3`,
    [JSON.stringify(stash), new Date().toISOString(), row.id]
  );
  return `Wallet "${pick.walletName}" set up. What's the current balance on it? Reply with the amount in ${row.currency}, or "0" / "skip" to set later.`;
}

/**
 * Handle reply to the opening-balance question. Books opening JE (if >0),
 * then posts the PE for the linked invoice.
 */
async function handleOpeningBalanceReply(user, row, text) {
  const stash = safeParseJSON(row.wallet_pick_candidates) || [];
  const wallet = stash[0];
  if (!wallet) {
    // Shouldn't happen — stash got wiped. Clear and fall through.
    await query(
      `UPDATE linked_transactions SET status='confirmed', updated_at=$1 WHERE id=$2`,
      [new Date().toISOString(), row.id]
    );
    return `Something went wrong tracking the wallet. Please record the payment from /todos.`;
  }

  const skip = /^(skip|0)$/i.test(text);
  let openingBalance = 0;
  if (!skip) {
    const cleaned = text.replace(/[,\s]/g, '');
    const n = Number(cleaned);
    if (!Number.isFinite(n) || n < 0) {
      return `Reply with the current balance as a number (e.g. "5000"), or "0" / "skip" to set later.`;
    }
    openingBalance = n;
  }

  const erp = require('../erpnext').forUser(user);

  // Book opening balance JE if > 0. Use the same helper that create_wallet
  // / provisionTenant use, so multi-currency exchange logic is consistent.
  if (openingBalance > 0) {
    try {
      let rate = null;
      const reporting = user.reporting_currency || 'THB';
      if (row.currency !== reporting) {
        const fx = await exchange.fetchRate(row.currency, reporting, null);
        if (!fx?.rate) {
          return `Couldn't fetch FX rate to book the opening balance — try again, or reply "skip" to set it later.`;
        }
        rate = fx.rate;
      }
      await recordOpeningBalance(user, erp, {
        walletErpName: wallet.name,
        walletCurrency: row.currency,
        amount: openingBalance,
        exchangeRate: rate,
      });
      console.log(`• [linked-txn] [${ts()}]   opening balance ${openingBalance} ${row.currency} booked for ${wallet.name}`);
    } catch (err) {
      console.error(`[linked-txn] opening-balance JE failed: ${err.message}`);
      return `Couldn't book the opening balance: ${err.message}. Reply "skip" to skip and record the payment anyway.`;
    }
  }

  // Now post the PE for the linked invoice.
  const peReplyPrefix = openingBalance > 0
    ? `Opening balance ${openingBalance} ${row.currency} recorded. `
    : '';
  const result = await postPEAndClear(user, row, wallet.label, wallet.code, peReplyPrefix);
  return result;
}

/**
 * Common tail used by every wallet-pick branch. Posts the PE in the
 * correct direction (expense for seller-init, income for buyer-init),
 * deletes the fallback todo, clears link state.
 */
async function postPEAndClear(user, row, walletName, walletAccountCode, replyPrefix = '') {
  const initiatedByBuyer = !!row.initiated_by_buyer;
  const mirrorDocName = initiatedByBuyer ? row.seller_doc_name : row.buyer_doc_name;
  const partyName = await resolveResponderCounterpartyLabel(row);
  const peResult = await postResponderPE({
    responderUser: user,
    erp: require('../erpnext').forUser(user),
    linkRow: row,
    partyName,
    mirrorDocName,
    walletAccountCode,
    walletName,
    initiatedByBuyer,
  });

  if (!peResult?.ok) {
    return `Sorry, I couldn't record the payment from ${walletName}: ${peResult?.error || 'unknown error'}. You can retry from /todos.`;
  }

  // Delete the fallback unrecorded_link_payment todo — now satisfied.
  // Todos use DELETE on resolve, per src/todos/index.js.
  try {
    await query(
      `DELETE FROM todos
         WHERE kind = 'unrecorded_link_payment'
           AND user_id = $1
           AND related_name = $2`,
      [user.id, mirrorDocName]
    );
  } catch (err) {
    console.warn(`• [linked-txn] [${ts()}]   couldn't clear fallback todo: ${err.message}`);
  }

  await query(
    `UPDATE linked_transactions
       SET status = 'confirmed', updated_at = $1
     WHERE id = $2`,
    [new Date().toISOString(), row.id]
  );

  const verb = initiatedByBuyer ? 'to' : 'from';
  return `${replyPrefix}✅ Recorded payment ${peResult.erpnext_name} ${verb} ${walletName}.`;
}

/**
 * The party recorded on the PE — supplier when responder is buyer,
 * customer when responder is seller. Pulled from the initiator's company.
 */
async function resolveResponderCounterpartyLabel(linkRow) {
  const initiatorUserId = linkRow.initiated_by_buyer ? linkRow.buyer_user_id : linkRow.seller_user_id;
  if (!initiatorUserId) {
    return linkRow.initiated_by_buyer ? 'Customer' : 'Supplier';
  }
  const r = await query(`SELECT erpnext_company FROM users WHERE id = $1`, [initiatorUserId]);
  return r.rows[0]?.erpnext_company || (linkRow.initiated_by_buyer ? 'Customer' : 'Supplier');
}

async function postResponderPE({
  responderUser,
  erp,
  linkRow,
  partyName,
  mirrorDocName,
  walletAccountCode,
  walletName,
  initiatedByBuyer = false,
}) {
  const peDraft = {
    transaction_type: 'payment',
    direction: initiatedByBuyer ? 'income' : 'expense',
    amount: Number(linkRow.total_amount) || 0,
    currency: linkRow.currency,
    counterparty_name: partyName,
    payment_account_code: walletAccountCode,
    wallet_name: walletName,
    parent_invoice_ref: mirrorDocName,
    transaction_date: new Date().toISOString().slice(0, 10),
  };
  return await paymentEntry.save(responderUser, erp, peDraft);
}

function safeParseJSON(s) {
  if (!s) return null;
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

module.exports = {
  handleAfterAccept,
  tryHandleWalletPick,
  listBuyerWallets,
};
