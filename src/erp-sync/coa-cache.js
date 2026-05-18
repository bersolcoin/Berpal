/**
 * Per-tenant chart-of-accounts cache. Stored as a JSON blob in
 * coa_cache.data per user, kept in lockstep with ERPNext by:
 *
 *   1. SEED at end of provisionTenant — fetch all accounts, write blob
 *   2. APPEND on every Account create (wallet.js, party-account.js)
 *   3. REFRESH on demand (manual / on resolver miss / scripts/refresh)
 *
 * Users never touch ERPNext directly, so the cache is authoritative for
 * the app: resolvers (resolveErpAccount / resolveWalletAccount) read
 * from here first and only round-trip to ERPNext on a miss + refresh.
 *
 * Process-local memo on top of the PG row so consecutive calls in a
 * single request don't re-parse the JSON.
 */

const { query } = require('../db');
const { ts } = require('../log');

const ACCOUNT_FIELDS = [
  'name',
  'account_name',
  'account_number',
  'account_type',
  'root_type',
  'account_currency',
  'is_group',
  'parent_account',
  'disabled',
];

const _memo = new Map();   // userId → { rows, fetchedAt }
const MEMO_TTL_MS = 60 * 1000; // 1 min — short enough that any append below blows it away

/**
 * Pull a fresh copy of all accounts from ERPNext and overwrite the
 * cache row. Use after onboarding or as a manual repair.
 */
async function refreshCoaCache(user, erp) {
  const r = await erp.listResource('Account', {
    filters: [['company', '=', erp.company]],
    fields: ACCOUNT_FIELDS,
    limit: 500,
    orderBy: 'lft asc',
  });
  const rows = (r.data || []).filter((a) => !a.disabled);
  const now = new Date().toISOString();
  await query(
    `INSERT INTO coa_cache (user_id, data, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at`,
    [user.id, JSON.stringify(rows), now]
  );
  _memo.set(user.id, { rows, fetchedAt: Date.now() });
  console.log(`• [coa-cache] [${ts()}] refreshed user_id=${user.id} (${rows.length} accounts)`);
  return rows;
}

/**
 * Read the cached chart. Returns [] if nothing's cached yet.
 * Process-local memo skips the PG read for back-to-back calls.
 */
async function getCoaCache(userId) {
  const hit = _memo.get(userId);
  if (hit && Date.now() - hit.fetchedAt < MEMO_TTL_MS) {
    return hit.rows;
  }
  const r = await query(`SELECT data FROM coa_cache WHERE user_id = $1`, [userId]);
  if (!r.rowCount) return [];
  let rows = [];
  try {
    rows = JSON.parse(r.rows[0].data) || [];
  } catch {
    rows = [];
  }
  _memo.set(userId, { rows, fetchedAt: Date.now() });
  return rows;
}

/**
 * Append (or replace) a single account in the cache after we've just
 * created or updated it in ERPNext. Idempotent — by `name`.
 */
async function upsertAccountInCoaCache(userId, account) {
  if (!account || !account.name) return;
  const rows = await getCoaCache(userId);
  const idx = rows.findIndex((a) => a.name === account.name);
  const trimmed = {};
  for (const k of ACCOUNT_FIELDS) trimmed[k] = account[k] ?? null;
  if (idx >= 0) rows[idx] = trimmed;
  else rows.push(trimmed);
  const now = new Date().toISOString();
  await query(
    `INSERT INTO coa_cache (user_id, data, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at`,
    [userId, JSON.stringify(rows), now]
  );
  _memo.set(userId, { rows, fetchedAt: Date.now() });
}

/**
 * Find accounts in the cache matching the given filters. Mirrors the
 * shape of erp.listResource filters so callers can swap between live
 * + cached easily.
 *
 *   filterAccounts(userId, { account_type: 'Cash', account_currency: 'USD' })
 */
async function filterAccounts(userId, where = {}) {
  const rows = await getCoaCache(userId);
  return rows.filter((a) => {
    if (a.disabled) return false;
    if (where.account_type !== undefined && a.account_type !== where.account_type) return false;
    if (where.root_type !== undefined && a.root_type !== where.root_type) return false;
    if (where.account_currency !== undefined && a.account_currency !== where.account_currency) return false;
    if (where.is_group !== undefined && !!a.is_group !== !!where.is_group) return false;
    if (where.parent_account !== undefined && a.parent_account !== where.parent_account) return false;
    if (where.account_name_contains) {
      const kw = String(where.account_name_contains).toLowerCase();
      const nm = (a.account_name || '').toLowerCase();
      if (!nm.includes(kw)) return false;
    }
    return true;
  });
}

/**
 * Invalidate the in-process memo for a user — call after any ERPNext
 * write that we KNOW touched the chart but didn't flow through
 * upsertAccountInCoaCache (e.g. bulk operations from scripts).
 */
function invalidateMemo(userId) {
  _memo.delete(userId);
}

module.exports = {
  refreshCoaCache,
  getCoaCache,
  upsertAccountInCoaCache,
  filterAccounts,
  invalidateMemo,
};
