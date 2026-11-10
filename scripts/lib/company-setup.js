/**
 * What `smoke-erpnext.js --preflight --fix` creates in a Company, as one reusable step for
 * scripts/provision-user.js: everything the bot would otherwise create on first use, so a new
 * user's first VAT invoice / stock purchase doesn't also have to build the chart.
 *
 *   - a per-currency Receivable ("Debtors USD", or EUR for a USD company) — resolvePartyAccount
 *   - a "Duties and Taxes" group when the chart has no Liability Tax group
 *   - Output VAT / Input VAT / WHT Payable                              — resolveTaxAccount
 *   - a "Stores" warehouse when the company has none                    — as items.resolveWarehouse expects
 *   - the "Products" Item Group and the GEN-SALE / GEN-PURCHASE items   — as items / common create them
 *
 * Like --fix it never touches Company defaults or settings. Same src/ helpers as the bot, so the
 * names are exactly what the bot looks for. Idempotent: existing records are reported, not re-created.
 */
const common = require('../../src/erp-sync/common');
const taxes = require('../../src/erp-sync/taxes');
const items = require('../../src/erp-sync/items');

async function list(erp, doctype, filters, fields = ['name'], limit = 20) {
  return (await erp.listResource(doctype, { filters, fields, limit })).data || [];
}

async function exists(erp, doctype, name) {
  try {
    await erp.getResource(doctype, name);
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

/**
 * Bring `erp.company` up to what the bot expects. `base` is the company currency.
 * Returns [{ doctype, name, created, why }] — one row per thing checked.
 */
async function setupCompany(erp, { base }) {
  const company = erp.company;
  const out = [];
  const note = (doctype, name, created, why) => out.push({ doctype, name, created, why });
  const accounts = (filters, fields = ['name', 'is_group']) => list(erp, 'Account', [['company', '=', company], ...filters], fields);

  // Per-currency receivable (the smoke flows' foreign invoice needs one; real users usually do too).
  const foreign = base === 'USD' ? 'EUR' : 'USD';
  const hadFx = (await accounts([['account_type', '=', 'Receivable'], ['account_currency', '=', foreign], ['is_group', '=', 0]])).length > 0;
  note('Account', await common.resolvePartyAccount(erp, 'Receivable', foreign), !hadFx, `receivable in ${foreign}`);

  // Tax liability group: only when there is neither "Duties and Taxes" nor any Liability Tax group.
  const dt = await accounts([['account_name', '=', 'Duties and Taxes'], ['is_group', '=', 1]]);
  const anyTax = dt.length ? dt : await accounts([['is_group', '=', 1], ['root_type', '=', 'Liability'], ['account_type', '=', 'Tax']]);
  if (anyTax.length) {
    note('Account', anyTax[0].name, false, 'tax liability group');
  } else {
    const parent = (await accounts([['is_group', '=', 1], ['root_type', '=', 'Liability'], ['account_name', 'like', '%Current Liabilities%']]))[0];
    if (!parent) throw new Error(`no Current Liabilities group in ${company} to put "Duties and Taxes" under`);
    const r = await erp.createAccount({ account_name: 'Duties and Taxes', parent_account: parent.name, is_group: 1, account_type: 'Tax' });
    note('Account', r.data?.name, true, 'tax liability group');
  }

  for (const [kind, spec] of Object.entries(taxes.TAX_ACCOUNTS)) {
    const had = (await accounts([['account_name', '=', spec.account_name], ['is_group', '=', 0]])).length > 0;
    note('Account', await taxes.resolveTaxAccount(erp, kind), !had, `tax account ${spec.account_name}`);
  }

  // Warehouse: whatever items.resolveWarehouse finds, else a "Stores" leaf under the company's group.
  try {
    note('Warehouse', await items.resolveWarehouse(erp), false, 'stock warehouse');
  } catch {
    const group = (await list(erp, 'Warehouse', [['company', '=', company], ['is_group', '=', 1]]))[0];
    const r = await erp.createResource('Warehouse', { warehouse_name: 'Stores', company, ...(group ? { parent_warehouse: group.name } : {}) });
    items.clearCaches(company);
    note('Warehouse', r.data?.name, true, 'stock warehouse');
  }

  if (await exists(erp, 'Item Group', items.ITEM_GROUP)) {
    note('Item Group', items.ITEM_GROUP, false, 'stock items group');
  } else {
    await erp.createResource('Item Group', { item_group_name: items.ITEM_GROUP, parent_item_group: 'All Item Groups', is_group: 0 });
    note('Item Group', items.ITEM_GROUP, true, 'stock items group');
  }

  for (const [kind, code] of [['sale', 'GEN-SALE'], ['purchase', 'GEN-PURCHASE']]) {
    const had = await exists(erp, 'Item', code);
    if (!had) await common.ensureGenericItem(erp, kind);
    note('Item', code, !had, 'generic invoice line item');
  }
  return out;
}

module.exports = { setupCompany };
