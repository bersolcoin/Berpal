/**
 * Wipe all test data from the shared ERPNext site — every tenant Company
 * plus the site-global masters our app created (Customers, Suppliers,
 * Items, Contacts, Addresses, custom Item Groups, tenant bot Users,
 * User Permissions).
 *
 * Kept: the base Company (KEEP_COMPANIES), Administrator/Guest and the
 * admin API user, ERPNext's standard Item Groups, Custom Fields, settings.
 *
 * DESTRUCTIVE AND IRREVERSIBLE. Default is a dry run (inventory only).
 *
 *   node scripts/wipe-erp-test-data.js          # dry run — lists what would go
 *   node scripts/wipe-erp-test-data.js --yes    # actually delete
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { execFileSync } = require('child_process');
const path = require('path');
const { getAdminClient } = require('../src/erp-admin');

const KEEP_COMPANIES = new Set(['Test Trading Company']);
const KEEP_USERS = new Set(['Administrator', 'Guest']);
const STANDARD_ITEM_GROUPS = new Set([
  'All Item Groups', 'Products', 'Raw Material', 'Services', 'Sub Assemblies', 'Consumable',
]);

async function listAll(admin, doctype, { filters = null, fields = ['name'] } = {}) {
  const r = await admin.listResource(doctype, { filters, fields, limit: 0 });
  return r.data || [];
}

async function whoAmI(admin) {
  const r = await admin.callMethodGet('frappe.auth.get_logged_user');
  return r.message;
}

async function inventory(admin) {
  const me = await whoAmI(admin);
  const companies = (await listAll(admin, 'Company')).map((r) => r.name);
  const users = (await listAll(admin, 'User', { fields: ['name', 'user_type'] }))
    .filter((u) => !KEEP_USERS.has(u.name) && u.name !== me)
    .map((u) => u.name);
  const itemGroups = (await listAll(admin, 'Item Group'))
    .map((r) => r.name)
    .filter((n) => !STANDARD_ITEM_GROUPS.has(n));
  return {
    me,
    companies: companies.filter((c) => !KEEP_COMPANIES.has(c)),
    keptCompanies: companies.filter((c) => KEEP_COMPANIES.has(c)),
    users,
    userPermissions: (await listAll(admin, 'User Permission')).map((r) => r.name),
    customers: (await listAll(admin, 'Customer')).map((r) => r.name),
    suppliers: (await listAll(admin, 'Supplier')).map((r) => r.name),
    contacts: (await listAll(admin, 'Contact')).map((r) => r.name),
    addresses: (await listAll(admin, 'Address')).map((r) => r.name),
    items: (await listAll(admin, 'Item')).map((r) => r.name),
    itemGroups,
  };
}

function printInventory(inv) {
  console.log(`Admin API user: ${inv.me} (kept)`);
  console.log(`Companies kept: ${inv.keptCompanies.join(', ') || '(none)'}`);
  for (const [k, v] of Object.entries(inv)) {
    if (!Array.isArray(v) || k === 'keptCompanies') continue;
    const preview = v.slice(0, 8).join(', ') + (v.length > 8 ? `, … (+${v.length - 8})` : '');
    console.log(`  ${k.padEnd(16)} ${String(v.length).padStart(4)}  ${preview}`);
  }
}

async function clearCompanyTransactions(admin, company) {
  const created = await admin.createResource('Transaction Deletion Record', { company });
  const name = created.data.name;
  // v16+: the To Delete list must be generated (and saved) before submit.
  await admin.callMethod('run_doc_method', {
    dt: 'Transaction Deletion Record', dn: name, method: 'generate_to_delete_list',
  });
  const doc = (await admin.getResource('Transaction Deletion Record', name)).data;
  await admin.callMethod('frappe.client.submit', { doc });
  // Deletion runs as a background job — poll until it settles.
  for (let i = 0; i < 120; i++) {
    const { status } = (await admin.getResource('Transaction Deletion Record', name)).data;
    if (status === 'Completed') {
      console.log(`  ${name} completed`);
      return;
    }
    if (status === 'Failed') throw new Error(`${name} failed — check it in ERPNext`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`${name} still running after 10 min — check it in ERPNext`);
}

async function deleteAll(admin, doctype, names) {
  let ok = 0;
  const failed = [];
  for (const name of names) {
    try {
      await admin.deleteResource(doctype, name);
      ok++;
    } catch (err) {
      failed.push(`${name}: ${String(err.message).slice(0, 160)}`);
    }
  }
  console.log(`  ${doctype.padEnd(16)} deleted=${ok} failed=${failed.length}`);
  for (const f of failed.slice(0, 5)) console.log(`    × ${f}`);
  return failed.length;
}

(async () => {
  const admin = getAdminClient();
  const apply = process.argv.includes('--yes');

  const inv = await inventory(admin);
  printInventory(inv);
  if (!apply) {
    console.log('\nDry run — nothing deleted. Re-run with --yes to wipe.');
    return;
  }

  // 0. Kept Companies — clear their transactions via ERPNext's built-in
  //    Transaction Deletion Record (keeps the Company + chart of accounts).
  //    Must finish before masters go, or linked Items/parties won't delete.
  for (const company of inv.keptCompanies) {
    console.log(`\n[0/3] Clearing transactions of kept Company "${company}"…`);
    await clearCompanyTransactions(admin, company);
  }

  // 1. Companies — reuse the battle-tested per-company teardown (cancels
  //    + deletes invoices, JEs, PEs, ledgers, accounts, warehouses, …).
  console.log('\n[1/3] Deleting tenant Companies…');
  for (const company of inv.companies) {
    console.log(`\n── ${company}`);
    try {
      // v16 refuses to delete cancelled vouchers that still have GL
      // Entries — ERPNext's own deletion job removes both in one go.
      await clearCompanyTransactions(admin, company);
    } catch (err) {
      console.log(`  × transaction deletion failed: ${err.message}`);
    }
    try {
      execFileSync(process.execPath, [path.join(__dirname, 'delete-erp-company.js'), company, '--yes'], {
        stdio: 'inherit',
      });
    } catch {
      console.log(`  × delete-erp-company failed for "${company}" — continuing`);
    }
  }

  // 2. Site-global masters. Order matters: links first (Contacts/Addresses
  //    reference parties; User Permissions reference users).
  console.log('\n[2/3] Deleting site-global masters…');
  await deleteAll(admin, 'User Permission', inv.userPermissions);
  await deleteAll(admin, 'Contact', inv.contacts);
  await deleteAll(admin, 'Address', inv.addresses);
  await deleteAll(admin, 'Customer', inv.customers);
  await deleteAll(admin, 'Supplier', inv.suppliers);
  await deleteAll(admin, 'Item', inv.items);
  await deleteAll(admin, 'Item Group', inv.itemGroups);

  console.log('\n[3/3] Deleting tenant bot Users…');
  await deleteAll(admin, 'User', inv.users);
  // v16 User delete can trip over link checks to DocTypes that no longer
  // exist ("DocType Custom Sidebar not found"). Fall back to disabling and
  // revoking API access so the leftover is inert.
  for (const u of (await inventory(admin)).users) {
    try {
      await admin.updateResource('User', u, { enabled: 0, api_key: null, api_secret: null });
      console.log(`  disabled ${u}`);
    } catch (err) {
      console.log(`  × disable ${u}: ${String(err.message).slice(0, 160)}`);
    }
  }

  console.log('\nRemaining after wipe:');
  printInventory(await inventory(admin));
})().catch((err) => {
  console.error('wipe failed:', err.message);
  process.exit(1);
});
