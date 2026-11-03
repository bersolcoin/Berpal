/**
 * Wallets — the cash / bank / credit-card pots the user holds money in.
 *
 * Each wallet is an ERPNext leaf Account. The `account_cache` row (account_type NOT NULL)
 * gives it a stable numeric id the LLM passes around as payment_account_id.
 * Category rows in the same table (name = '5100' etc.) have account_type NULL.
 *
 *   parent_code 1000 → Cash         (ERPNext account_type 'Cash')
 *   parent_code 1100 → Bank         (ERPNext account_type 'Bank')
 *   parent_code 2100 → Credit Card  (liability leaf; ERPNext has no card type, so it's tracked here)
 */
const { query } = require('./db');
const { ts, friendlyAccountName, resolveErpAccount } = require('./erp-sync/common');

const PARENT_CODE_TO_TYPE = { '1000': 'Cash', '1100': 'Bank', '2100': 'Credit Card' };
const TYPE_TO_PARENT_CODE = { Cash: '1000', Bank: '1100', 'Credit Card': '2100' };

function rowToWallet(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.account_type,
    parent_code: TYPE_TO_PARENT_CODE[row.account_type] || null,
    currency: row.currency,
    erpnext_account: row.erpnext_account_name,
  };
}

async function upsert(user, { name, accountType, currency, erpName }) {
  const now = new Date().toISOString();
  const r = await query(
    `INSERT INTO account_cache
       (user_id, name, account_type, currency, erpnext_account_name, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $6)
     ON CONFLICT (user_id, name, currency) DO UPDATE SET
       account_type = EXCLUDED.account_type,
       erpnext_account_name = EXCLUDED.erpnext_account_name,
       is_active = 1,
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [user.id, name, accountType, currency, erpName, now]
  );
  return r.rows[0];
}

/**
 * Mirror ERPNext's Cash/Bank leaf accounts into the cache. Wallets deleted/disabled in
 * ERPNext are deactivated here. Credit-card wallets are bot-created and left alone.
 */
async function syncFromErp(user, erp) {
  const r = await erp.listResource('Account', {
    filters: [
      ['company', '=', erp.company],
      ['is_group', '=', 0],
      ['disabled', '=', 0],
      ['account_type', 'in', ['Cash', 'Bank']],
    ],
    fields: ['name', 'account_name', 'account_type', 'account_currency'],
    limit: 200,
  });
  const live = r.data || [];
  for (const a of live) {
    await upsert(user, {
      name: friendlyAccountName(a.account_name),
      accountType: a.account_type,
      currency: a.account_currency,
      erpName: a.name,
    });
  }
  const liveNames = live.map((a) => a.name);
  await query(
    `UPDATE account_cache SET is_active = 0, updated_at = $3
     WHERE user_id = $1 AND account_type IN ('Cash', 'Bank') AND is_active = 1
       AND NOT (erpnext_account_name = ANY($2::text[]))`,
    [user.id, liveNames, new Date().toISOString()]
  );
}

async function list(user, erp, { parentCodes = null, currency = null } = {}) {
  if (erp) await syncFromErp(user, erp);
  const r = await query(
    `SELECT * FROM account_cache
     WHERE user_id = $1 AND is_active = 1 AND account_type IS NOT NULL
     ORDER BY account_type, name`,
    [user.id]
  );
  const types = parentCodes && parentCodes.length
    ? parentCodes.map((c) => PARENT_CODE_TO_TYPE[c]).filter(Boolean)
    : null;
  return r.rows
    .filter((row) => !types || types.includes(row.account_type))
    .filter((row) => !currency || row.currency === String(currency).toUpperCase())
    .map(rowToWallet);
}

async function getById(user, id) {
  const r = await query(
    `SELECT * FROM account_cache WHERE id = $1 AND user_id = $2 AND account_type IS NOT NULL`,
    [id, user.id]
  );
  return r.rows[0] ? { ...rowToWallet(r.rows[0]), is_active: r.rows[0].is_active === 1 } : null;
}

/** Group account a new wallet of this type should sit under. */
async function findParentGroup(erp, accountType) {
  if (accountType === 'Cash' || accountType === 'Bank') {
    // Siblings first: wherever the existing Cash/Bank accounts live.
    const leaf = await erp.listResource('Account', {
      filters: [['company', '=', erp.company], ['account_type', '=', accountType], ['is_group', '=', 0]],
      fields: ['parent_account'],
      limit: 1,
    });
    if (leaf.data?.[0]?.parent_account) return leaf.data[0].parent_account;
    const group = await erp.listResource('Account', {
      filters: [['company', '=', erp.company], ['account_type', '=', accountType], ['is_group', '=', 1]],
      fields: ['name'],
      limit: 1,
    });
    if (group.data?.[0]?.name) return group.data[0].name;
  }
  const [rootType, nameLike] = accountType === 'Credit Card'
    ? ['Liability', '%Current Liabilities%']
    : ['Asset', '%Current Assets%'];
  const fallback = await erp.listResource('Account', {
    filters: [
      ['company', '=', erp.company],
      ['root_type', '=', rootType],
      ['is_group', '=', 1],
      ['account_name', 'like', nameLike],
    ],
    fields: ['name'],
    limit: 1,
  });
  if (fallback.data?.[0]?.name) return fallback.data[0].name;
  throw new Error(`[wallets] no parent group found for a ${accountType} account in ${erp.company}`);
}

/**
 * Create a wallet (ERPNext Account + cache row). Idempotent on name + currency:
 * returns { existed: true } with the existing wallet instead of duplicating.
 */
async function create(user, erp, { name, parent_code, currency }) {
  const accountType = PARENT_CODE_TO_TYPE[parent_code];
  if (!name || !accountType || !currency) {
    return { ok: false, error: 'name, parent_code (1000 cash / 1100 bank / 2100 credit card) and currency are required' };
  }
  const cur = String(currency).toUpperCase();

  const existing = (await list(user, erp, { currency: cur })).find(
    (w) => w.name.toLowerCase() === String(name).toLowerCase()
  );
  if (existing) return { ok: true, existed: true, wallet: existing };

  const parentAccount = await findParentGroup(erp, accountType);
  const result = await erp.createAccount({
    account_name: name,
    parent_account: parentAccount,
    account_currency: cur,
    ...(accountType === 'Credit Card' ? {} : { account_type: accountType }),
  });
  const erpName = result.data?.name;
  const row = await upsert(user, { name, accountType, currency: cur, erpName });
  console.log(`• [wallets] [${ts()}] created ${accountType} wallet in ERPNext: ${erpName} (${cur})`);
  return { ok: true, existed: false, wallet: rowToWallet(row) };
}

/**
 * The ERPNext account the draft's cash side hits: the picked wallet (payment_account_id),
 * else the generic account for payment_account_code (only 1000 Cash maps without a wallet).
 */
async function accountForDraft(user, erp, draft, { field = 'payment_account_id' } = {}) {
  const id = draft[field];
  if (id) {
    const w = await getById(user, id);
    if (!w || !w.is_active) throw new Error(`wallet ${id} not found or inactive`);
    return w.erpnext_account;
  }
  const code = draft.payment_account_code || '1000';
  const acc = await resolveErpAccount(user, erp, code, draft.currency);
  if (!acc) {
    throw new Error(`no ERPNext account for payment_account_code ${code}; pick a wallet with list_user_accounts`);
  }
  return acc;
}

module.exports = { list, getById, create, accountForDraft, PARENT_CODE_TO_TYPE };
