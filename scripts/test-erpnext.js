/**
 * ERPNext connection smoke test.
 *
 * Verifies four things in order:
 *   1. Auth works (correct API key + secret)
 *   2. Read access (list Companies)
 *   3. Write access (POST a test Customer)
 *   4. Delete access (clean up the test Customer)
 *
 * Reads ERPNEXT_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET from .env.
 * Safe to run repeatedly — the test customer name includes a timestamp.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { ERPNEXT_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET } = process.env;

if (!ERPNEXT_URL || !ERPNEXT_API_KEY || !ERPNEXT_API_SECRET) {
  console.error('[test-erpnext] missing one of: ERPNEXT_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET in .env');
  process.exit(1);
}

const baseUrl = ERPNEXT_URL.replace(/\/$/, '');
const authHeader = `token ${ERPNEXT_API_KEY}:${ERPNEXT_API_SECRET}`;

async function call(method, path, body = null) {
  const url = `${baseUrl}${path}`;
  const opts = {
    method,
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, body: json };
}

async function step(label, fn) {
  process.stdout.write(`[test-erpnext] ${label}... `);
  try {
    const result = await fn();
    console.log('OK');
    return result;
  } catch (err) {
    console.log('FAIL');
    console.error(`  ${err.message}`);
    process.exit(1);
  }
}

(async () => {
  console.log(`[test-erpnext] target: ${baseUrl}`);

  // 1. Auth check — get the logged-in user
  const me = await step('1/4 auth check', async () => {
    const r = await call('GET', '/api/method/frappe.auth.get_logged_user');
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body.message; // e.g. "Administrator"
  });
  console.log(`         logged in as: ${me}`);

  // 2. List companies
  const companies = await step('2/4 list companies', async () => {
    const r = await call('GET', '/api/resource/Company?fields=["name","abbr","default_currency","country"]');
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body.data;
  });
  console.log(`         found ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}:`);
  for (const c of companies) {
    console.log(`         - ${c.name} (${c.abbr}) [${c.default_currency}, ${c.country}]`);
  }

  if (companies.length === 0) {
    console.error('[test-erpnext] no Company found — finish the ERPNext setup wizard first.');
    process.exit(1);
  }
  const companyName = companies[0].name;

  // 3. POST a test Customer
  const testName = `Bot Test Customer ${Date.now()}`;
  const created = await step('3/4 create test Customer', async () => {
    const r = await call('POST', '/api/resource/Customer', {
      customer_name: testName,
      customer_type: 'Individual',
      customer_group: 'Individual',
      territory: 'All Territories',
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body.data;
  });
  console.log(`         created: ${created.name} (id ${created.creation})`);

  // 4. Clean up — delete the test customer
  await step('4/4 delete test Customer', async () => {
    const r = await call('DELETE', `/api/resource/Customer/${encodeURIComponent(created.name)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  });

  console.log('\n[test-erpnext] ✓ all checks passed — connection is healthy');
  console.log(`[test-erpnext] use this company for bot tests: "${companyName}"`);
  process.exit(0);
})().catch((err) => {
  console.error('[test-erpnext] unexpected error:', err);
  process.exit(1);
});
