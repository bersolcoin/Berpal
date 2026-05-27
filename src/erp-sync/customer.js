/**
 * Resolve a counterparty name to its ERPNext Customer record name.
 *
 * Order of operations:
 *   1. counterparty_cache hit → return immediately (no API call)
 *   2. Exact-name match in ERPNext → cache + return
 *   3. Create new Customer in ERPNext (with currency/phone/email if known) → cache + return
 *
 * Always caches the resolved name back to Postgres so future lookups skip ERPNext.
 */

const { query } = require('../db');
const { ts } = require('../log');
const { resolvePartyAccount } = require('./party-account');
const { linkCounterparty } = require('../links/counterparty-match');
const { filterByNameMatch } = require('../links/name-match');
const { assertPhoneUnused, findExistingContactByPhone } = require('./contact-guard');
const { getCustomerGroupName } = require('./party-group');
const { abbrFromUser } = require('./item-group');

async function resolveOrCreateCustomer(
  user,
  erp,
  name,
  { currency = null, phone = null, email = null, _skipEagerOtherSide = false } = {}
) {
  if (!name) throw new Error('customer name required');

  // Phone is the strongest identity signal — names drift ("SS & Co" /
  // "SS and co" / "SS Trading"). If this owner already has a contact at
  // this phone under a different name, treat that as canonical so we
  // don't create a duplicate and trip the assertPhoneUnused guard later.
  if (phone) {
    const existing = await findExistingContactByPhone(user.id, phone);
    if (existing && existing.name.trim().toLowerCase() !== name.trim().toLowerCase()) {
      console.log(`• [conversation] [${ts()}] customer identity by phone ${phone}: "${name}" → "${existing.name}"`);
      name = existing.name;
    }
  }

  // 1a. exact-match cache hit?
  const exact = await query(
    `SELECT erpnext_name FROM counterparty_cache
     WHERE owner_user_id = $1 AND LOWER(name) = LOWER($2) AND erpnext_doctype = 'Customer'
     LIMIT 1`,
    [user.id, name]
  );
  if (exact.rowCount > 0 && exact.rows[0].erpnext_name) {
    return exact.rows[0].erpnext_name;
  }

  // 1b. fuzzy cache hit: user said "Acme", cache has "Acme Trading".
  //     Fetch all cache rows for this owner and filter JS-side with
  //     normalized matching ("&" ↔ "and", whitespace, case).
  //     If exactly ONE row matches, use it. If MORE than one matches, refuse to
  //     silently pick — throw an AmbiguousCounterpartyError so the LLM can ask
  //     the user which one. Never bluff a guess on identity-critical data.
  const cacheAll = await query(
    `SELECT name, erpnext_name FROM counterparty_cache
     WHERE owner_user_id = $1 AND erpnext_doctype = 'Customer'
     ORDER BY id DESC`,
    [user.id]
  );
  const fuzzy = filterByNameMatch(cacheAll.rows, name, 'name');
  if (fuzzy.length === 1 && fuzzy[0].erpnext_name) {
    console.log(`• [conversation] [${ts()}] customer fuzzy-resolved "${name}" → "${fuzzy[0].erpnext_name}"`);
    return fuzzy[0].erpnext_name;
  }
  if (fuzzy.length > 1) {
    const candidates = fuzzy.map((r) => r.name).join(', ');
    const err = new Error(
      `Multiple customers match "${name}": ${candidates}. Ask the user which one and resave with the full name.`
    );
    err.code = 'AMBIGUOUS_COUNTERPARTY';
    err.candidates = fuzzy.map((r) => ({ name: r.name, erpnext_name: r.erpnext_name }));
    throw err;
  }

  // 2. exact-name match in ERPNext?
  const found = await erp.listCustomers({
    filters: [['customer_name', '=', name]],
    limit: 1,
  });

  let erpName;
  if (found.data?.length > 0) {
    erpName = found.data[0].name;
    console.log(`• [conversation] [${ts()}] customer match in ERPNext: ${erpName}`);
  } else {
    // Phone-uniqueness guard: about to create a brand-new contact. If
    // the phone is already on file under a DIFFERENT name, refuse — the
    // user almost certainly typed the wrong name or the wrong phone.
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
    // Per-tenant customer_group ("Customers - <ABBR>") so the bot's
    // User Permission fence keeps this Customer scoped to this tenant.
    // Legacy fallback to "Individual" if the user has no abbr yet
    // (only happens during a half-broken provisioning flow).
    const customerGroup = getCustomerGroupName(abbrFromUser(user)) || 'Individual';
    const customerData = {
      customer_name: name,
      customer_type: 'Individual',
      customer_group: customerGroup,
      territory: 'All Territories',
    };
    if (currency) customerData.default_currency = currency;
    if (phone) customerData.mobile_no = phone;
    if (email) customerData.email_id = email;

    // Multi-currency customers: pre-link the per-company AR account to the
    // currency-matched Debtors leaf. Prevents ERPNext from locking the
    // customer to whatever currency the FIRST invoice happens to be in.
    if (currency) {
      const receivableAccount = await resolvePartyAccount(erp, 'Receivable', currency, user);
      customerData.accounts = [{ company: erp.company, account: receivableAccount }];
    }

    const result = await erp.createCustomer(customerData);
    erpName = result.data.name;
    console.log(`• [conversation] [${ts()}] created Customer in ERPNext: ${erpName} (currency=${currency || 'company default'})`);
  }

  // 4. cache
  const now = new Date().toISOString();
  await query(
    `INSERT INTO counterparty_cache
       (owner_user_id, name, phone, email, erpnext_doctype, erpnext_name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Customer', $5, $6, $6)
     ON CONFLICT (owner_user_id, erpnext_doctype, name) DO UPDATE SET
       erpnext_name = EXCLUDED.erpnext_name,
       phone = COALESCE(counterparty_cache.phone, EXCLUDED.phone),
       email = COALESCE(counterparty_cache.email, EXCLUDED.email),
       updated_at = EXCLUDED.updated_at`,
    [user.id, name, phone, email, erpName, now]
  );

  // 5. B2B link detection — fire-and-forget. If this customer's phone
  //    matches another Berpal user, mark the link so the seller's next
  //    Sales Invoice can propose a mirrored Purchase Invoice on their side.
  try {
    const linked = await linkCounterparty({
      ownerUserId: user.id,
      counterpartyName: name,
      phone,
    });
    if (linked) {
      console.log(`• [conversation] [${ts()}] customer "${name}" linked to user_id=${linked}`);
    }
  } catch (err) {
    console.warn(`• [conversation] [${ts()}] link detection skipped: ${err.message}`);
  }

  // 6. Eager dual-create — make sure a matching Supplier exists for this
  //    contact. Avoids any cross-doctype fuzzy-matching risk: one logical
  //    contact, two ERPNext records, same name on both sides. The
  //    _skipEagerOtherSide flag prevents infinite recursion when called
  //    from resolveOrCreateSupplier's own eager hook.
  if (!_skipEagerOtherSide) {
    try {
      const { resolveOrCreateSupplier } = require('./supplier');
      await resolveOrCreateSupplier(user, erp, name, {
        currency,
        phone,
        email,
        _skipEagerOtherSide: true,
      });
    } catch (err) {
      console.warn(`• [conversation] [${ts()}] eager Supplier creation for "${name}" skipped: ${err.message}`);
    }
  }

  return erpName;
}

module.exports = { resolveOrCreateCustomer };
