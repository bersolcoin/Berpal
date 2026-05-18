/**
 * Delete an ERPNext Company including all its dependent records
 * (Customers, Suppliers, Items, Invoices, Payments, Stock, Accounts).
 *
 * Uses ERPNext's built-in delete_company_transactions to wipe all
 * transactional + master records bound to that company, then deletes
 * the Company doctype itself.
 *
 * DESTRUCTIVE AND IRREVERSIBLE. Triple-check the name before confirming.
 *
 *   node scripts/delete-erp-company.js "DS Gems"
 *   node scripts/delete-erp-company.js "KruZn Co" --yes  # skip confirm
 *
 * Reserved names blocklisted to prevent accidents:
 *   "Test Trading Company"  (TTC — the dev tenant)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const readline = require('readline');
const { getAdminClient } = require('../src/erp-admin');

const PROTECTED = new Set(['Test Trading Company']);

(async () => {
  const args = process.argv.slice(2);
  const company = args.find((a) => !a.startsWith('--'));
  const autoConfirm = args.includes('--yes');

  if (!company) {
    console.error('Usage: node scripts/delete-erp-company.js "<Company Name>" [--yes]');
    process.exit(1);
  }
  if (PROTECTED.has(company)) {
    console.error(`× "${company}" is in the protected list. Edit PROTECTED in this script if you really mean to delete it.`);
    process.exit(1);
  }

  const admin = getAdminClient();

  // 1. Confirm the Company exists.
  try {
    await admin.getResource('Company', company);
  } catch (err) {
    if (err.status === 404) {
      console.log(`No Company named "${company}" in ERPNext. Nothing to do.`);
      process.exit(0);
    }
    throw err;
  }

  // 2. Surface dependent counts so the user sees blast radius.
  console.log(`\nAbout to delete Company: "${company}"`);
  console.log('Counting dependent records…');
  const counts = await tallyDependents(admin, company);
  for (const [dt, n] of Object.entries(counts)) {
    if (n > 0) console.log(`  ${dt.padEnd(20)} ${n}`);
  }
  console.log('\nThis will DELETE all of the above + the Company itself.');
  console.log('IRREVERSIBLE.\n');

  if (!autoConfirm) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) =>
      rl.question(`Type the company name exactly to confirm: `, (a) => { rl.close(); resolve(a.trim()); })
    );
    if (answer !== company) {
      console.log('Aborted — name didn\'t match.');
      process.exit(0);
    }
  }

  // 3. Call ERPNext's bulk-transaction-erase method. This nukes
  //    invoices, payments, journal entries, stock entries, ledger,
  //    etc. — everything the standard "Erase Transactions" Company
  //    button does.
  console.log('\nErasing transactions + dependent docs…');
  try {
    const r = await admin.callMethod(
      'erpnext.setup.doctype.company.delete_company_transactions.delete_company_transactions',
      { company_name: company }
    );
    console.log('  done:', r?.message || 'ok');
  } catch (err) {
    console.warn('  warn:', err.message);
  }

  // 4. Some doctypes aren't covered above. Delete the most-likely
  //    leftovers manually so the final Company delete doesn't choke
  //    on LinkExistsError.
  for (const dt of ['Customer', 'Supplier', 'Item', 'Warehouse', 'Item Group', 'Address', 'Contact']) {
    await bulkDeleteByCompany(admin, dt, company);
  }

  // 5. Delete Accounts in leaf-first order (children before parents)
  //    so each delete doesn't fail with "linked with child account".
  await deleteAccountsLeafFirst(admin, company);

  // 6. Finally, delete the Company itself.
  try {
    await admin.deleteResource('Company', company);
    console.log(`\n✓ Company "${company}" deleted from ERPNext.`);
  } catch (err) {
    console.error(`\n× Company delete failed: ${err.message}`);
    console.error('  Some dependents may still be linked. Check ERPNext UI.');
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  if (err.response) console.error('  response:', JSON.stringify(err.response).slice(0, 600));
  process.exit(1);
});

async function tallyDependents(admin, company) {
  const counts = {};
  const doctypes = [
    'Customer', 'Supplier', 'Item',
    'Sales Invoice', 'Purchase Invoice', 'Payment Entry', 'Journal Entry',
    'Account', 'Warehouse', 'Address',
  ];
  for (const dt of doctypes) {
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

async function bulkDeleteByCompany(admin, doctype, company) {
  let total = 0;
  while (true) {
    const r = await admin.listResource(doctype, {
      filters: [['company', '=', company]],
      fields: ['name'],
      limit: 100,
    });
    const docs = r.data || [];
    if (docs.length === 0) break;
    for (const doc of docs) {
      try {
        await admin.deleteResource(doctype, doc.name);
        total += 1;
      } catch (err) {
        console.warn(`    skip ${doctype} "${doc.name}": ${err.message}`);
      }
    }
  }
  if (total > 0) console.log(`  deleted ${total} ${doctype}`);
}

async function deleteAccountsLeafFirst(admin, company) {
  // Sort accounts by depth (parent_account chain length) descending — leaves first.
  const r = await admin.listResource('Account', {
    filters: [['company', '=', company]],
    fields: ['name', 'parent_account', 'is_group'],
    limit: 500,
  });
  const accounts = r.data || [];
  if (accounts.length === 0) return;

  // Depth calc: walk parent_account links.
  const byName = new Map(accounts.map((a) => [a.name, a]));
  function depth(a, seen = new Set()) {
    if (!a.parent_account || seen.has(a.name)) return 0;
    seen.add(a.name);
    const p = byName.get(a.parent_account);
    return p ? 1 + depth(p, seen) : 1;
  }
  accounts.sort((a, b) => depth(b) - depth(a));

  let total = 0;
  for (const a of accounts) {
    try {
      await admin.deleteResource('Account', a.name);
      total += 1;
    } catch (err) {
      console.warn(`    skip Account "${a.name}": ${err.message}`);
    }
  }
  if (total > 0) console.log(`  deleted ${total} Account(s)`);
}
