/**
 * List every Account in a Company's Chart of Accounts.
 * Useful for debugging account resolution across different country charts.
 *
 * Usage:
 *   node scripts/list-erp-accounts.js
 *      → uses ERPNEXT_COMPANY_DEFAULT + admin creds from .env
 *
 *   node scripts/list-erp-accounts.js --user +66838883866
 *      → load user by phone, use their per-user ERPNext creds + company
 *
 *   node scripts/list-erp-accounts.js --company "Acme Trading"
 *      → admin creds, query that company by name
 *
 * Output grouped by root_type then account_type, sorted by account name.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query } = require('../src/db');
const erpnext = require('../src/erpnext');
const { getAdminClient } = require('../src/erp-admin');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user') out.user = args[++i];
    else if (args[i] === '--company') out.company = args[++i];
  }
  return out;
}

async function buildContext({ user: phone, company }) {
  if (phone) {
    const r = await query(
      `SELECT id, phone, erpnext_company, erpnext_api_key, erpnext_api_secret
         FROM users WHERE phone = $1`,
      [phone]
    );
    if (!r.rowCount) throw new Error(`no user with phone ${phone}`);
    const u = r.rows[0];
    if (!u.erpnext_company || !u.erpnext_api_key) {
      throw new Error(`user ${phone} has no ERPNext creds`);
    }
    return { erp: erpnext.forUser(u), company: u.erpnext_company, via: `user ${phone}` };
  }
  if (company) {
    const admin = getAdminClient();
    return { erp: admin, company, via: 'admin' };
  }
  // Default: .env
  const u = {
    erpnext_company: process.env.ERPNEXT_COMPANY_DEFAULT || 'Test Trading Company',
    erpnext_api_key: process.env.ERPNEXT_API_KEY,
    erpnext_api_secret: process.env.ERPNEXT_API_SECRET,
  };
  return { erp: erpnext.forUser(u), company: u.erpnext_company, via: '.env defaults' };
}

(async () => {
  const args = parseArgs();
  const ctx = await buildContext(args);

  console.log(`[list] company: ${ctx.company}  (via ${ctx.via})`);

  // listAccounts on a per-user client filters by company automatically.
  // The admin client doesn't, so we add the filter explicitly.
  const isAdmin = ctx.via === 'admin';
  const r = isAdmin
    ? await ctx.erp.listResource('Account', {
        filters: [['company', '=', ctx.company]],
        fields: ['name', 'account_name', 'account_type', 'root_type', 'account_currency', 'is_group', 'parent_account'],
        limit: 500,
        orderBy: 'lft asc',
      })
    : await ctx.erp.listAccounts({ limit: 500 });
  const rows = r.data || [];

  // Sort by account name (which typically starts with the code prefix).
  rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  // Group by root_type, then by account_type within each root.
  const byRoot = {};
  for (const a of rows) {
    const rt = a.root_type || '(no root)';
    const at = a.account_type || (a.is_group ? '(group)' : '(no account_type)');
    if (!byRoot[rt]) byRoot[rt] = {};
    if (!byRoot[rt][at]) byRoot[rt][at] = [];
    byRoot[rt][at].push(a);
  }

  const rootOrder = ['Asset', 'Liability', 'Equity', 'Income', 'Expense'];
  const rootKeys = [...new Set([...rootOrder, ...Object.keys(byRoot)])].filter((k) => byRoot[k]);

  for (const rt of rootKeys) {
    console.log(`\n══ ${rt} ${'═'.repeat(60 - rt.length)}`);
    const typeKeys = Object.keys(byRoot[rt]).sort();
    for (const at of typeKeys) {
      const list = byRoot[rt][at];
      console.log(`\n  ── ${at} (${list.length})`);
      for (const a of list) {
        const flag = a.is_group ? ' [group]' : '';
        const ccy = a.account_currency ? `  [${a.account_currency}]` : '';
        console.log(`    ${a.name}${flag}${ccy}`);
      }
    }
  }

  console.log(`\n[list] total: ${rows.length} accounts in "${ctx.company}"`);
  process.exit(0);
})().catch((err) => {
  console.error('[list] error:', err.message);
  if (err.response) console.error('       response:', JSON.stringify(err.response).slice(0, 600));
  process.exit(1);
});
