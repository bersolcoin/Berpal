/**
 * Resolve a counterparty name to its ERPNext Supplier record name.
 * Mirror of customer.js for the AP side.
 *
 *   1. counterparty_cache (Supplier doctype) hit → return immediately
 *   2. Fuzzy cache (LIKE): user says "Acme", cache has "Acme Gems"
 *      → 1 match returns, multiple matches throws AMBIGUOUS_COUNTERPARTY
 *   3. Exact-name match in ERPNext Supplier list → cache + return
 *   4. Create new Supplier in ERPNext (with phone/email if known) → cache + return
 */

const { query } = require('../db');
const { ts } = require('../log');
const { resolvePartyAccount } = require('./party-account');
const { linkCounterparty } = require('../links/counterparty-match');
const { assertPhoneUnused } = require('./contact-guard');

async function resolveOrCreateSupplier(
  user,
  erp,
  name,
  { currency = null, phone = null, email = null, _skipEagerOtherSide = false } = {}
) {
  if (!name) throw new Error('supplier name required');

  // 1a. exact-match cache hit?
  const exact = await query(
    `SELECT erpnext_name FROM counterparty_cache
     WHERE owner_user_id = $1 AND LOWER(name) = LOWER($2) AND erpnext_doctype = 'Supplier'
     LIMIT 1`,
    [user.id, name]
  );
  if (exact.rowCount > 0 && exact.rows[0].erpnext_name) {
    return exact.rows[0].erpnext_name;
  }

  // 1b. fuzzy cache hit. Same disambiguation pattern as customer.js: 1 match
  //     wins, 2+ throws so the LLM can ask the user.
  const fuzzy = await query(
    `SELECT name, erpnext_name FROM counterparty_cache
     WHERE owner_user_id = $1 AND erpnext_doctype = 'Supplier'
       AND (LOWER(name) LIKE LOWER($2) OR LOWER($3) LIKE LOWER('%' || name || '%'))
     ORDER BY id DESC`,
    [user.id, `%${name}%`, name]
  );
  if (fuzzy.rowCount === 1 && fuzzy.rows[0].erpnext_name) {
    console.log(`• [conversation] [${ts()}] supplier fuzzy-resolved "${name}" → "${fuzzy.rows[0].erpnext_name}"`);
    return fuzzy.rows[0].erpnext_name;
  }
  if (fuzzy.rowCount > 1) {
    const candidates = fuzzy.rows.map((r) => r.name).join(', ');
    const err = new Error(
      `Multiple suppliers match "${name}": ${candidates}. Ask the user which one and resave with the full name.`
    );
    err.code = 'AMBIGUOUS_COUNTERPARTY';
    err.candidates = fuzzy.rows.map((r) => ({ name: r.name, erpnext_name: r.erpnext_name }));
    throw err;
  }

  // 2. exact-name match in ERPNext?
  const found = await erp.listSuppliers({
    filters: [['supplier_name', '=', name]],
    limit: 1,
  });

  let erpName;
  if (found.data?.length > 0) {
    erpName = found.data[0].name;
    console.log(`• [conversation] [${ts()}] supplier match in ERPNext: ${erpName}`);
  } else {
    // Phone-uniqueness guard — see customer.js for rationale.
    if (phone) {
      const check = await assertPhoneUnused(user.id, name, phone);
      if (!check.ok) {
        const err = new Error(
          `Phone ${phone} is already used by contact "${check.conflictsWith.name}". A phone can only belong to one contact — double-check the number, or use the existing name.`
        );
        err.code = 'PHONE_TAKEN';
        err.conflictsWith = check.conflictsWith;
        throw err;
      }
    }
    // 3. create
    const supplierData = {
      supplier_name: name,
      supplier_type: 'Individual',
      supplier_group: 'All Supplier Groups',
    };
    if (currency) supplierData.default_currency = currency;
    if (phone) supplierData.mobile_no = phone;
    if (email) supplierData.email_id = email;

    // Multi-currency suppliers: pre-link the per-company AP account to the
    // currency-matched Creditors leaf. Prevents ERPNext from locking the
    // supplier to whatever currency the FIRST bill happens to be in.
    if (currency) {
      const payableAccount = await resolvePartyAccount(erp, 'Payable', currency, user);
      supplierData.accounts = [{ company: erp.company, account: payableAccount }];
    }

    const result = await erp.createSupplier(supplierData);
    erpName = result.data.name;
    console.log(`• [conversation] [${ts()}] created Supplier in ERPNext: ${erpName} (currency=${currency || 'company default'})`);
  }

  // 4. cache
  const now = new Date().toISOString();
  await query(
    `INSERT INTO counterparty_cache
       (owner_user_id, name, phone, email, erpnext_doctype, erpnext_name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Supplier', $5, $6, $6)
     ON CONFLICT (owner_user_id, name) DO UPDATE SET
       erpnext_name = EXCLUDED.erpnext_name,
       erpnext_doctype = EXCLUDED.erpnext_doctype,
       phone = COALESCE(counterparty_cache.phone, EXCLUDED.phone),
       email = COALESCE(counterparty_cache.email, EXCLUDED.email),
       updated_at = EXCLUDED.updated_at`,
    [user.id, name, phone, email, erpName, now]
  );

  try {
    const linked = await linkCounterparty({
      ownerUserId: user.id,
      counterpartyName: name,
      phone,
    });
    if (linked) {
      console.log(`• [conversation] [${ts()}] supplier "${name}" linked to user_id=${linked}`);
    }
  } catch (err) {
    console.warn(`• [conversation] [${ts()}] link detection skipped: ${err.message}`);
  }

  // Eager dual-create — same logic as customer.js. See comments there.
  if (!_skipEagerOtherSide) {
    try {
      const { resolveOrCreateCustomer } = require('./customer');
      await resolveOrCreateCustomer(user, erp, name, {
        currency,
        phone,
        email,
        _skipEagerOtherSide: true,
      });
    } catch (err) {
      console.warn(`• [conversation] [${ts()}] eager Customer creation for "${name}" skipped: ${err.message}`);
    }
  }

  return erpName;
}

module.exports = { resolveOrCreateSupplier };
