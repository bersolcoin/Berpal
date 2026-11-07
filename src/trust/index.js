/**
 * Trust layer entry points.
 *   assess(user, draft)  → warning lines for the confirmation card (duplicates first, then
 *                          anomalies; at most MAX_WARNINGS). Called by request_confirmation.
 *   (src/trust/review.js markPosted → after a save: fingerprint row + accountant-review Comment.)
 *
 * Everything here reads Postgres only (no ERPNext call per card), and every caller treats a
 * failure as "no warnings" — the trust layer must never stop a user from saving.
 */
const counterparties = require('../counterparties');
const wallets = require('../wallets');
const duplicates = require('./duplicates');
const { anomalies, baseAmount, fmt, cardDate, STALE_DAYS } = require('./anomalies');
const { computeTotals } = require('../erp-sync/taxes');

const MAX_WARNINGS = 3;
// A contact added this recently (create_contact / a lookup earlier in this conversation) counts
// as new. "Created this turn" would make the flag vanish on the confirming turn and change the
// card's signature, so the window is a day instead.
const NEW_CONTACT_HOURS = 24;

function localToday(timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** The counterparty's display name as the card shows it (draft name, else the contact row). */
async function counterpartyOf(user, draft) {
  if (draft.counterparty_id) {
    const row = await counterparties.getById(user, draft.counterparty_id);
    if (row) return { name: row.name, row };
  }
  if (!draft.counterparty_name) return { name: null, row: null };
  return { name: draft.counterparty_name, row: await counterparties.findByName(user, draft.counterparty_name) };
}

async function walletIsCash(user, draft) {
  if (!draft.payment_account_id) return true; // no wallet → the company's generic Cash account
  const w = await wallets.getById(user, draft.payment_account_id);
  return !!w && w.type === 'Cash';
}

/** The fields a fingerprint is matched on, from a draft. */
async function fingerprintFields(user, draft) {
  const cp = await counterpartyOf(user, draft);
  return {
    cp,
    amount: computeTotals(draft).gross,
    currency: draft.currency || null,
    baseAmount: baseAmount(user, draft),
    transactionDate: draft.transaction_date ? String(draft.transaction_date).slice(0, 10) : null,
    counterpartyName: cp.name,
  };
}

/**
 * @returns {Promise<{ warnings: string[], receiptHash: string|null }>}
 */
async function assess(user, draft) {
  const receiptHash = draft.receipt_media_id ? await duplicates.receiptHash(user.id, draft.receipt_media_id) : null;
  const f = await fingerprintFields(user, draft);

  const dupLines = [];
  const { sameReceipt, similar } = await duplicates.findDuplicates(user.id, {
    ...f, receiptHash, direction: draft.direction || null, settles: draft.parent_invoice_name || null,
  });
  if (sameReceipt) dupLines.push(`This receipt was already recorded as ${sameReceipt.erpnext_name} on ${cardDate(sameReceipt.transaction_date)}`);
  if (similar) {
    dupLines.push(`Looks similar to ${similar.erpnext_name} (${fmt(similar.amount)} ${similar.currency}, ${cardDate(similar.transaction_date)})`);
  }

  const today = localToday(user.timezone);
  const utcToday = new Date().toISOString().slice(0, 10);
  const contactAgeH = f.cp.row && f.cp.row.created_at ? (Date.now() - Date.parse(f.cp.row.created_at)) / 3600000 : 0;
  const stats = {
    // The server defaults transaction_date to the UTC date; never call that "future".
    today: today > utcToday ? today : utcToday,
    medians: await duplicates.medianByDirection(user.id, duplicates.addDays(today, -STALE_DAYS)),
    walletIsCash: await walletIsCash(user, draft),
    newPayee: !!f.counterpartyName && !(await duplicates.hasPostedTo(user.id, f.counterpartyName))
      && (!f.cp.row || contactAgeH < NEW_CONTACT_HOURS),
  };
  return { warnings: [...dupLines, ...anomalies(user, draft, stats)].slice(0, MAX_WARNINGS), receiptHash };
}

module.exports = { assess, fingerprintFields, MAX_WARNINGS, localToday };
