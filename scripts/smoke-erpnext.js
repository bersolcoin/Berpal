/**
 * Smoke test against a REAL ERPNext Company: runs the bot's own write/read code paths
 * (wallets.create, erp-sync saveDraft, erp-query/*, erp.getPdf / uploadFile) and, after each step,
 * fetches the posted document and its GL Entries and checks them.
 *
 *   node scripts/smoke-erpnext.js --preflight      setup checks only (add --fix to create what the bot would)
 *   node scripts/smoke-erpnext.js                  preflight + flows, then offers cleanup (TTY)
 *   node scripts/smoke-erpnext.js --cleanup        … and cleans up without asking
 *   node scripts/smoke-erpnext.js --cleanup-only   cancel + delete what the last run's report lists
 *   node scripts/smoke-erpnext.js --help
 *
 * Reads ERPNEXT_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET, ERPNEXT_COMPANY_DEFAULT from .env.
 * Postgres is not needed: the bot's cache tables live in pg-mem for the duration of the run.
 * Everything created is named SMOKE-… . Use a dedicated test Company: the script refuses to run
 * the flows against a Company with GL Entries it didn't create unless --allow-live is passed.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const H = require('./lib/smoke-helpers');

const opts = H.parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(H.USAGE);
  process.exit(0);
}
if (opts.errors.length) {
  for (const e of opts.errors) console.error(`[smoke] ${e}`);
  console.error('[smoke] see --help');
  process.exit(2);
}

const TODAY = new Date().toISOString().slice(0, 10);
const REPORT_PATH = path.resolve(process.cwd(), opts.report);

// ── Output ───────────────────────────────────────────────────────────

function section(title) {
  console.log('');
  console.log('────────────────────────────────────────────────────');
  console.log(`  ${title}`);
  console.log('────────────────────────────────────────────────────');
}

function printError(err, indent = '  ') {
  console.log(`${indent}✖ ERPNext/bot error: ${H.serverMessage(err)}`);
  const where = String(err.message || '').match(/^\[erpnext [A-Z]+ [^\]]+\]/);
  if (where) console.log(`${indent}  at ${where[0]}`);
}

function errorRecord(err) {
  return { message: String(err.message || err).slice(0, 2000), server: H.serverMessage(err), status: err.status || null };
}

// ── Main ─────────────────────────────────────────────────────────────

const ctx = {
  opts,
  startedAt: new Date().toISOString(),
  target: null,
  guard: null,
  preflight: [],
  steps: [],
  queries: {},
  created: [],
  fixed: [],
  cleanup: null,
  ids: {},
  acc: {},
  bal0: {},
  delta: {},
};

(async () => {
  let code;
  try {
    code = await main();
  } catch (err) {
    console.error('');
    console.error(`[smoke] unexpected error: ${err.message}`);
    if (err.response) console.error(`[smoke] server: ${H.serverMessage(err)}`);
    ctx.fatal = errorRecord(err);
    code = 1;
  }
  writeReport();
  process.exit(code);
})();

async function main() {
  const { ERPNEXT_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET } = process.env;
  const company = opts.company || process.env.ERPNEXT_COMPANY_DEFAULT;
  const missing = [
    ['ERPNEXT_URL', ERPNEXT_URL], ['ERPNEXT_API_KEY', ERPNEXT_API_KEY], ['ERPNEXT_API_SECRET', ERPNEXT_API_SECRET],
    ['ERPNEXT_COMPANY_DEFAULT (or --company)', company],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`[smoke] missing in .env: ${missing.join(', ')}`);
    return 2;
  }

  const erpnext = require('../src/erpnext');
  ctx.baseUrl = ERPNEXT_URL.replace(/\/$/, '');
  ctx.companyName = company;
  ctx.erp = erpnext.forUser({
    erpnext_url: ctx.baseUrl, erpnext_api_key: ERPNEXT_API_KEY, erpnext_api_secret: ERPNEXT_API_SECRET, erpnext_company: company,
  });
  ctx.target = { url: ctx.baseUrl, company };
  console.log(`[smoke] target: ${ctx.baseUrl}  company: "${company}"  mode: ${opts.mode}${opts.fix ? ' --fix' : ''}`);
  console.log(`[smoke] report: ${REPORT_PATH}`);

  if (opts.mode === 'cleanup') return cleanupOnly();

  const pre = await preflight();
  if (pre.fatal) return 1;
  if (opts.mode === 'preflight') {
    return H.summarize({ preflight: ctx.preflight }).failed ? 1 : 0;
  }

  if (!ctx.guard.ok) {
    console.log('');
    console.log(`[smoke] REFUSED: ${ctx.guard.message}`);
    return 2;
  }

  await flows();

  if (ctx.created.length) {
    let doCleanup = opts.cleanup;
    if (!doCleanup && !opts.keep && process.stdin.isTTY && process.stdout.isTTY) {
      const a = await ask(`\nCancel and delete the ${ctx.created.length} records this run created? [y/N] `);
      doCleanup = /^y(es)?$/i.test(a.trim());
    }
    if (doCleanup) ctx.cleanup = await cleanup(ctx.created);
    else console.log(`\n[smoke] left everything in place; remove it later with --cleanup-only --report ${opts.report}`);
  }

  const s = H.summarize({ preflight: ctx.preflight, steps: ctx.steps, cleanup: ctx.cleanup });
  section('Summary');
  console.log(`  preflight: ${s.preflight.pass} pass, ${s.preflight.warn} warn, ${s.preflight.fail} fail`);
  console.log(`  steps:     ${s.steps.ok} ok, ${s.steps.failed} failed, ${s.steps.skipped} skipped`);
  console.log(`  checks:    ${s.checks.passed} passed, ${s.checks.failed} failed, ${s.checks.soft_failed} soft (⚠)`);
  if (s.cleanup) console.log(`  cleanup:   ${s.cleanup.removed} removed, ${s.cleanup.failed} could not be removed`);
  for (const st of ctx.steps.filter((x) => !x.ok && !x.skipped)) {
    console.log(`  ✖ [${st.id}] ${st.label}${st.error ? ` — ${st.error.server}` : ''}`);
  }
  return s.failed ? 1 : 0;
}

function writeReport() {
  const report = H.buildReport({
    startedAt: ctx.startedAt,
    finishedAt: new Date().toISOString(),
    mode: opts.mode,
    options: opts,
    target: ctx.target,
    guard: ctx.guard,
    preflight: ctx.preflight,
    steps: ctx.steps,
    queries: ctx.queries,
    created: ctx.created,
    cleanup: ctx.cleanup,
  });
  report.fixed = ctx.fixed;
  if (ctx.fatal) report.fatal = ctx.fatal;
  if (ctx.previousRun) report.previous_run = ctx.previousRun;
  try {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`\n[smoke] report written: ${REPORT_PATH}`);
  } catch (err) {
    console.error(`[smoke] could not write report: ${err.message}`);
  }
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => {
      rl.close();
      resolve(a || '');
    });
  });
}

// ── ERPNext helpers ──────────────────────────────────────────────────

async function list(doctype, filters, fields, limit = 100) {
  return (await ctx.erp.listResource(doctype, { filters, fields, limit })).data || [];
}

async function tryGet(doctype, name) {
  try {
    return (await ctx.erp.getResource(doctype, name)).data;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function getDoc(doctype, name) {
  return (await ctx.erp.getResource(doctype, name)).data;
}

async function glOf(voucherNo) {
  return list('GL Entry', [['voucher_no', '=', voucherNo], ['is_cancelled', '=', 0]],
    ['account', 'debit', 'credit', 'account_currency', 'debit_in_account_currency', 'credit_in_account_currency', 'party'], 500);
}

async function glNetOf(voucherNo) {
  return H.glNet(await glOf(voucherNo));
}

async function balance(account) {
  const r = await ctx.erp.getAccountBalance(account);
  return H.round2(Number(r.message) || 0);
}

async function glCount(filters) {
  const r = await ctx.erp.callMethod('frappe.client.get_count', { doctype: 'GL Entry', filters });
  return Number(r.message) || 0;
}

/** Frappe's cancel is POST-only; the bot never cancels, so the client has no wrapper for it. */
function cancelDoc(doctype, name) {
  return ctx.erp._fetch('POST', '/api/method/frappe.client.cancel', { doctype, name });
}

function track(doctype, name, step, extra = {}) {
  if (!name) return;
  if (ctx.created.some((c) => c.doctype === doctype && c.name === name)) return;
  ctx.created.push({ doctype, name, step, seq: ctx.created.length, ...extra });
}

function addDelta(key, amount) {
  ctx.delta[key] = H.round2((ctx.delta[key] || 0) + amount);
}

// ── Safety guard ─────────────────────────────────────────────────────

async function computeGuard() {
  const company = ctx.companyName;
  const total = await glCount([['company', '=', company]]);
  let smoke = 0;
  if (total) {
    const vouchers = new Set();
    for (const f of [['party', 'like', `${H.PREFIX}%`], ['account', 'like', `${H.PREFIX}%`]]) {
      for (const g of await list('GL Entry', [['company', '=', company], f], ['voucher_no'], 100000)) vouchers.add(g.voucher_no);
    }
    const arr = [...vouchers];
    for (let i = 0; i < arr.length; i += 100) {
      smoke += await glCount([['company', '=', company], ['voucher_no', 'in', arr.slice(i, i + 100)]]);
    }
  }
  return { total, smoke, ...H.liveGuardDecision({ total, smoke, allowLive: opts.allowLive }) };
}

// ── pg-mem user ──────────────────────────────────────────────────────

async function setupUser(companyDoc) {
  const db = require('../src/db');
  const erpnext = require('../src/erpnext');
  const { newDb } = require('pg-mem');
  const { Pool } = newDb().adapters.createPg();
  db._setPoolForTests(new Pool());
  await db.migrate();
  const now = new Date().toISOString();
  const r = await db.query(
    `INSERT INTO users (phone, display_name, erpnext_company, erpnext_api_key, erpnext_api_secret,
       default_currency, reporting_currency, country, timezone, vat_registered, created_at, updated_at)
     VALUES ('+00000000000', 'Smoke Test', $1, $2, $3, $4, $4, 'TH', 'Asia/Bangkok', 1, $5, $5) RETURNING *`,
    [companyDoc.name, process.env.ERPNEXT_API_KEY, process.env.ERPNEXT_API_SECRET, companyDoc.default_currency, now]
  );
  ctx.db = db;
  ctx.user = { ...r.rows[0], erpnext_url: ctx.baseUrl };
  // Same client the bot builds for a user row.
  ctx.erp = erpnext.forUser(ctx.user);
}

// ── Preflight ────────────────────────────────────────────────────────

function pf(status, label, detail = '', hint = null) {
  const p = { status, label, detail: detail == null ? '' : String(detail), ...(hint ? { hint } : {}) };
  ctx.preflight.push(p);
  console.log(H.formatPreflight(p));
  return p;
}

async function preflight() {
  section('Preflight');
  let erp = ctx.erp;

  try {
    const me = await erp.getMe();
    pf('PASS', 'API reachable, frappe.auth.get_logged_user', me);
  } catch (err) {
    pf('FAIL', 'API reachable, frappe.auth.get_logged_user', H.serverMessage(err),
      'check ERPNEXT_URL and the API key/secret (User → Settings → API Access → Generate Keys)');
    return { fatal: true };
  }

  let c;
  try {
    c = await getDoc('Company', ctx.companyName);
  } catch (err) {
    pf('FAIL', 'Company exists', H.serverMessage(err), `create Company "${ctx.companyName}" or pass --company "Name"`);
    return { fatal: true };
  }
  ctx.company = c;
  ctx.abbr = c.abbr;
  ctx.base = c.default_currency;
  ctx.foreign = ctx.base === 'USD' ? 'EUR' : 'USD';
  Object.assign(ctx.target, { abbr: c.abbr, currency: c.default_currency });
  pf(c.abbr ? 'PASS' : 'FAIL', 'Company abbr / default_currency', `${c.name} (${c.abbr || '?'}), ${c.default_currency || '?'}`,
    c.abbr ? null : 'the Company needs an abbreviation');
  if (!c.abbr || !c.default_currency) return { fatal: true };

  await setupUser(c);
  erp = ctx.erp;
  const user = ctx.user;
  const company = c.name;
  const accounts = (filters, fields = ['name', 'is_group', 'account_type', 'root_type', 'account_currency', 'parent_account']) =>
    list('Account', [['company', '=', company], ...filters], fields, 20);

  // Safety guard (printed here; enforced before flows and --fix).
  try {
    ctx.guard = await computeGuard();
    pf(ctx.guard.ok ? 'PASS' : 'WARN', 'GL Entries in Company (safety guard)', `${ctx.guard.total} total — ${ctx.guard.message}`,
      ctx.guard.ok ? null : 'flows and --fix are refused here; use a dedicated test Company or --allow-live');
  } catch (err) {
    ctx.guard = { ok: false, total: null, message: `could not count GL Entries: ${H.serverMessage(err)}` };
    pf('FAIL', 'GL Entries in Company (safety guard)', H.serverMessage(err), 'the API user needs read on GL Entry');
  }
  const canFix = opts.fix && ctx.guard.ok;
  if (opts.fix && !ctx.guard.ok) console.log('  (--fix skipped: safety guard)');
  const fixed = (doctype, name, why) => {
    ctx.fixed.push({ doctype, name, why });
    console.log(`        + created ${doctype} ${name} (${why})`);
  };

  // Default accounts.
  const defaults = [
    ['default_receivable_account', 'Default Receivable Account'],
    ['default_payable_account', 'Default Payable Account'],
    ['default_cash_account', 'Default Cash Account'],
    ['default_income_account', 'Default Income Account'],
    ['default_expense_account', 'Default Expense (COGS) Account'],
    ['exchange_gain_loss_account', 'Exchange Gain/Loss Account'],
  ];
  for (const [field, label] of defaults) {
    pf(c[field] ? 'PASS' : 'FAIL', label, c[field] || '(unset)',
      `Company → Default Accounts → ${label}${field === 'exchange_gain_loss_account' ? ' (node scripts/check-fx-account.js lists candidates)' : ''}`);
  }

  // Receivable / Payable groups (resolvePartyAccount puts "Debtors USD" etc. under them).
  for (const type of ['Receivable', 'Payable']) {
    const g = await accounts([['account_type', '=', type], ['is_group', '=', 1]]);
    if (g.length) {
      pf('PASS', `${type} group`, g[0].name);
      continue;
    }
    const leaf = await accounts([['account_type', '=', type], ['is_group', '=', 0]]);
    if (leaf.length) {
      pf('WARN', `${type} group`, `none; per-currency accounts will go under ${leaf[0].parent_account}`,
        `set Account Type "${type}" on the Accounts ${type} group`);
    } else {
      pf('FAIL', `${type} group`, `no ${type} account at all`, `create an Accounts ${type} group (account_type ${type}) with a leaf`);
    }
  }

  // Per-currency receivable the USD invoice needs.
  const fxDebtors = await accounts([['account_type', '=', 'Receivable'], ['account_currency', '=', ctx.foreign], ['is_group', '=', 0]]);
  if (fxDebtors.length) {
    pf('PASS', `Receivable account in ${ctx.foreign}`, fxDebtors[0].name);
  } else if (canFix) {
    try {
      const name = await require('../src/erp-sync/common').resolvePartyAccount(erp, 'Receivable', ctx.foreign);
      fixed('Account', name, `per-currency receivable (resolvePartyAccount)`);
      pf('PASS', `Receivable account in ${ctx.foreign}`, `${name} (created)`);
    } catch (err) {
      pf('FAIL', `Receivable account in ${ctx.foreign}`, H.serverMessage(err), 'fix the Receivable group first');
    }
  } else {
    pf('WARN', `Receivable account in ${ctx.foreign}`, 'missing — the bot creates "Debtors ' + ctx.foreign + '" on first use', 'or run with --fix');
  }

  // Tax groups.
  const dt = await accounts([['account_name', '=', 'Duties and Taxes'], ['is_group', '=', 1]]);
  if (dt.length) {
    pf('PASS', '"Duties and Taxes" group', dt[0].name);
  } else {
    const anyTax = await accounts([['is_group', '=', 1], ['root_type', '=', 'Liability'], ['account_type', '=', 'Tax']]);
    if (anyTax.length) {
      pf('WARN', '"Duties and Taxes" group', `missing; Output VAT / WHT Payable will go under ${anyTax[0].name}`);
    } else if (canFix) {
      try {
        const parent = (await accounts([['is_group', '=', 1], ['root_type', '=', 'Liability'], ['account_name', 'like', '%Current Liabilities%']]))[0];
        if (!parent) throw new Error('no Current Liabilities group to put it under');
        const r = await erp.createAccount({ account_name: 'Duties and Taxes', parent_account: parent.name, is_group: 1, account_type: 'Tax' });
        fixed('Account', r.data?.name, 'tax liability group');
        pf('PASS', '"Duties and Taxes" group', `${r.data?.name} (created)`);
      } catch (err) {
        pf('FAIL', '"Duties and Taxes" group', H.serverMessage(err), 'create a "Duties and Taxes" group (Liability, Account Type Tax)');
      }
    } else {
      pf('FAIL', '"Duties and Taxes" group', 'missing (no Liability Tax group either)',
        'create a "Duties and Taxes" group under Current Liabilities (Account Type Tax), or run with --fix');
    }
  }
  const ta = await accounts([['account_name', '=', 'Tax Assets'], ['is_group', '=', 1]]);
  const ca = ta.length ? [] : await accounts([['account_name', '=', 'Current Assets'], ['is_group', '=', 1]]);
  if (ta.length) pf('PASS', '"Tax Assets" group', ta[0].name);
  else if (ca.length) pf('PASS', '"Tax Assets" group', `missing; Input VAT goes under ${ca[0].name}`);
  else pf('FAIL', '"Tax Assets" group', 'neither "Tax Assets" nor "Current Assets" group', 'create a "Tax Assets" group under Current Assets');

  // Tax leaves the bot creates on first use.
  const taxes = require('../src/erp-sync/taxes');
  for (const [kind, spec] of Object.entries(taxes.TAX_ACCOUNTS)) {
    const label = `"${spec.account_name}" account`;
    const found = await accounts([['account_name', '=', spec.account_name]]);
    const leaf = found.find((a) => !Number(a.is_group));
    if (leaf) {
      pf('PASS', label, `${leaf.name} (${leaf.account_type || 'no type'})`);
    } else if (found.length) {
      pf('FAIL', label, `${found[0].name} is a GROUP`, 'it must be a ledger (leaf) account; the bot refuses to post to a group');
    } else if (canFix) {
      try {
        const name = await taxes.resolveTaxAccount(erp, kind);
        fixed('Account', name, 'tax account (resolveTaxAccount)');
        pf('PASS', label, `${name} (created)`);
      } catch (err) {
        pf('FAIL', label, H.serverMessage(err), 'fix the parent tax group first');
      }
    } else {
      pf('WARN', label, 'missing — created on first VAT/WHT document', 'or run with --fix; rename an existing one (e.g. ภาษีขาย) to exactly this name to reuse it');
    }
  }

  // Category accounts (ERP_CODE_MAP) the flows post to.
  const common = require('../src/erp-sync/common');
  const categories = { 3200: 'Opening Balance Equity', 4000: 'Sales', 5000: 'COGS', 5100: 'Meals', 5700: 'Professional services', 1000: 'Cash (no-wallet fallback)' };
  for (const [code, what] of Object.entries(categories)) {
    let acc = null;
    let err = null;
    try {
      acc = await common.resolveErpAccount(user, erp, code, ctx.base);
    } catch (e) {
      err = e;
    }
    const status = acc ? 'PASS' : code === '1000' ? 'WARN' : 'FAIL';
    pf(status, `category ${code} (${what})`, acc || (err ? H.serverMessage(err) : 'unresolved'),
      `the bot maps ${code} to a leaf named "${common.ERP_CODE_MAP[code]} - … - ${ctx.abbr}" (ERPNext "Standard with Numbers" chart)`);
  }

  // Perpetual inventory.
  pf(Number(c.enable_perpetual_inventory) ? 'PASS' : 'FAIL', 'perpetual inventory', Number(c.enable_perpetual_inventory) ? 'enabled' : 'disabled',
    'Company → Stock → Enable Perpetual Inventory');
  for (const [field, label] of [
    ['default_inventory_account', 'Default Inventory Account'],
    ['stock_received_but_not_billed', 'Stock Received But Not Billed'],
    ['default_expense_account', 'Default COGS Account'],
  ]) {
    pf(c[field] ? 'PASS' : 'FAIL', label, c[field] || '(unset)', `Company → Stock / Default Accounts → ${label}`);
  }

  // Warehouse — same rule as src/erp-sync/items.js.
  const items = require('../src/erp-sync/items');
  try {
    pf('PASS', 'warehouse (items.resolveWarehouse)', await items.resolveWarehouse(erp));
  } catch (err) {
    if (canFix) {
      try {
        const group = (await list('Warehouse', [['company', '=', company], ['is_group', '=', 1]], ['name'], 1))[0];
        const r = await erp.createResource('Warehouse', {
          warehouse_name: 'Stores', company, ...(group ? { parent_warehouse: group.name } : {}),
        });
        fixed('Warehouse', r.data?.name, 'stock warehouse');
        items.clearCaches(company);
        pf('PASS', 'warehouse (items.resolveWarehouse)', `${await items.resolveWarehouse(erp)} (created)`);
      } catch (e) {
        pf('FAIL', 'warehouse (items.resolveWarehouse)', H.serverMessage(e), `create "Stores - ${ctx.abbr}"`);
      }
    } else {
      pf('FAIL', 'warehouse (items.resolveWarehouse)', H.serverMessage(err), `create "Stores - ${ctx.abbr}" or run with --fix`);
    }
  }

  // Stock Settings.
  try {
    const ss = await getDoc('Stock Settings', 'Stock Settings');
    pf(Number(ss.allow_negative_stock) ? 'WARN' : 'PASS', 'Stock Settings allow_negative_stock = 0',
      `allow_negative_stock=${Number(ss.allow_negative_stock) || 0}, valuation=${ss.valuation_method || '?'}, default_warehouse=${ss.default_warehouse || '-'}`,
      'Stock Settings → untick Allow Negative Stock');
  } catch (err) {
    pf('WARN', 'Stock Settings allow_negative_stock = 0', H.serverMessage(err), 'give the API user read on Stock Settings (the bot treats it as defaults)');
  }

  // Rounding method.
  try {
    const sys = await getDoc('System Settings', 'System Settings');
    const r = H.roundingStatus(sys.rounding_method);
    pf(r.status, 'System Settings rounding_method', r.detail, r.hint);
  } catch (err) {
    pf('WARN', 'System Settings rounding_method', H.serverMessage(err), 'could not read System Settings (needs System Manager); check it is "Banker\'s Rounding (legacy)" by hand');
  }

  // Can cleanup delete masters later?
  try {
    const as = await getDoc('Accounts Settings', 'Accounts Settings');
    const on = Number(as.delete_linked_ledger_entries) === 1;
    pf(on ? 'PASS' : 'WARN', 'cleanup can delete ledger rows', `delete_linked_ledger_entries=${on ? 1 : 0}`,
      'cleanup will cancel/delete documents, but SMOKE- accounts/items/parties stay (cancelled ledger rows still link them) unless Accounts Settings → "Delete Accounting and Stock Ledger Entries on deletion of Transaction" is on — only ever on a test site');
  } catch (err) {
    pf('WARN', 'cleanup can delete ledger rows', H.serverMessage(err), 'could not read Accounts Settings');
  }

  // Masters the bot's create calls default to.
  for (const [doctype, name, hint] of [
    ['Customer Group', 'Individual', 'erpnext.createCustomer defaults customer_group to "Individual"'],
    ['Territory', 'All Territories', 'erpnext.createCustomer defaults territory to "All Territories"'],
    ['Supplier Group', 'All Supplier Groups', 'erpnext.createSupplier defaults supplier_group to "All Supplier Groups"'],
    ['Item Group', 'All Item Groups', 'generic items and the Products group hang off it'],
    ['UOM', 'Nos', 'every bot Item is counted in Nos'],
  ]) {
    try {
      pf((await tryGet(doctype, name)) ? 'PASS' : 'FAIL', `${doctype} "${name}"`, '', hint);
    } catch (err) {
      pf('FAIL', `${doctype} "${name}"`, H.serverMessage(err), hint);
    }
  }
  try {
    if (await tryGet('Item Group', items.ITEM_GROUP)) {
      pf('PASS', `Item Group "${items.ITEM_GROUP}"`);
    } else if (canFix) {
      await erp.createResource('Item Group', { item_group_name: items.ITEM_GROUP, parent_item_group: 'All Item Groups', is_group: 0 });
      fixed('Item Group', items.ITEM_GROUP, 'stock items group (as items.ensureItemGroup)');
      pf('PASS', `Item Group "${items.ITEM_GROUP}"`, 'created');
    } else {
      pf('WARN', `Item Group "${items.ITEM_GROUP}"`, 'missing — created with the first stock item', 'or run with --fix');
    }
  } catch (err) {
    pf('FAIL', `Item Group "${items.ITEM_GROUP}"`, H.serverMessage(err), 'API user needs create on Item Group');
  }
  for (const [kind, code] of [['sale', 'GEN-SALE'], ['purchase', 'GEN-PURCHASE']]) {
    try {
      if (await tryGet('Item', code)) {
        pf('PASS', `generic Item ${code}`);
      } else if (canFix) {
        await common.ensureGenericItem(erp, kind);
        fixed('Item', code, 'generic invoice line item (ensureGenericItem)');
        pf('PASS', `generic Item ${code}`, 'created');
      } else {
        pf('WARN', `generic Item ${code}`, 'missing — created with the first untracked invoice line', 'or run with --fix');
      }
    } catch (err) {
      pf('FAIL', `generic Item ${code}`, H.serverMessage(err), 'API user needs create on Item');
    }
  }

  // Print format + download_pdf.
  const format = process.env.ERPNEXT_INVOICE_PRINT_FORMAT;
  if (format) {
    try {
      const pfDoc = await tryGet('Print Format', format);
      if (!pfDoc) pf('FAIL', 'Sales Invoice print format', `"${format}" not found`, 'fix ERPNEXT_INVOICE_PRINT_FORMAT');
      else pf(pfDoc.doc_type === 'Sales Invoice' ? 'PASS' : 'FAIL', 'Sales Invoice print format', `${format} (doc_type ${pfDoc.doc_type}${Number(pfDoc.disabled) ? ', DISABLED' : ''})`,
        'ERPNEXT_INVOICE_PRINT_FORMAT must name a Sales Invoice print format');
    } catch (err) {
      pf('WARN', 'Sales Invoice print format', H.serverMessage(err), 'API user cannot read Print Format');
    }
  } else {
    pf('PASS', 'Sales Invoice print format', 'ERPNEXT_INVOICE_PRINT_FORMAT unset → ERPNext default for Sales Invoice');
  }
  try {
    const sinv = (await list('Sales Invoice', [['company', '=', company], ['docstatus', '=', 1]], ['name'], 1))[0];
    if (!sinv) {
      pf('WARN', 'download_pdf', 'no submitted Sales Invoice yet — tested in flow step l');
    } else {
      const pdf = await erp.getPdf('Sales Invoice', sinv.name, { format: format || undefined });
      pf('PASS', 'download_pdf', `${sinv.name}: ${pdf.length} bytes`);
    }
  } catch (err) {
    pf('FAIL', 'download_pdf', H.serverMessage(err), 'wkhtmltopdf installed on the server? print permission on Sales Invoice for the API user? print format renders?');
  }

  // File upload + delete.
  try {
    const up = await erp.uploadFile({
      buffer: Buffer.from(`smoke preflight ${new Date().toISOString()}\n`),
      filename: `${H.PREFIX}preflight-${Date.now()}.txt`, contentType: 'text/plain', isPrivate: true,
    });
    if (!up.name) throw new Error(`upload_file returned no File name (file_url=${up.file_url})`);
    try {
      await erp.deleteResource('File', up.name);
      pf('PASS', 'File upload (private) + delete', up.file_url);
    } catch (err) {
      pf('FAIL', 'File upload (private) + delete', `uploaded ${up.name}, delete failed: ${H.serverMessage(err)}`, 'API user needs delete on File (the nightly cleanup job deletes outreach uploads)');
    }
  } catch (err) {
    pf('FAIL', 'File upload (private) + delete', H.serverMessage(err), 'API user needs create on File (receipt attachments, invoice PDFs)');
  }

  return { fatal: false };
}

// ── Flows ────────────────────────────────────────────────────────────

async function step(id, label, needs, fn) {
  const s = { id, label, ok: false, checks: [], docs: {} };
  ctx.steps.push(s);
  console.log('');
  console.log(`[${id}] ${label}`);
  const missing = (needs || []).filter((k) => !ctx.ids[k]);
  if (missing.length) {
    s.skipped = `needs ${missing.join(', ')} from an earlier step`;
    console.log(`  – skipped: ${s.skipped}`);
    return s;
  }
  const add = (c) => {
    s.checks.push(c);
    console.log(H.formatCheck(c));
    return c.ok;
  };
  const t = {
    check: (label2, expected, actual, o) => add(H.check(label2, expected, actual, o)),
    that: (label2, ok, expectedText, actual, o) => add(H.checkThat(label2, ok, expectedText, actual, o)),
    gl: (label2, expected, actual, o) => add(H.checkGl(label2, expected, actual, o)),
    note: (msg) => console.log(`    · ${msg}`),
    doc: (key, doctype, name, extra) => {
      s.docs[key] = name;
      track(doctype, name, id, extra);
    },
  };
  try {
    await fn(t, s);
    s.ok = s.checks.every((c) => c.ok || c.soft);
  } catch (err) {
    s.ok = false;
    s.error = errorRecord(err);
    printError(err);
  }
  return s;
}

async function flows() {
  const { saveDraft } = require('../src/erp-sync');
  const common = require('../src/erp-sync/common');
  const taxes = require('../src/erp-sync/taxes');
  const items = require('../src/erp-sync/items');
  const { whtOverpaymentError } = require('../src/erp-sync/payment-entry');
  const wallets = require('../src/wallets');
  const counterparties = require('../src/counterparties');
  const exchange = require('../src/exchange');
  const { getOpenInvoices } = require('../src/erp-query/open-invoices');
  const { getBalanceWithCounterparty } = require('../src/erp-query/counterparty-balance');
  const { getTransactionSummary } = require('../src/erp-query/transaction-summary');
  const { getCashBankBalance } = require('../src/erp-query/cash-balance');
  const { getStock } = require('../src/erp-query/stock');

  const { erp, user, ids, acc } = ctx;
  const B = ctx.base;
  const F = ctx.foreign;
  const c = ctx.company;
  const backDate = H.addDays(TODAY, -20);
  const cat = async (code) => common.resolveErpAccount(user, erp, code, B);
  const save = async (t, key, draft) => {
    const r = await saveDraft(user, erp, draft);
    t.doc(key, r.doctype, r.erpnext_name);
    t.note(`${r.doctype} ${r.erpnext_name}`);
    return r;
  };
  const partyOwes = async (name) => {
    const r = await getBalanceWithCounterparty(user, erp, { counterparty_search: name });
    return r.found ? { owes_you: r.owes_you, you_owe: r.you_owe } : { owes_you: {}, you_owe: {} };
  };

  section('Flows');

  // a. wallets
  await step('a', 'create wallets', [], async (t) => {
    const specs = [
      ['cash', `${H.PREFIX}Cash`, '1000', B, 'Cash'],
      ['bank', `${H.PREFIX}Bank`, '1100', B, 'Bank'],
      ['bankFx', `${H.PREFIX}Bank-${F}`, '1100', F, 'Bank'],
      ['card', `${H.PREFIX}Card`, '2100', B, null],
    ];
    for (const [key, name, parentCode, cur, accountType] of specs) {
      const erpName = `${name} - ${ctx.abbr}`;
      const before = await tryGet('Account', erpName);
      let wallet;
      try {
        const r = await wallets.create(user, erp, { name, parent_code: parentCode, currency: cur });
        if (!r.ok) throw new Error(r.error);
        wallet = r.wallet;
        t.note(`${name}: ${r.existed ? 'existed' : 'created'} → ${wallet.erpnext_account}`);
      } catch (err) {
        if (!before) throw err;
        // A re-run: the account is in ERPNext from an earlier run but this run's cache is fresh
        // (a real bot keeps the cache row). Adopt it as the bot's cache would hold it.
        t.note(`${name}: wallets.create on a re-run → ${H.serverMessage(err)}; adopting the existing account`);
        const now = new Date().toISOString();
        const type = { 1000: 'Cash', 1100: 'Bank', 2100: 'Credit Card' }[parentCode];
        const row = (await ctx.db.query(
          `INSERT INTO account_cache (user_id, name, account_type, currency, erpnext_account_name, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 1, $6, $6)
           ON CONFLICT (user_id, name, currency) DO UPDATE SET account_type = EXCLUDED.account_type,
             erpnext_account_name = EXCLUDED.erpnext_account_name, is_active = 1
           RETURNING *`,
          [user.id, name, type, cur, erpName, now]
        )).rows[0];
        wallet = { id: row.id, name, erpnext_account: erpName, currency: cur };
      }
      ids[key] = wallet.id;
      acc[key] = wallet.erpnext_account;
      t.doc(key, 'Account', wallet.erpnext_account);
      const a = await getDoc('Account', wallet.erpnext_account);
      t.check(`${name} account_currency`, cur, a.account_currency);
      if (accountType) t.check(`${name} account_type`, accountType, a.account_type);
      else t.check(`${name} is a liability (credit card)`, 'Liability', a.root_type);
      t.check(`${name} is a ledger`, 0, Number(a.is_group));
    }
    // A wallet listed under two names would be double-counted in the balance answer.
    const listed = await wallets.list(user, erp);
    const byAccount = {};
    for (const w of listed.filter((x) => Object.values(acc).includes(x.erpnext_account))) {
      (byAccount[w.erpnext_account] ||= []).push(w.name);
    }
    const dups = Object.fromEntries(Object.entries(byAccount).filter(([, v]) => v.length > 1));
    t.check('each SMOKE wallet listed once by wallets.list', {}, dups, { soft: true });
    for (const k of ['cash', 'bank', 'bankFx', 'card']) ctx.bal0[k] = await balance(acc[k]);
    t.note(`opening balances: ${JSON.stringify(ctx.bal0)}`);
  });

  // b. opening balance
  await step('b', `opening balance 50,000 ${B} into ${H.PREFIX}Bank`, ['bank'], async (t) => {
    const obe = await cat('3200');
    if (!obe) throw new Error('category 3200 (Opening Balance Equity) does not resolve — see preflight');
    const obe0 = await balance(obe);
    const bank0 = await balance(acc.bank);
    const r = await save(t, 'je', {
      transaction_type: 'cash', direction: 'income', amount: 50000, currency: B, transaction_date: TODAY,
      category_code: '3200', payment_account_id: ids.bank, description: 'SMOKE opening balance',
    });
    t.check('doctype', 'Journal Entry', r.doctype);
    t.check('submitted', 1, (await getDoc('Journal Entry', r.erpnext_name)).docstatus);
    t.gl('GL', { [acc.bank]: 50000, [obe]: -50000 }, await glNetOf(r.erpnext_name));
    t.check(`${H.PREFIX}Bank balance +50,000`, 50000, H.round2((await balance(acc.bank)) - bank0));
    t.check('Opening Balance Equity −50,000', -50000, H.round2((await balance(obe)) - obe0));
    addDelta('bank', 50000);
  });

  // c. cash expense
  await step('c', `cash expense 850 ${B} Meals from ${H.PREFIX}Cash`, ['cash'], async (t) => {
    const meals = await cat('5100');
    const r = await save(t, 'je', {
      transaction_type: 'cash', direction: 'expense', amount: 850, currency: B, transaction_date: TODAY,
      category_code: '5100', payment_account_id: ids.cash, description: 'SMOKE lunch',
    });
    t.check('doctype', 'Journal Entry', r.doctype);
    t.gl('GL', { [meals]: 850, [acc.cash]: -850 }, await glNetOf(r.erpnext_name));
    addDelta('cash', -850);
  });

  // d. transfer
  await step('d', `transfer 5,000 ${H.PREFIX}Bank → ${H.PREFIX}Cash`, ['bank', 'cash'], async (t) => {
    const r = await save(t, 'je', {
      transaction_type: 'cash', direction: 'transfer', amount: 5000, currency: B, transaction_date: TODAY,
      payment_account_id: ids.bank, transfer_destination_account_id: ids.cash,
    });
    t.gl('GL', { [acc.cash]: 5000, [acc.bank]: -5000 }, await glNetOf(r.erpnext_name));
    addDelta('cash', 5000);
    addDelta('bank', -5000);
  });

  // e. foreign-currency sales invoice, back-dated
  await step('e', `${F} sales invoice 45,000 to ${H.PREFIX}Jameel, net_30, back-dated 20 days`, [], async (t) => {
    const fx = await exchange.fetchRate(F, B, backDate);
    ctx.rate1 = fx.rate || 32.5;
    t.note(fx.rate ? `rate ${F}→${B} on ${fx.date_used}: ${fx.rate} (frankfurter)` : `rate lookup failed (${fx.error}); using fallback 32.5`);
    ctx.jameel0 = await partyOwes(`${H.PREFIX}Jameel`);
    const r = await save(t, 'sinv', {
      transaction_type: 'invoice_issued', direction: 'income', amount: 45000, currency: F, exchange_rate: ctx.rate1,
      transaction_date: backDate, category_code: '4000', counterparty_name: `${H.PREFIX}Jameel`, payment_terms: 'net_30',
      description: 'SMOKE ruby 7.68ct',
    });
    ids.sinvFx = r.erpnext_name;
    const contact = await counterparties.findByName(user, `${H.PREFIX}Jameel`);
    ids.jameel = contact?.id;
    if (contact?.erpnext_customer) t.doc('customer', 'Customer', contact.erpnext_customer);
    const inv = await getDoc('Sales Invoice', r.erpnext_name);
    const debtors = await common.resolvePartyAccount(erp, 'Receivable', F);
    acc.debtorsFx = debtors;
    t.check('posting_date kept (back-dated)', backDate, inv.posting_date);
    t.check('due_date = posting + 30', H.addDays(backDate, 30), inv.due_date);
    t.check('currency', F, inv.currency);
    t.check(`debit_to is the ${F} receivable`, debtors, inv.debit_to);
    t.check('debit_to account currency', F, await common.getAccountCurrency(erp, inv.debit_to));
    t.check('conversion_rate', ctx.rate1, inv.conversion_rate, { tol: 1e-6 });
    t.check('grand_total', 45000, inv.grand_total);
    t.check('outstanding_amount', 45000, inv.outstanding_amount);
    const base = H.round2(45000 * ctx.rate1);
    t.gl('GL (company currency)', { [inv.debit_to]: base, [await cat('4000')]: -base }, await glNetOf(r.erpnext_name));
  });

  // f. partial payment into the company-currency bank, then full settlement into the FX bank
  await step('f', `payments: 400 ${F} into ${H.PREFIX}Bank, rest into ${H.PREFIX}Bank-${F}`, ['sinvFx', 'jameel', 'bank', 'bankFx'], async (t) => {
    const rate2 = Number((ctx.rate1 * 1.02).toFixed(4));
    const rate3 = Number((ctx.rate1 * 0.99).toFixed(4));
    ctx.rate2 = rate2;
    t.note(`invoice rate ${ctx.rate1}, partial at ${rate2}, settlement at ${rate3}`);
    const base = {
      transaction_type: 'payment', direction: 'income', currency: F, transaction_date: TODAY,
      parent_invoice_name: ids.sinvFx, parent_invoice_doctype: 'Sales Invoice', counterparty_id: ids.jameel,
    };
    const p1 = await save(t, 'pe_partial', { ...base, amount: 400, exchange_rate: rate2, payment_account_id: ids.bank });
    const pe1 = await getDoc('Payment Entry', p1.erpnext_name);
    t.check('partial: paid_from', acc.debtorsFx, pe1.paid_from);
    t.check('partial: paid_to', acc.bank, pe1.paid_to);
    t.check(`partial: received_amount (${B})`, H.round2(400 * rate2), pe1.received_amount);
    t.check('partial: allocated to the invoice', [ids.sinvFx, 400],
      [pe1.references?.[0]?.reference_name, pe1.references?.[0]?.allocated_amount]);
    t.check('invoice outstanding after partial', 44600, (await getDoc('Sales Invoice', ids.sinvFx)).outstanding_amount);
    addDelta('bank', H.round2(400 * rate2));

    const fx0 = await balance(acc.bankFx);
    const p2 = await save(t, 'pe_full', { ...base, amount: 44600, exchange_rate: rate3, payment_account_id: ids.bankFx });
    t.check('invoice outstanding after settlement', 0, (await getDoc('Sales Invoice', ids.sinvFx)).outstanding_amount);
    t.check(`${H.PREFIX}Bank-${F} balance +44,600 ${F}`, 44600, H.round2((await balance(acc.bankFx)) - fx0));
    addDelta('bankFx', 44600);

    // Exchange gain/loss: in the Payment Entry itself (v14 deductions) or a separate
    // "Exchange Gain Or Loss" Journal Entry referencing the invoice (v15).
    const fxAccount = c.exchange_gain_loss_account;
    if (!fxAccount) {
      t.that('Exchange Gain/Loss account set on Company', false, 'set', '(unset)');
      return;
    }
    const vouchers = [p1.erpnext_name, p2.erpnext_name];
    try {
      const rows = await erp.callMethod('frappe.client.get_list', {
        doctype: 'Journal Entry Account', parent: 'Journal Entry',
        filters: [['reference_name', '=', ids.sinvFx]], fields: ['parent'], limit_page_length: 50,
      });
      for (const name of [...new Set((rows.message || []).map((x) => x.parent))]) {
        const je = await tryGet('Journal Entry', name);
        if (je && je.docstatus === 1) {
          vouchers.push(name);
          t.doc(`fx_je_${name}`, 'Journal Entry', name, { auto: true });
          t.note(`ERPNext posted ${je.voucher_type} ${name}`);
        }
      }
    } catch (err) {
      t.note(`could not list Journal Entries referencing ${ids.sinvFx}: ${H.serverMessage(err)}`);
    }
    const fxLines = await list('GL Entry', [['account', '=', fxAccount], ['voucher_no', 'in', vouchers], ['is_cancelled', '=', 0]],
      ['voucher_no', 'debit', 'credit'], 100);
    const net = H.round2(fxLines.reduce((s, g) => s + (g.debit || 0) - (g.credit || 0), 0));
    t.that(`Exchange Gain/Loss GL posted on ${fxAccount}`, fxLines.length > 0, 'at least one GL line', `${fxLines.length} lines, net ${net}`);
    // gain on the partial (credit), loss on the settlement (debit)
    const expected = H.round2(-H.round2(400 * rate2 - 400 * ctx.rate1) - H.round2(44600 * rate3 - 44600 * ctx.rate1));
    t.check('Exchange Gain/Loss amount (Dr − Cr)', expected, net, { tol: 0.05, soft: true });
  });

  // g. bill + payment
  await step('g', `bill from ${H.PREFIX}Acme 12,000 COGS net_15, paid from ${H.PREFIX}Bank`, ['bank'], async (t) => {
    const r = await save(t, 'pinv', {
      transaction_type: 'bill_received', direction: 'expense', amount: 12000, currency: B, transaction_date: TODAY,
      category_code: '5000', counterparty_name: `${H.PREFIX}Acme`, payment_terms: 'net_15',
      invoice_number: 'SMOKE-ACME-77', description: 'SMOKE stones',
    });
    ids.pinvAcme = r.erpnext_name;
    const contact = await counterparties.findByName(user, `${H.PREFIX}Acme`);
    if (contact?.erpnext_supplier) t.doc('supplier', 'Supplier', contact.erpnext_supplier);
    const inv = await getDoc('Purchase Invoice', r.erpnext_name);
    t.check('doctype', 'Purchase Invoice', r.doctype);
    t.check('bill_no', 'SMOKE-ACME-77', inv.bill_no);
    t.check('due_date = today + 15', H.addDays(TODAY, 15), inv.due_date);
    t.check('credit_to = company payable', c.default_payable_account, inv.credit_to);
    t.check('outstanding_amount', 12000, inv.outstanding_amount);
    t.gl('GL', { [inv.credit_to]: -12000, [await cat('5000')]: 12000 }, await glNetOf(r.erpnext_name));

    const pay = {
      transaction_type: 'payment', direction: 'expense', amount: 12000, currency: B, transaction_date: TODAY,
      parent_invoice_name: r.erpnext_name, parent_invoice_doctype: 'Purchase Invoice',
      counterparty_name: `${H.PREFIX}Acme`, payment_account_id: ids.bank,
    };
    t.check('whtOverpaymentError (no WHT)', null, await whtOverpaymentError(erp, pay));
    const p = await save(t, 'pe', pay);
    t.check('bill outstanding after payment', 0, (await getDoc('Purchase Invoice', r.erpnext_name)).outstanding_amount);
    t.gl('payment GL', { [inv.credit_to]: 12000, [acc.bank]: -12000 }, await glNetOf(p.erpnext_name));
    addDelta('bank', -12000);
  });

  // h. VAT / WHT
  await step('h', `VAT 7% + WHT 3% bill from ${H.PREFIX}Siam; VAT-inclusive sales invoice 1,070`, [], async (t) => {
    const billDraft = {
      transaction_type: 'bill_received', direction: 'expense', amount: 10000, currency: B, transaction_date: TODAY,
      category_code: '5700', counterparty_name: `${H.PREFIX}Siam`, payment_terms: 'net_30',
      tax_rate: 7, tax_inclusive: false, wht_rate: 3, wht_form: 'PND53', description: 'SMOKE consulting',
    };
    const tt = taxes.computeTotals(billDraft);
    t.check('computeTotals (card figures)', { net: 10000, vat: 700, gross: 10700, wht: 300, due: 10400 },
      { net: tt.net, vat: tt.vat, gross: tt.gross, wht: tt.wht, due: tt.due });
    const r = await save(t, 'pinv', billDraft);
    ids.pinvVat = r.erpnext_name;
    const contact = await counterparties.findByName(user, `${H.PREFIX}Siam`);
    if (contact?.erpnext_supplier) t.doc('supplier', 'Supplier', contact.erpnext_supplier);
    const inv = await getDoc('Purchase Invoice', r.erpnext_name);
    t.check('tax rows', [['VAT 7%', 'Add', 700], ['WHT 3% (PND53)', 'Deduct', 300]],
      (inv.taxes || []).map((x) => [x.description, x.add_deduct_tax, x.tax_amount]));
    t.check('grand_total (gross − WHT)', 10400, inv.grand_total);
    t.check('outstanding_amount', 10400, inv.outstanding_amount);
    const inputVat = await taxes.resolveTaxAccount(erp, 'input_vat');
    const wht = await taxes.resolveTaxAccount(erp, 'wht_payable');
    t.gl('GL', { [inv.credit_to]: -10400, [await cat('5700')]: 10000, [inputVat]: 700, [wht]: -300 }, await glNetOf(r.erpnext_name));
    const over = await whtOverpaymentError(erp, {
      transaction_type: 'payment', direction: 'expense', amount: 10700, currency: B,
      parent_invoice_name: r.erpnext_name, parent_invoice_doctype: 'Purchase Invoice',
    });
    t.that('paying the gross 10,700 is refused (whtOverpaymentError)', !!over, 'an error string', over);

    const r2 = await save(t, 'sinv', {
      transaction_type: 'invoice_issued', direction: 'income', amount: 1070, currency: B, transaction_date: TODAY,
      category_code: '4000', counterparty_name: `${H.PREFIX}Walkin`, payment_terms: 'net_7',
      tax_rate: 7, tax_inclusive: true, description: 'SMOKE pendant',
    });
    ids.sinvVat = r2.erpnext_name;
    const walkin = await counterparties.findByName(user, `${H.PREFIX}Walkin`);
    if (walkin?.erpnext_customer) t.doc('customer', 'Customer', walkin.erpnext_customer);
    const si = await getDoc('Sales Invoice', r2.erpnext_name);
    const outputVat = await taxes.resolveTaxAccount(erp, 'output_vat');
    t.check('inclusive: tax rows', [['VAT 7%', 70]], (si.taxes || []).map((x) => [x.description, x.tax_amount]));
    t.check('inclusive: net_total', 1000, si.net_total);
    t.check('inclusive: grand_total', 1070, si.grand_total);
    t.check('inclusive: outstanding_amount', 1070, si.outstanding_amount);
    t.gl('inclusive: GL', { [si.debit_to]: 1070, [await cat('4000')]: -1000, [outputVat]: -70 }, await glNetOf(r2.erpnext_name));
  });

  // i. advance given + repaid
  await step('i', `advance 3,000 to ${H.PREFIX}Jackie, repaid (settles_advance)`, ['cash'], async (t) => {
    const before = await partyOwes(`${H.PREFIX}Jackie`);
    const r = await save(t, 'je', {
      transaction_type: 'advance_given', direction: 'expense', amount: 3000, currency: B, transaction_date: TODAY,
      counterparty_name: `${H.PREFIX}Jackie`, payment_account_id: ids.cash,
    });
    const contact = await counterparties.findByName(user, `${H.PREFIX}Jackie`);
    if (contact?.erpnext_customer) t.doc('customer', 'Customer', contact.erpnext_customer);
    const debtors = await common.resolvePartyAccount(erp, 'Receivable', B);
    t.gl('advance GL', { [debtors]: 3000, [acc.cash]: -3000 }, await glNetOf(r.erpnext_name));
    const mid = await partyOwes(`${H.PREFIX}Jackie`);
    t.check(`${H.PREFIX}Jackie owes you +3,000`, H.round2((before.owes_you[B] || 0) + 3000), mid.owes_you[B] || 0);
    const p = await save(t, 'pe', {
      transaction_type: 'payment', direction: 'income', amount: 3000, currency: B, transaction_date: TODAY,
      counterparty_id: contact.id, settles_advance: true, payment_account_id: ids.cash,
    });
    t.gl('repayment GL', { [acc.cash]: 3000, [debtors]: -3000 }, await glNetOf(p.erpnext_name));
    const after = await partyOwes(`${H.PREFIX}Jackie`);
    t.check(`${H.PREFIX}Jackie balance back to where it was (0 on a fresh Company)`, before, after);
  });

  // j. stock
  await step('j', `stock: buy ${H.PREFIX}PA2293 for 50,000 from ${H.PREFIX}Gem, sell to ${H.PREFIX}Jameel for 80,000 ${F}`, ['jameel'], async (t) => {
    const code = `${H.PREFIX}PA2293`;
    const erpItem = `${items.normalizeItemCode(code)}-${ctx.abbr}`;
    const wh = await items.resolveWarehouse(erp);
    const bin0 = await items.binFor(erp, erpItem, wh);
    t.note(`item ${erpItem} in ${wh}; Bin before: ${bin0.actual_qty} @ ${bin0.valuation_rate}`);
    const line = { item_code: code, description: 'SMOKE ruby 7.68ct', qty: 1 };
    const r = await save(t, 'pinv', {
      transaction_type: 'bill_received', direction: 'expense', amount: 50000, currency: B, transaction_date: TODAY,
      category_code: '5000', counterparty_name: `${H.PREFIX}Gem`, payment_terms: 'net_0',
      items: [{ ...line, rate: 50000 }],
    });
    const gem = await counterparties.findByName(user, `${H.PREFIX}Gem`);
    if (gem?.erpnext_supplier) t.doc('supplier', 'Supplier', gem.erpnext_supplier);
    t.doc('item', 'Item', erpItem);
    const pinv = await getDoc('Purchase Invoice', r.erpnext_name);
    t.check('update_stock', 1, Number(pinv.update_stock));
    t.check('stock row item / warehouse', [erpItem, wh], [pinv.items?.[0]?.item_code, pinv.items?.[0]?.warehouse]);
    const item = await getDoc('Item', erpItem);
    t.check('Item is a stock item in Products, Nos', [1, items.ITEM_GROUP, 'Nos'], [Number(item.is_stock_item), item.item_group, item.stock_uom]);
    const bin1 = await items.binFor(erp, erpItem, wh);
    t.check('Bin qty +1', bin0.actual_qty + 1, bin1.actual_qty);
    if (!bin0.actual_qty) t.check('Bin valuation_rate', 50000, bin1.valuation_rate);
    const whDoc = await getDoc('Warehouse', wh);
    const stockAccount = whDoc.account || c.default_inventory_account;
    t.gl('purchase GL', { [pinv.credit_to]: -50000, [stockAccount]: 50000 }, await glNetOf(r.erpnext_name));

    const saleItems = [{ ...line, rate: 80000 }];
    t.check('stockShortfall before the sale', null, await items.stockShortfall(user, erp, saleItems, TODAY));
    const now = await exchange.fetchRate(F, B);
    const rate = now.rate || ctx.rate1;
    const s = await save(t, 'sinv', {
      transaction_type: 'invoice_issued', direction: 'income', amount: 80000, currency: F, exchange_rate: rate,
      transaction_date: TODAY, category_code: '4000', counterparty_id: ids.jameel, payment_terms: 'net_30',
      items: saleItems,
    });
    ids.sinvStock = s.erpnext_name;
    const si = await getDoc('Sales Invoice', s.erpnext_name);
    t.check('sale update_stock', 1, Number(si.update_stock));
    const bin2 = await items.binFor(erp, erpItem, wh);
    t.check('Bin qty back to before', bin0.actual_qty, bin2.actual_qty);
    const base = H.round2(80000 * rate);
    t.gl('sale GL (COGS at valuation)', {
      [si.debit_to]: base, [await cat('4000')]: -base, [await cat('5000')]: 50000, [stockAccount]: -50000,
    }, await glNetOf(s.erpnext_name), { soft: bin0.actual_qty > 0 });

    const one = await getStock(user, erp, { item_code: code });
    ctx.queries.stock_item = one;
    t.check(`getStock(${code}) qty`, bin0.actual_qty, (one.rows || []).reduce((n, x) => n + x.qty, 0));
    const all = await getStock(user, erp);
    ctx.queries.stock = all;
    t.note(`getStock(): ${all.rows.length} rows, total value ${all.total_value} ${all.currency}`);
  });

  // k. queries
  await step('k', 'queries: open invoices, balance with Jameel, summary, cash/bank', [], async (t) => {
    const open = await getOpenInvoices(user, erp, { direction: 'both', limit: 50, sort: 'newest' });
    ctx.queries.open_invoices = open;
    console.log(`    open invoices: ${open.total_count} — totals ${JSON.stringify(open.totals_by_currency)}`);
    for (const row of open.rows.slice(0, 10)) {
      console.log(`      ${row.ref}  ${row.kind}  ${row.counterparty}  ${row.outstanding} ${row.currency}  due ${row.due_date}`);
    }
    const refs = new Set(open.rows.map((x) => x.ref));
    for (const k of ['sinvVat', 'pinvVat', 'sinvStock']) if (ids[k]) t.check(`open: ${ids[k]} listed`, true, refs.has(ids[k]));
    for (const k of ['sinvFx', 'pinvAcme']) if (ids[k]) t.check(`open: settled ${ids[k]} not listed`, false, refs.has(ids[k]));

    if (ids.jameel) {
      const bal = await getBalanceWithCounterparty(user, erp, { counterparty_id: ids.jameel });
      ctx.queries.balance_jameel = bal;
      console.log(`    balance with ${H.PREFIX}Jameel: owes you ${JSON.stringify(bal.owes_you)}, you owe ${JSON.stringify(bal.you_owe)}, open invoices ${bal.open_invoices}`);
      const expected = H.round2(((ctx.jameel0 && ctx.jameel0.owes_you[F]) || 0) + (ids.sinvStock ? 80000 : 0));
      t.check(`${H.PREFIX}Jameel owes you (${F})`, expected, bal.owes_you[F] || 0);
    }

    const exp = await getTransactionSummary(user, erp, { direction: 'expense', group_by: 'category', date_from: backDate });
    const inc = await getTransactionSummary(user, erp, { direction: 'income', group_by: 'category', date_from: backDate });
    ctx.queries.summary_expense = exp;
    ctx.queries.summary_income = inc;
    console.log(`    expenses since ${backDate}: ${exp.total} ${exp.currency} — ${exp.groups.map((g) => `${g.key} ${g.total}`).join(', ')}`);
    console.log(`    income since ${backDate}:   ${inc.total} ${inc.currency} — ${inc.groups.map((g) => `${g.key} ${g.total}`).join(', ')}`);
    const group = (sum, account) => sum.groups.find((g) => g.key === common.friendlyAccountName(account))?.total || 0;
    const minimums = [];
    if (ctx.steps.find((s) => s.id === 'c')?.ok) minimums.push([exp, await cat('5100'), 850]);
    if (ids.pinvAcme) minimums.push([exp, await cat('5000'), 12000 + (ids.sinvStock ? 50000 : 0)]);
    if (ids.pinvVat) minimums.push([exp, await cat('5700'), 10000]);
    if (ids.sinvVat) minimums.push([inc, await cat('4000'), 1000 + (ids.sinvFx ? H.round2(45000 * ctx.rate1) : 0)]);
    for (const [sum, account, min] of minimums) {
      const got = group(sum, account);
      t.that(`summary ${common.friendlyAccountName(account)} ≥ ${min}`, got >= min - 0.005, `≥ ${min}`, got);
    }

    const cb = await getCashBankBalance(user, erp);
    ctx.queries.cash_bank = cb;
    console.log(`    cash/bank totals: ${JSON.stringify(cb.totals_by_currency)}`);
    for (const a of cb.accounts.filter((x) => x.name.startsWith(H.PREFIX))) console.log(`      ${a.name} (${a.type}) ${a.balance} ${a.currency}`);
    for (const k of ['cash', 'bank', 'bankFx', 'card']) {
      if (!ids[k] || ctx.bal0[k] == null) continue;
      const row = cb.accounts.find((x) => x.id === ids[k]);
      t.check(`getCashBankBalance ${k}`, H.round2(ctx.bal0[k] + (ctx.delta[k] || 0)), row ? row.balance : null);
    }
  });

  // l. PDF + uploads
  await step('l', 'getPdf of the sales invoice, private attachment, public upload + delete', ['sinvFx'], async (t) => {
    const name = ids.sinvFx;
    const pdf = await erp.getPdf('Sales Invoice', name, { format: process.env.ERPNEXT_INVOICE_PRINT_FORMAT || undefined });
    t.that('getPdf returns a PDF', pdf.subarray(0, 5).toString('latin1') === '%PDF-', '%PDF- header', `${pdf.length} bytes`);

    const priv = await erp.uploadFile({
      buffer: pdf, filename: `${H.PREFIX}${name}.pdf`, contentType: 'application/pdf', isPrivate: true,
      doctype: 'Sales Invoice', docname: name,
    });
    t.doc('file_private', 'File', priv.name);
    const f = await getDoc('File', priv.name);
    t.check('private file attached to the invoice', ['Sales Invoice', name, 1], [f.attached_to_doctype, f.attached_to_name, Number(f.is_private)]);
    t.that('private file_url under /private/files/', String(priv.file_url).startsWith('/private/files/'), '/private/files/…', priv.file_url);
    const anon = await fetch(`${ctx.baseUrl}${priv.file_url}`, { redirect: 'manual' });
    const anonBody = Buffer.from(await anon.arrayBuffer());
    t.that('private file is not served without auth', anonBody.subarray(0, 5).toString('latin1') !== '%PDF-', 'no PDF without auth', `HTTP ${anon.status}`);

    const text = `smoke public ${Date.now()} ${Math.random().toString(36).slice(2)}`;
    const pub = await erp.uploadFile({
      buffer: Buffer.from(text), filename: `${H.PREFIX}public-${Math.random().toString(36).slice(2, 10)}.txt`,
      contentType: 'text/plain', isPrivate: false,
    });
    t.doc('file_public', 'File', pub.name);
    t.that('public file_url under /files/', String(pub.file_url).startsWith('/files/'), '/files/…', pub.file_url);
    const got = await fetch(`${ctx.baseUrl}${pub.file_url}`);
    t.check('public file readable without auth (Twilio fetches it this way)', [200, text], [got.status, await got.text()]);
    await erp.deleteResource('File', pub.name);
    t.check('public file deleted', null, await tryGet('File', pub.name));
    ctx.created = ctx.created.filter((x) => !(x.doctype === 'File' && x.name === pub.name));
  });
}

// ── Cleanup ──────────────────────────────────────────────────────────

async function cleanup(created) {
  section('Cleanup');
  const order = H.cleanupOrder(created);
  const result = { removed: [], failed: [], left_alone: [] };
  const masters = new Set(['Customer', 'Supplier', 'Account', 'Item']);
  const gone = new Set();
  const key = (c) => `${c.doctype}|${c.name}`;

  // Pass 1: cancel submitted documents (payments → invoices → JEs; newest first).
  for (const c of order.filter((x) => H.isSubmittable(x.doctype))) {
    try {
      const doc = await tryGet(c.doctype, c.name);
      if (!doc) {
        gone.add(key(c));
        console.log(`  · ${c.doctype} ${c.name} already gone`);
        continue;
      }
      if (doc.docstatus === 1) {
        await cancelDoc(c.doctype, c.name);
        console.log(`  ✔ cancelled ${c.doctype} ${c.name}`);
      }
    } catch (err) {
      result.failed.push({ doctype: c.doctype, name: c.name, action: 'cancel', error: H.serverMessage(err) });
      console.log(`  ✖ cancel ${c.doctype} ${c.name}: ${H.serverMessage(err)}`);
    }
  }

  // Pass 2: delete everything, same order (Files, Items, parties, accounts last).
  for (const c of order) {
    if (gone.has(key(c))) {
      result.removed.push({ doctype: c.doctype, name: c.name, note: 'already gone' });
      continue;
    }
    if (result.failed.some((f) => f.doctype === c.doctype && f.name === c.name)) continue;
    if (masters.has(c.doctype) && !(await isSmokeMaster(c))) {
      result.left_alone.push({ doctype: c.doctype, name: c.name, why: 'not a SMOKE- record' });
      console.log(`  · left ${c.doctype} ${c.name} alone (not a SMOKE- record)`);
      continue;
    }
    try {
      await ctx.erp.deleteResource(c.doctype, c.name);
      result.removed.push({ doctype: c.doctype, name: c.name });
      console.log(`  ✔ deleted ${c.doctype} ${c.name}`);
    } catch (err) {
      if (err.status === 404) {
        result.removed.push({ doctype: c.doctype, name: c.name, note: 'already gone' });
        continue;
      }
      result.failed.push({ doctype: c.doctype, name: c.name, action: 'delete', error: H.serverMessage(err) });
      console.log(`  ✖ delete ${c.doctype} ${c.name}: ${H.serverMessage(err)}`);
    }
  }
  console.log(`  ${result.removed.length} removed, ${result.failed.length} could not be removed`);
  if (result.failed.some((f) => masters.has(f.doctype))) {
    console.log('  → accounts/items/parties with cancelled ledger rows can only be deleted when Accounts Settings →');
    console.log('    "Delete Accounting and Stock Ledger Entries on deletion of Transaction" is on (test sites only).');
  }
  return result;
}

/** Masters are only deleted when their name or title says SMOKE (naming series can hide it in the name). */
async function isSmokeMaster(c) {
  const smoke = (v) => String(v || '').toUpperCase().startsWith('SMOKE');
  if (smoke(c.name)) return true;
  try {
    const d = await tryGet(c.doctype, c.name);
    return !d || [d.customer_name, d.supplier_name, d.item_name, d.account_name].some(smoke);
  } catch {
    return false;
  }
}

async function cleanupOnly() {
  let previous;
  try {
    previous = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
  } catch (err) {
    console.error(`[smoke] cannot read ${REPORT_PATH}: ${err.message}`);
    return 2;
  }
  if (previous.tool !== 'smoke-erpnext') {
    console.error(`[smoke] ${REPORT_PATH} is not a smoke-erpnext report`);
    return 2;
  }
  if (previous.target && previous.target.company !== ctx.companyName) {
    console.error(`[smoke] report is for company "${previous.target.company}", not "${ctx.companyName}" — pass --company`);
    return 2;
  }
  ctx.created = previous.created || [];
  ctx.previousRun = { started_at: previous.started_at, mode: previous.mode, summary: previous.summary };
  if (!ctx.created.length) {
    console.log('[smoke] the report lists nothing to clean up');
    return 0;
  }
  ctx.cleanup = await cleanup(ctx.created);
  return ctx.cleanup.failed.length ? 1 : 0;
}
