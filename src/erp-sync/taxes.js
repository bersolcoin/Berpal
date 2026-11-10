/**
 * Thai VAT + withholding tax (WHT) for the write side.
 *
 *   computeTotals(draft)   → { net, vat, gross, wht, due, lines } in transaction currency (pure).
 *                            request_confirmation returns this so the card shows the numbers we
 *                            post, never the model's own arithmetic.
 *   vatTreatment(user, draft) → 'none' | 'output' | 'input' | 'non_claimable'
 *   resolveTaxAccount(erp, kind) → Output VAT / Input VAT / WHT Payable leaf (find or create).
 *   buildTaxRows(...)      → Sales/Purchase Taxes and Charges rows.
 *
 * Why the bot computes every figure and posts VAT and WHT as 'Actual' rows on NET item amounts:
 * ERPNext's own maths moved between versions — since v14 (Aug 2024) / v15 an inclusive VAT row is
 * flt(rate × Σ flt(amountᵢ / 1.07)) with the leftover cent pushed to Round Off, earlier versions
 * fold it into the VAT. Sending net rates + an Actual VAT amount makes the posted net, VAT, grand
 * total and outstanding equal the card on every version. All rounding is Frappe's flt (round2).
 *
 *   tax_inclusive → stated rates are gross; VAT = flt(gross × r / (100 + r)), net = gross − VAT
 *   exclusive     → stated rates are net;  VAT = flt(net × r),                gross = net + VAT
 *   WHT           → flt(net × w) on the pre-VAT net (Thai Revenue Code); due = gross − WHT
 */
const { ts, round2 } = require('./common');

// Exact account names the bot looks for (and creates when missing). root_type decides the parent:
// Input VAT (ภาษีซื้อ) is a claim on the Revenue Department → an asset; the other two are owed.
const TAX_ACCOUNTS = {
  output_vat: { account_name: 'Output VAT', root_type: 'Liability' },
  input_vat: { account_name: 'Input VAT', root_type: 'Asset' },
  wht_payable: { account_name: 'WHT Payable', root_type: 'Liability' },
};
const PARENT_GROUPS = {
  Liability: ['Duties and Taxes'],
  Asset: ['Tax Assets', 'Current Assets'],
};

// Thai WHT rates the prompt lets the model pick from (0 = clear).
const WHT_RATES = [1, 2, 3, 5];
// PND3 = payee is an individual, PND53 = payee is a juristic person. Goes on the WHT row so the
// monthly filings can be split from the ledger.
const WHT_FORMS = ['PND3', 'PND53'];

function vatRate(draft) {
  const r = Number(draft.tax_rate);
  return r > 0 ? r : 0;
}

function whtRate(draft) {
  const r = Number(draft.wht_rate);
  return r > 0 ? r : 0;
}

/** Normalised line list for the draft: [{ description, qty, rate, item_code }]. */
function draftLines(draft, fallbackDescription = null) {
  if (Array.isArray(draft.items) && draft.items.length) {
    return draft.items.map((it) => ({
      description: it.description || it.item_code || fallbackDescription,
      qty: it.qty == null ? 1 : Number(it.qty),
      rate: Number(it.rate),
      item_code: it.item_code || null,
    }));
  }
  return [{ description: draft.description || fallbackDescription, qty: 1, rate: Number(draft.amount), item_code: null }];
}

/**
 * Net / VAT / gross / WHT / due for the draft, plus each line's net and gross amount.
 *
 *   inclusive → gross G = Σ flt(qty × rate); VAT = flt(G × r / (100 + r)) on the DOCUMENT total
 *               (the legal VAT on a tax invoice — a per-unit back-out would make 100 × 1.00 carry
 *               7.00 VAT instead of 6.54); net = G − VAT.
 *   exclusive → net N = Σ flt(qty × rate); VAT = flt(N × r / 100); gross = N + VAT.
 * Line amounts on the "other" basis are flt(line × factor) with the last line taking the
 * remainder, so lines always add up to the document totals exactly.
 */
function computeTotals(draft, fallbackDescription = null) {
  const r = vatRate(draft);
  const inclusive = !!(r && draft.tax_inclusive);
  const lines = draftLines(draft, fallbackDescription).map((l) => ({ ...l, stated: round2(l.qty * l.rate) }));
  const stated = round2(lines.reduce((s, l) => s + l.stated, 0));
  let net, vat, gross;
  if (inclusive) {
    gross = stated;
    vat = round2(gross * r / (100 + r));
    net = round2(gross - vat);
  } else {
    net = stated;
    vat = r ? round2(net * r / 100) : 0;
    gross = round2(net + vat);
  }
  // Spread the derived basis over the lines; the last line absorbs the rounding.
  const other = inclusive ? net : gross;
  const factor = inclusive ? 100 / (100 + r) : 1 + r / 100;
  let spread = 0;
  lines.forEach((l, i) => {
    const derived = i === lines.length - 1 ? round2(other - spread) : round2(l.stated * factor);
    spread = round2(spread + derived);
    l.net = inclusive ? derived : l.stated;
    l.gross = inclusive ? l.stated : derived;
    delete l.stated;
  });
  const wht = round2(net * whtRate(draft) / 100);
  return { net, vat, gross, wht, due: round2(gross - wht), lines };
}

/**
 * The user stated what they actually transferred after withholding ("sent 9,700 after 3%").
 * Find the amount (on the draft's VAT basis) whose due equals that figure: closed form, then a
 * few satang either side because of rounding. Not every figure is reachable (as the amount steps
 * by 0.01 the due can step by 0.02), so on a miss return the nearest reachable paid amount.
 *   → { amount, exact: true } | { exact: false, nearest_paid, nearest_amount, difference }
 */
function amountFromPaidAfterWht(draft, paid) {
  const r = vatRate(draft) / 100;
  const w = whtRate(draft) / 100;
  const net = paid / (1 + r - w);
  const base = draft.tax_inclusive && r ? net * (1 + r) : net;
  let best = null;
  for (let k = -5; k <= 5; k++) {
    const amount = round2(base + k / 100);
    if (!(amount > 0)) continue;
    const t = computeTotals({ ...draft, items: undefined, amount });
    const diff = round2(t.due - paid);
    if (diff === 0) return { amount, exact: true };
    if (!best || Math.abs(diff) < Math.abs(best.difference)) {
      best = { exact: false, nearest_paid: t.due, nearest_amount: amount, difference: diff };
    }
  }
  return best;
}

/**
 * How VAT on this draft is booked:
 *   output        — sales side (invoice_issued, cash income): Output VAT. Only a registrant may
 *                   charge VAT (validate.js refuses it otherwise).
 *   input         — purchase by a VAT-registered user with a full tax invoice: Input VAT.
 *   non_claimable — purchase by a non-registrant, or an abbreviated tax invoice
 *                   (vat_claimable=false): the VAT is part of the cost — rows are posted at GROSS
 *                   with no VAT row, so stock is valued at gross (TAS 2) and expenses carry it.
 */
function vatTreatment(user, draft) {
  if (!vatRate(draft)) return 'none';
  const tt = draft.transaction_type || 'cash';
  const sales = tt === 'invoice_issued' || (tt === 'cash' && draft.direction === 'income');
  if (sales) return 'output';
  return Number(user.vat_registered) === 1 && draft.vat_claimable !== false ? 'input' : 'non_claimable';
}

/**
 * Find (or create) the leaf account for `kind` ('output_vat' | 'input_vat' | 'wht_payable').
 * Exact account_name match only — a LIKE would happily pick "Undue Input VAT". An existing leaf
 * is used whatever its account_type (the accountant may have set it up differently); a GROUP of
 * that name is a chart problem we refuse to guess around. Per-process memo; clearCaches() drops
 * it after a failed save in case the account was renamed/deleted.
 */
const _taxAccountCache = new Map();
async function resolveTaxAccount(erp, kind) {
  const spec = TAX_ACCOUNTS[kind];
  if (!spec) throw new Error(`unknown tax account kind ${kind}`);
  const cacheKey = `${erp.company}|${kind}`;
  if (_taxAccountCache.has(cacheKey)) return _taxAccountCache.get(cacheKey);

  const existing = await erp.listResource('Account', {
    filters: [['company', '=', erp.company], ['account_name', '=', spec.account_name]],
    fields: ['name', 'is_group'],
    limit: 5,
  });
  const leaf = (existing.data || []).find((a) => !Number(a.is_group));
  if (leaf) {
    _taxAccountCache.set(cacheKey, leaf.name);
    return leaf.name;
  }
  if ((existing.data || []).length) {
    throw new Error(`[erpnext] "${existing.data[0].name}" is a group account; ${spec.account_name} must be a ledger (leaf) account. Fix the chart of accounts.`);
  }

  // Parent: the standard group for this root type by exact name, else any Tax group of that root type.
  let parentAccount = null;
  for (const groupName of PARENT_GROUPS[spec.root_type]) {
    const g = await erp.listResource('Account', {
      filters: [['company', '=', erp.company], ['is_group', '=', 1], ['account_name', '=', groupName]],
      fields: ['name'],
      limit: 1,
    });
    if (g.data?.length) {
      parentAccount = g.data[0].name;
      break;
    }
  }
  if (!parentAccount) {
    const g = await erp.listResource('Account', {
      filters: [['company', '=', erp.company], ['is_group', '=', 1], ['root_type', '=', spec.root_type], ['account_type', '=', 'Tax']],
      fields: ['name'],
      limit: 1,
    });
    parentAccount = g.data?.[0]?.name || null;
  }
  if (!parentAccount) {
    throw new Error(`[erpnext] no ${PARENT_GROUPS[spec.root_type].join(' / ')} group for ${spec.account_name} in company ${erp.company}`);
  }

  const result = await erp.createAccount({
    account_name: spec.account_name,
    parent_account: parentAccount,
    account_type: 'Tax',
  });
  const erpName = result.data?.name;
  console.log(`• [erp-sync] [${ts()}] created Tax account in ERPNext: ${erpName} (under ${parentAccount})`);
  _taxAccountCache.set(cacheKey, erpName);
  return erpName;
}

function clearCaches(company) {
  for (const k of [..._taxAccountCache.keys()]) if (k.startsWith(`${company}|`)) _taxAccountCache.delete(k);
}

/**
 * Taxes table for a Sales Invoice (side='sales') or Purchase Invoice (side='purchase').
 *   VAT (output / input): Actual row = the VAT we computed. Non-claimable VAT gets no row — the
 *     item rows carry it (invoice-lines.js posts gross amounts).
 *   WHT (purchase): Actual Deduct row to WHT Payable, flt(pre-VAT net × rate). Actual rather than
 *     'On Net Total' because with non-claimable VAT ERPNext's net_total is the gross, which is
 *     NOT the WHT base.
 * Returns [] when neither applies.
 */
async function buildTaxRows(user, erp, draft, side, totals) {
  const rows = [];
  const treatment = vatTreatment(user, draft);
  const r = vatRate(draft);
  if (totals.vat && (treatment === 'output' || treatment === 'input')) {
    rows.push({
      charge_type: 'Actual',
      account_head: await resolveTaxAccount(erp, treatment === 'output' ? 'output_vat' : 'input_vat'),
      tax_amount: totals.vat,
      description: `VAT ${r}%`,
      ...(side === 'purchase' ? { category: 'Total', add_deduct_tax: 'Add' } : {}),
    });
  }
  if (totals.wht && side === 'purchase') {
    rows.push({
      charge_type: 'Actual',
      account_head: await resolveTaxAccount(erp, 'wht_payable'),
      tax_amount: totals.wht,
      description: `WHT ${whtRate(draft)}%${draft.wht_form ? ` (${draft.wht_form})` : ''}`,
      category: 'Total',
      add_deduct_tax: 'Deduct',
    });
  }
  return rows;
}

/** WHT withheld on a submitted Purchase Invoice (sum of its Deduct rows). */
function whtOnInvoice(doc) {
  return round2((doc.taxes || []).filter((t) => t.add_deduct_tax === 'Deduct')
    .reduce((s, t) => s + (Number(t.tax_amount) || 0), 0));
}

module.exports = {
  TAX_ACCOUNTS, WHT_RATES, WHT_FORMS, computeTotals, amountFromPaidAfterWht, vatTreatment,
  resolveTaxAccount, buildTaxRows, clearCaches, vatRate, whtRate, draftLines, whtOnInvoice,
};
