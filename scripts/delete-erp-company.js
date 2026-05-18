/**
 * Delete an ERPNext Company including all its company-scoped records.
 *
 * What is company-scoped (gets deleted):
 *   Sales Invoice, Purchase Invoice, Payment Entry, Journal Entry,
 *   Stock Entry, GL Entry, Stock Ledger Entry,
 *   Account (leaf-first), Warehouse,
 *   Bank Account, Cost Center,
 *   then Company itself.
 *
 * What is GLOBAL (NOT deleted):
 *   Customer, Supplier, Item, Item Group, Address, Contact —
 *   these live at the site level and may be reused by other companies.
 *   ERPNext also stores per-company defaults in child tables on these
 *   docs (Customer.accounts, Item.item_defaults, etc.). Those child
 *   rows become orphans when the parent Company is deleted, which is
 *   harmless.
 *
 * Cancel-then-delete: ERPNext doesn't let you delete submitted docs
 * (docstatus=1). We PUT docstatus=2 first to cancel, then DELETE.
 *
 * DESTRUCTIVE AND IRREVERSIBLE. Triple-check the name.
 *
 *   node scripts/delete-erp-company.js "KruZn Co"
 *   node scripts/delete-erp-company.js "DS Gems" --yes  # skip confirm
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const readline = require('readline');
const { getAdminClient } = require('../src/erp-admin');

const PROTECTED = new Set(['Test Trading Company']);

// Doctypes that have a `company` field (filterable). Order: transactional
// first (depend on accounts/warehouses), then masters, then accounts +
// warehouses, then the Company itself.
const COMPANY_SCOPED_TXN = [
  'Stock Entry',
  'Payment Entry',
  'Sales Invoice',
  'Purchase Invoice',
  'Journal Entry',
  'Delivery Note',
  'Purchase Receipt',
  'Sales Order',
  'Purchase Order',
];
const COMPANY_SCOPED_LEDGER = ['GL Entry', 'Stock Ledger Entry'];
const COMPANY_SCOPED_LATE = ['Cost Center', 'Bank Account', 'Account', 'Warehouse'];

(async () => {
  const args = process.argv.slice(2);
  const company = args.find((a) => !a.startsWith('--'));
  const autoConfirm = args.includes('--yes');

  if (!company) {
    console.error('Usage: node scripts/delete-erp-company.js "<Company Name>" [--yes]');
    process.exit(1);
  }
  if (PROTECTED.has(company)) {
    console.error(`× "${company}" is protected. Edit PROTECTED in this script to override.`);
    process.exit(1);
  }

  const admin = getAdminClient();

  try {
    await admin.getResource('Company', company);
  } catch (err) {
    if (err.status === 404) {
      console.log(`No Company named "${company}" in ERPNext. Nothing to do.`);
      process.exit(0);
    }
    throw err;
  }

  console.log(`\nAbout to delete Company: "${company}"`);
  console.log('Counting dependent records…');
  const counts = await tallyDependents(admin, company);
  for (const [dt, n] of Object.entries(counts)) {
    if (n > 0) console.log(`  ${dt.padEnd(22)} ${n}`);
  }
  console.log('\nIRREVERSIBLE. Customer / Supplier / Item are GLOBAL — they stay.');

  if (!autoConfirm) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) =>
      rl.question(`\nType the company name exactly to confirm: `, (a) => { rl.close(); resolve(a.trim()); })
    );
    if (answer !== company) {
      console.log('Aborted — name didn\'t match.');
      process.exit(0);
    }
  }

  // 0. Null out Company's default-link fields. They hold refs to
  //    cost_center / default_*_account / etc. — without this step,
  //    ERPNext refuses to delete those records ("Cost Center Main - ST
  //    is linked with Company ...").
  await clearCompanyDefaults(admin, company);

  // 1. Cancel + delete transactional docs (most-dependent first).
  for (const dt of COMPANY_SCOPED_TXN) {
    await cancelAndDeleteByCompany(admin, dt, company);
  }

  // 2. Delete ledger entries. These are usually auto-removed when the
  //    parent transaction is cancelled, but mop up any stragglers.
  for (const dt of COMPANY_SCOPED_LEDGER) {
    await deleteByCompany(admin, dt, company);
  }

  // 3. Late-stage company-scoped masters (accounts leaf-first, then the rest).
  await deleteAccountsLeafFirst(admin, company);
  await deleteByCompany(admin, 'Warehouse', company);
  await deleteByCompany(admin, 'Cost Center', company);
  await deleteByCompany(admin, 'Bank Account', company);

  // 4. Per-company Item Group we created during provisioning ("Items - <ABBR>").
  //    Item Group is global, but our naming convention is unique per company.
  try {
    const companyInfo = await admin.getResource('Company', company).catch(() => null);
    const abbr = companyInfo?.data?.abbr;
    if (abbr) {
      const grp = `Items - ${abbr}`;
      try {
        await admin.deleteResource('Item Group', grp);
        console.log(`  deleted Item Group "${grp}"`);
      } catch {
        /* might not exist */
      }
    }
  } catch {
    /* ignore */
  }

  // 5. Delete the Company itself.
  try {
    await admin.deleteResource('Company', company);
    console.log(`\n✓ Company "${company}" deleted from ERPNext.`);
  } catch (err) {
    console.error(`\n× Company delete failed: ${err.message}`);
    console.error('  Likely something is still linked. Check ERPNext UI for what\'s blocking,');
    console.error('  delete it manually, then re-run this script with --yes.');
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  if (err.response) console.error('  response:', JSON.stringify(err.response).slice(0, 600));
  process.exit(1);
});

/**
 * Null out Company default-link fields (cost_center, default_*_account
 * etc.). Without this, ERPNext refuses to delete those linked records.
 * Tolerant: missing fields on this version of ERPNext are skipped.
 */
async function clearCompanyDefaults(admin, company) {
  const FIELDS_TO_CLEAR = [
    'cost_center',
    'round_off_cost_center',
    'depreciation_cost_center',
    'default_cash_account',
    'default_bank_account',
    'default_receivable_account',
    'default_payable_account',
    'default_income_account',
    'default_expense_account',
    'default_employee_advance_account',
    'write_off_account',
    'round_off_account',
    'exchange_gain_loss_account',
    'unrealized_exchange_gain_loss_account',
    'unrealized_profit_loss_account',
    'accumulated_depreciation_account',
    'depreciation_expense_account',
    'disposal_account',
    'capital_work_in_progress_account',
    'asset_received_but_not_billed',
    'stock_received_but_not_billed',
    'stock_adjustment_account',
    'expenses_included_in_valuation',
    'service_received_but_not_billed',
    'default_provisional_account',
    'default_in_transit_warehouse',
    'default_warehouse_for_sales_return',
    'default_buying_terms',
    'default_selling_terms',
    'default_holiday_list',
    'default_finance_book',
    'default_letter_head',
  ];
  const payload = {};
  for (const f of FIELDS_TO_CLEAR) payload[f] = null;
  try {
    await admin.updateResource('Company', company, payload);
    console.log(`  Company defaults cleared (${FIELDS_TO_CLEAR.length} fields)`);
  } catch (err) {
    console.warn(`  Company defaults clear warning: ${err.message.slice(0, 200)}`);
  }
}

async function tallyDependents(admin, company) {
  const counts = {};
  for (const dt of [...COMPANY_SCOPED_TXN, ...COMPANY_SCOPED_LEDGER, 'Account', 'Warehouse', 'Cost Center', 'Bank Account']) {
    try {
      const r = await admin.callMethod('frappe.client.get_count', {
        doctype: dt,
        filters: [['company', '=', company]],
      });
      counts[dt] = Number(r.message) || 0;
    } catch {
      counts[dt] = '?';
    }
  }
  return counts;
}

/**
 * Pull rows in batches, cancel submitted ones (PUT docstatus=2), then
 * delete them all.
 */
async function cancelAndDeleteByCompany(admin, doctype, company) {
  let totalCancelled = 0;
  let totalDeleted = 0;
  let totalSkipped = 0;
  while (true) {
    let r;
    try {
      r = await admin.listResource(doctype, {
        filters: [['company', '=', company]],
        fields: ['name', 'docstatus'],
        limit: 100,
      });
    } catch (err) {
      console.warn(`  ${doctype}: list failed (${err.message}) — skipping`);
      return;
    }
    const rows = r.data || [];
    if (rows.length === 0) break;
    for (const row of rows) {
      try {
        if (row.docstatus === 1) {
          await admin.updateResource(doctype, row.name, { docstatus: 2 });
          totalCancelled += 1;
        }
        await admin.deleteResource(doctype, row.name);
        totalDeleted += 1;
      } catch (err) {
        totalSkipped += 1;
        if (totalSkipped <= 3) {
          console.warn(`    ${doctype} "${row.name}": ${err.message.slice(0, 120)}`);
        }
      }
    }
  }
  if (totalDeleted || totalSkipped) {
    console.log(
      `  ${doctype.padEnd(20)} deleted=${totalDeleted} cancelled=${totalCancelled} skipped=${totalSkipped}`
    );
  }
}

/**
 * Delete rows directly (no cancel step). For doctypes that don't have
 * a docstatus / submission concept (GL Entry, Stock Ledger Entry, etc.).
 */
async function deleteByCompany(admin, doctype, company) {
  let totalDeleted = 0;
  let totalSkipped = 0;
  while (true) {
    let r;
    try {
      r = await admin.listResource(doctype, {
        filters: [['company', '=', company]],
        fields: ['name'],
        limit: 100,
      });
    } catch (err) {
      console.warn(`  ${doctype}: list failed (${err.message}) — skipping`);
      return;
    }
    const rows = r.data || [];
    if (rows.length === 0) break;
    for (const row of rows) {
      try {
        await admin.deleteResource(doctype, row.name);
        totalDeleted += 1;
      } catch (err) {
        totalSkipped += 1;
        if (totalSkipped <= 3) {
          console.warn(`    ${doctype} "${row.name}": ${err.message.slice(0, 120)}`);
        }
      }
    }
  }
  if (totalDeleted || totalSkipped) {
    console.log(`  ${doctype.padEnd(20)} deleted=${totalDeleted} skipped=${totalSkipped}`);
  }
}

/**
 * Accounts have a parent_account chain — delete leaf-first so each
 * delete doesn't choke on "linked with child account".
 */
async function deleteAccountsLeafFirst(admin, company) {
  const r = await admin.listResource('Account', {
    filters: [['company', '=', company]],
    fields: ['name', 'parent_account', 'is_group'],
    limit: 500,
  });
  const accounts = r.data || [];
  if (accounts.length === 0) return;

  const byName = new Map(accounts.map((a) => [a.name, a]));
  function depth(a, seen = new Set()) {
    if (!a.parent_account || seen.has(a.name)) return 0;
    seen.add(a.name);
    const p = byName.get(a.parent_account);
    return p ? 1 + depth(p, seen) : 1;
  }
  accounts.sort((a, b) => depth(b) - depth(a));

  let total = 0;
  let skipped = 0;
  for (const a of accounts) {
    try {
      await admin.deleteResource('Account', a.name);
      total += 1;
    } catch (err) {
      skipped += 1;
      if (skipped <= 3) {
        console.warn(`    Account "${a.name}": ${err.message.slice(0, 120)}`);
      }
    }
  }
  console.log(`  Account              deleted=${total} skipped=${skipped}`);
}
