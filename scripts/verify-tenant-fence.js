/**
 * Cross-tenant access test. Logs in as tenant A's bot and tries to
 * read tenant B's data. After harden-tenant.js, every query should
 * return ZERO rows (or a permission error). If anything leaks, the
 * fence is broken.
 *
 *   node scripts/verify-tenant-fence.js --from 4 --to 1
 *     "use user.id=4's bot creds, look for user.id=1's data"
 *
 * Tests the four fence boundaries:
 *   - Company-linked  doctypes: Sales Invoice, Purchase Invoice, Account
 *   - Customer Group  fence:    Customer
 *   - Supplier Group  fence:    Supplier
 *   - Item Group      fence:    Item
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');
const erpnext = require('../src/erpnext');

(async () => {
  await init();

  const args = process.argv.slice(2);
  const fromIdx = args.indexOf('--from');
  const toIdx = args.indexOf('--to');
  if (fromIdx < 0 || toIdx < 0) {
    console.error('Usage: node scripts/verify-tenant-fence.js --from <id> --to <id>');
    process.exit(1);
  }
  const fromId = parseInt(args[fromIdx + 1], 10);
  const toId = parseInt(args[toIdx + 1], 10);

  const both = await query(
    `SELECT id, phone, erpnext_company, erpnext_company_abbr,
            erpnext_api_key, erpnext_api_secret
       FROM users WHERE id IN ($1, $2)`,
    [fromId, toId]
  );
  if (both.rowCount !== 2) {
    console.error('Need both users to exist with ERPNext creds.');
    process.exit(2);
  }
  const A = both.rows.find((r) => r.id === fromId);
  const B = both.rows.find((r) => r.id === toId);
  if (!A.erpnext_api_key || !A.erpnext_api_secret) {
    console.error(`from user.id=${fromId} has no API creds — can't test as them.`);
    process.exit(3);
  }

  // Spin up an ERPNext client AS tenant A (their creds, B's data targets).
  const aClient = erpnext.forUser(A);

  console.log(`═══ Cross-tenant access test ═══`);
  console.log(`  Logged in as: user.id=${A.id} (${A.erpnext_company})`);
  console.log(`  Trying to see: user.id=${B.id} (${B.erpnext_company}, abbr=${B.erpnext_company_abbr})`);

  // List doctypes scoped by Company
  await probe(aClient, 'Sales Invoice', { filters: [['company', '=', B.erpnext_company]], fields: ['name'] });
  await probe(aClient, 'Purchase Invoice', { filters: [['company', '=', B.erpnext_company]], fields: ['name'] });
  await probe(aClient, 'Payment Entry', { filters: [['company', '=', B.erpnext_company]], fields: ['name'] });
  await probe(aClient, 'Journal Entry', { filters: [['company', '=', B.erpnext_company]], fields: ['name'] });
  await probe(aClient, 'Account', { filters: [['company', '=', B.erpnext_company]], fields: ['name'] });

  // Group-scoped doctypes
  await probe(aClient, 'Customer', { filters: [['customer_group', '=', `Customers - ${B.erpnext_company_abbr}`]], fields: ['name'] });
  await probe(aClient, 'Supplier', { filters: [['supplier_group', '=', `Suppliers - ${B.erpnext_company_abbr}`]], fields: ['name'] });
  await probe(aClient, 'Item', { filters: [['item_group', '=', `Items - ${B.erpnext_company_abbr}`]], fields: ['name'] });

  console.log(`\n✓ If every probe above shows "0 rows" or "permission denied", the fence is intact.`);
  console.log(`× If any probe returns rows, that's a privacy leak — re-run harden-tenant.js or check the User Permission setup.`);
  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

async function probe(client, doctype, args) {
  try {
    const r = await client.listResource(doctype, { ...args, limit: 5 });
    const n = (r.data || []).length;
    const tag = n === 0 ? '✓ 0 rows' : `× ${n} ROWS LEAKED`;
    console.log(`  ${doctype.padEnd(20)} ${tag}`);
    if (n > 0) {
      for (const row of r.data.slice(0, 3)) console.log(`      - ${row.name}`);
    }
  } catch (err) {
    // Permission errors are GOOD here — they mean the fence is firing.
    if (/permission|access|not permitted|PermissionError/i.test(err.message)) {
      console.log(`  ${doctype.padEnd(20)} ✓ permission denied (fence firing)`);
    } else {
      console.log(`  ${doctype.padEnd(20)} ? error: ${err.message}`);
    }
  }
}
