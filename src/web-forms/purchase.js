/**
 * Web "New purchase" form → ERPNext Purchase Invoice (+ Payment Entry when
 * paid now). Turns the form payload into the same draft shape the WhatsApp
 * bot produced and saves it through the shared erp-sync dispatcher, so
 * validation-free plumbing (supplier find-or-create, multi-currency,
 * paid-now settlement, B2B link proposals) is identical on both channels.
 *
 * Payload:
 *   {
 *     supplier:  string,                        // existing or new — find-or-create
 *     date:      'YYYY-MM-DD',
 *     currency:  'USD',
 *     reference: string?,                       // supplier's bill number
 *     notes:     string?,
 *     lines: [{
 *       item: { erpnext_name } | { new: { variety, code?, name?, attributes } },
 *       qty,            // in the lot's unit (Carat lots: carats; a new
 *                       //   Carat lot uses its weight_ct)
 *       rate,           // price per unit (per carat for gems)
 *       description?
 *     }],
 *     payment: { mode: 'paid', wallet_account } | { mode: 'credit', terms: 'net_30' }
 *   }
 *
 * Returns { ok: true, erpnext_name, doctype, payment_entry_name?, payment_entry_error? }
 *      or { ok: false, error }.
 */

const erpSync = require('../erp-sync');
const { createLot } = require('../catalog');
const { fetchRate } = require('../exchange');
const { ts } = require('../log');

const TERMS = new Set(['net_0', 'net_7', 'net_15', 'net_30', 'net_60']);
const WALLET_CODE = { Cash: '1000', Bank: '1100', 'Credit Card': '2100' };

function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

async function createPurchase(user, erp, body) {
  const supplier = str(body?.supplier);
  const date = str(body?.date);
  const currency = str(body?.currency)?.toUpperCase();
  const lines = Array.isArray(body?.lines) ? body.lines : [];
  const payment = body?.payment || {};

  // ── Validate ────────────────────────────────────────────────────────
  if (!supplier) return { ok: false, error: 'Please choose a supplier.' };
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Please pick a valid date.' };
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return { ok: false, error: 'Please pick a currency.' };
  if (lines.length === 0) return { ok: false, error: 'Add at least one item.' };
  for (const [i, l] of lines.entries()) {
    const n = i + 1;
    const nu = l?.item?.new;
    if (!l?.item?.erpnext_name && !str(nu?.variety)) return { ok: false, error: `Line ${n}: choose a lot or add a new one.` };
    const qty = Number(nu?.attributes?.weight_ct) || Number(l.qty);
    if (!(qty > 0)) return { ok: false, error: `Line ${n}: enter the weight or quantity.` };
    if (!(Number(l.rate) >= 0)) return { ok: false, error: `Line ${n}: enter a price.` };
  }
  if (payment.mode === 'paid') {
    if (!str(payment.wallet_account)) return { ok: false, error: 'Choose which wallet you paid from.' };
  } else if (payment.mode === 'credit') {
    if (!TERMS.has(payment.terms)) return { ok: false, error: 'Choose payment terms.' };
  } else {
    return { ok: false, error: 'Choose whether it was paid now or on credit.' };
  }

  // Paid-now wallet must be one of this tenant's wallets, in the bill's
  // currency (cross-currency settlement isn't supported from the form yet).
  let wallet = null;
  if (payment.mode === 'paid') {
    const r = await erp.listResource('Account', {
      filters: [
        ['company', '=', erp.company],
        ['name', '=', payment.wallet_account],
        ['is_group', '=', 0],
      ],
      fields: ['name', 'account_name', 'account_type', 'account_currency'],
      limit: 1,
    });
    wallet = r.data?.[0];
    if (!wallet || !WALLET_CODE[wallet.account_type]) return { ok: false, error: 'That wallet was not found.' };
    if (wallet.account_currency !== currency) {
      return { ok: false, error: `That wallet holds ${wallet.account_currency} — pick a ${currency} wallet.` };
    }
  }

  // ── Exchange rate (bill currency → reporting currency) ──────────────
  let exchangeRate = 1;
  if (currency !== user.reporting_currency) {
    const fx = await fetchRate(currency, user.reporting_currency, date);
    if (fx.error) return { ok: false, error: `Couldn't get the ${currency}→${user.reporting_currency} rate: ${fx.error}` };
    exchangeRate = fx.rate;
  }

  // ── Create any new lots first ───────────────────────────────────────
  const items = [];
  for (const [i, l] of lines.entries()) {
    let erpnextName = l.item?.erpnext_name || null;
    let qty = Number(l.qty);
    let label = str(l.description);
    if (!erpnextName) {
      const nu = l.item.new;
      try {
        const lot = await createLot(user, erp, {
          variety: nu.variety,
          code: str(nu.code),
          name: str(nu.name),
          attributes: nu.attributes || {},
        });
        erpnextName = lot.erpnext_name;
        // A new carat lot is bought whole: line qty = the lot's weight.
        if (lot.uom === 'Carat') qty = lot.weight_ct;
      } catch (err) {
        if (err.userMessage) return { ok: false, error: `Line ${i + 1}: ${err.userMessage}` };
        if (/already exists|Duplicate/i.test(err.message)) {
          return { ok: false, error: `Line ${i + 1}: lot code "${str(nu.code)}" already exists — search for it instead.` };
        }
        throw err;
      }
    }
    items.push({
      item_code: erpnextName,
      qty,
      rate: Number(l.rate),
      ...(label ? { description: label } : {}),
    });
  }

  const amount = Math.round(items.reduce((s, it) => s + it.qty * it.rate, 0) * 100) / 100;

  // ── Same draft shape as the WhatsApp bot → shared save path ─────────
  const draft = {
    transaction_type: 'bill_received',
    direction: 'expense',
    category_code: '5000', // goods for resale → COGS (non-stock lines)
    amount,
    currency,
    exchange_rate: exchangeRate,
    transaction_date: date,
    counterparty_name: supplier,
    items,
    invoice_number: str(body.reference),
    description: str(body.notes),
    paid_now: payment.mode === 'paid',
    ...(payment.mode === 'paid'
      ? {
          payment_account_code: WALLET_CODE[wallet.account_type],
          wallet_name: wallet.account_name,
          wallet_account: wallet.name,
        }
      : { payment_terms: payment.terms }),
  };

  console.log(`• [web-purchase] [${ts()}] user=${user.id} ${amount} ${currency} from "${supplier}" (${items.length} line(s), ${draft.paid_now ? 'paid now' : payment.terms})`);
  return erpSync.save(user, draft);
}

module.exports = { createPurchase };
