/**
 * The confirmation card's lines, built server-side from the draft so the model only copies them.
 * Left to the model, labels drifted from the draft (e.g. "Cash → Meals & Entertainment" on a
 * Travel draft). Used by request_confirmation; the prompt says to render `lines` verbatim.
 *
 * Arrow convention (ACCOUNT ARROW DIRECTIONS in the system prompt): "<credit side> → <debit side>".
 */
const wallets = require('../wallets');
const counterparties = require('../counterparties');
const { companyCurrency, computeDueDate, friendlyAccountName, round2 } = require('../erp-sync/common');
const { computeTotals, vatTreatment } = require('../erp-sync/taxes');

const WARNING_HEADER = '⚠ Please check before confirming:';

// Our category codes (the CHART OF ACCOUNTS / CATEGORIZATION RULES in the prompt) → card names.
const CATEGORY_NAMES = {
  1000: 'Cash', 1100: 'Bank', 1200: 'Accounts Receivable', 1400: 'Other Receivables',
  2000: 'Accounts Payable', 2100: 'Credit Card', 2200: 'Other Payables', 3200: 'Opening Balance Equity',
  4000: 'Sales Revenue', 4100: 'Service Revenue', 4900: 'Other Income',
  5000: 'Cost of Goods Sold', 5010: 'Cutting & treatment fees (added to stone cost)', 5100: 'Meals & Entertainment', 5200: 'Travel', 5210: 'Vehicle Expenses',
  5300: 'Office Supplies', 5350: 'Insurance', 5400: 'Rent', 5500: 'Utilities', 5550: 'Telephone & Internet',
  5600: 'Software & Subscriptions', 5700: 'Professional Services', 5800: 'Marketing & Advertising',
  5900: 'Other Expenses', 5950: 'Bank Charges & Fees',
};

function categoryName(code, direction) {
  if (code != null && CATEGORY_NAMES[code]) return CATEGORY_NAMES[code];
  return direction === 'income' ? 'Other Income' : 'Other Expenses';
}

/** 1234 → "1,234"; 172.9 → "172.90". */
function fmt(n) {
  const v = round2(Number(n) || 0);
  return Number.isInteger(v)
    ? v.toLocaleString('en-US')
    : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Rates keep their precision but show at least 2 decimals: 32.5 → "32.50", 36.4123 → "36.4123". */
function fmtRate(r) {
  const s = String(Number(r));
  const dp = (s.split('.')[1] || '').length;
  return Number(r).toFixed(Math.max(2, dp));
}

const isoToCard = (d) => (d ? String(d).slice(0, 10).replace(/-/g, '/') : '');

const TYPE_LABELS = {
  invoice_issued: 'Invoice Sent', bill_received: 'Bill Received', payment: 'Payment',
  advance_given: 'Advance Out', advance_received: 'Advance In',
};

function typeLabel(draft) {
  const tt = draft.transaction_type || 'cash';
  if (draft.direction === 'transfer') return 'Transfer';
  if (TYPE_LABELS[tt]) return TYPE_LABELS[tt];
  if (String(draft.category_code) === '3200') return 'Opening Balance';
  return draft.direction === 'income' ? 'Income' : 'Expense';
}

// No wallet (wallet_skipped) posts to the company's generic Cash account.
async function walletName(user, id) {
  if (!id) return 'Cash';
  const w = await wallets.getById(user, id);
  return (w && (w.name || friendlyAccountName(w.erpnext_account))) || 'Cash';
}

/** The parent document a payment settles, from ERPNext (best effort: null on any failure). */
async function parentDoc(getErp, draft) {
  if (!draft.parent_invoice_name || !getErp) return null;
  try {
    const doctype = draft.parent_invoice_doctype
      || (/PINV/.test(draft.parent_invoice_name) ? 'Purchase Invoice' : /JV/.test(draft.parent_invoice_name) ? 'Journal Entry' : 'Sales Invoice');
    const r = await getErp().getResource(doctype, draft.parent_invoice_name);
    return r && r.data ? { doctype, ...r.data } : null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{ type_label, account_line, amount_line, due_line, settles_line, net_vat_lines, lines }>}
 *   lines: the whole card in order (Date, Amount, items, Net/VAT, WHT, Type, Account,
 *   Counterparty, Due, Settles, Note, then any ⚠ trust warnings); empty fields are left out.
 *   lineFor(item, index): a caller that words some item lines itself (lots/card.js: one line per
 *   gem lot) returns the line, or several, for those; null leaves the line as it is.
 */
async function buildCard(user, draft, getErp = null, { lineFor = null } = {}) {
  const tt = draft.transaction_type || 'cash';
  const cur = draft.currency;
  const t = computeTotals(draft);
  const rc = companyCurrency(user);
  const rate = Number(draft.exchange_rate) > 0 ? Number(draft.exchange_rate) : null;

  const doc = tt === 'payment' ? await parentDoc(getErp, draft) : null;
  let cp = draft.counterparty_name || null;
  if (draft.counterparty_id) {
    const row = await counterparties.getById(user, draft.counterparty_id);
    if (row) cp = row.name;
  }
  if (!cp && doc) cp = doc.customer_name || doc.supplier_name || doc.customer || doc.supplier || null;
  const party = cp || 'counterparty';

  // A foreign amount with no rate yet shows as-is — never as if converted at 1.00.
  const amount_line = cur && cur !== rc && rate
    ? `Amount: ${fmt(t.gross * rate)} ${rc} (${fmt(t.gross)} ${cur} @ ${fmtRate(rate)})`
    : `Amount: ${fmt(t.gross)} ${cur}${cur && cur !== rc ? ' (no exchange rate yet)' : ''}`;

  const own = (draft.items || []).map((it, i) => (lineFor && it ? lineFor(it, i) : null));
  const itemLines = (Array.isArray(draft.items) && draft.items.length > 1) || (draft.items || []).some((it, i) => it && (it.item_code || own[i]))
    ? draft.items.flatMap((it, i) => {
      if (own[i]) return own[i];
      const qty = it.qty == null ? 1 : Number(it.qty);
      const what = [it.item_code, it.description].filter(Boolean).join(' ');
      return `- ${qty === 1 ? '' : `${qty} × `}${what} @ ${fmt(it.rate)}`;
    })
    : [];

  const net_vat_lines = [];
  if (t.vat > 0) {
    const claim = vatTreatment(user, draft) === 'non_claimable' ? ' (not claimable)' : '';
    net_vat_lines.push(`Net: ${fmt(t.net)} ${cur} / VAT ${Number(draft.tax_rate)}%: ${fmt(t.vat)} ${cur}${claim}`);
  }
  if (t.wht > 0) {
    net_vat_lines.push(`WHT ${Number(draft.wht_rate)}% ${draft.wht_form}: ${fmt(t.wht)} ${cur} (pay ${party} ${fmt(t.due)} ${cur})`);
  }

  const category = categoryName(draft.category_code, draft.direction);
  const wallet = await walletName(user, draft.payment_account_id);
  let account_line;
  if (draft.direction === 'transfer') {
    account_line = `${wallet} → ${await walletName(user, draft.transfer_destination_account_id)}`;
  } else if (tt === 'invoice_issued') {
    account_line = `${category} → Receivable from ${party}`;
  } else if (tt === 'bill_received') {
    // A coded stone or a gem lot (items[].lot) goes into stock, whatever the category says.
    const stock = (draft.items || []).some((it) => it && (it.item_code || (it.lot && typeof it.lot === 'object')));
    account_line = `${stock ? 'Inventory' : category} → Payable to ${party}`;
  } else if (tt === 'payment') {
    account_line = draft.direction === 'income' ? `Receivable from ${party} → ${wallet}` : `${wallet} → Payable to ${party}`;
  } else if (tt === 'advance_given') {
    account_line = `${wallet} → Receivable from ${party}`;
  } else if (tt === 'advance_received') {
    account_line = `Payable to ${party} → ${wallet}`;
  } else if (String(draft.category_code) === '3200') {
    account_line = `Opening Balance → ${wallet}`;
  } else {
    account_line = draft.direction === 'income' ? `${category} → ${wallet}` : `${wallet} → ${category}`;
  }

  let due_line = null;
  if (tt === 'invoice_issued' || tt === 'bill_received') {
    const due = computeDueDate(draft);
    const m = /^net_(\d+)$/.exec(draft.payment_terms || '');
    due_line = due ? `Due: ${isoToCard(due)}${m ? ` (Net ${m[1]})` : ''}` : null;
  }

  let settles_line = null;
  if (tt === 'payment' && draft.parent_invoice_name) {
    const kind = doc && doc.doctype === 'Purchase Invoice' ? 'Bill' : doc && doc.doctype === 'Journal Entry' ? 'Advance' : 'Invoice';
    settles_line = doc
      ? `Settles: ${kind} ${draft.parent_invoice_name} dated ${isoToCard(doc.posting_date)} for ${fmt(doc.grand_total ?? doc.total_debit)} ${doc.currency || cur}`
      : `Settles: ${draft.parent_invoice_name}`;
  } else if (tt === 'payment') {
    settles_line = `Settles: advance ${draft.direction === 'income' ? 'to' : 'from'} ${party}`;
  }

  const lines = [
    `Date: ${isoToCard(draft.transaction_date)}`,
    amount_line,
    ...itemLines,
    ...net_vat_lines,
    `Type: ${typeLabel(draft)}`,
    `Account: ${account_line}`,
    cp && draft.direction !== 'transfer' ? `Counterparty: ${cp}` : null,
    due_line,
    settles_line,
    draft.description ? `Note: ${draft.description}` : null,
  ].filter(Boolean);
  // Trust warnings (src/trust, set on the draft by request_confirmation), last, under one header.
  const warning_lines = Array.isArray(draft.trust_warnings) && draft.trust_warnings.length
    ? [WARNING_HEADER, ...draft.trust_warnings.map((w) => `- ${w}`)]
    : [];
  lines.push(...warning_lines);

  return { type_label: typeLabel(draft), account_line: `Account: ${account_line}`, amount_line, due_line, settles_line, net_vat_lines, warning_lines, lines };
}

module.exports = { buildCard, categoryName, fmt, isoToCard, CATEGORY_NAMES, WARNING_HEADER };
