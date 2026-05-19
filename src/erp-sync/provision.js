/**
 * Auto-provision a new tenant in ERPNext + our Postgres `users` table.
 *
 * Steps (best-effort, in order; partial state is returned on failure so a
 * subsequent run can pick up):
 *
 *   1. Create ERPNext Company — always with enable_perpetual_inventory: 1
 *      so a service-now-product-later tenant doesn't need a migration.
 *      Pass tax_id when provided.
 *   2. Create ERPNext User (Accounts + Sales + Purchase roles)
 *   3. Generate API key + secret for that user
 *   4. Set Company.exchange_gain_loss_account if blank
 *   5. Provision starter wallets (cash + each bank) — creates per-currency
 *      Account leaves and posts Opening Balance JEs against
 *      Opening Balance Equity for any non-zero starting amounts.
 *   6. UPSERT into our `users` table (idempotent on phone).
 *
 * If a wallet's opening balance is in a different currency from the
 * company currency, an FX rate is fetched via frankfurter.app. Failure
 * to fetch / post is logged but doesn't fail the whole provisioning —
 * user can re-post via the bot later.
 */

const { query } = require('../db');
const { getAdminClient } = require('../erp-admin');
const { ts } = require('../log');
const erpnext = require('../erpnext');
const { resolveWalletAccount } = require('./wallet');
const { recordOpeningBalance } = require('./opening-balance');
const { ensureCompanyItemGroup, getCompanyItemGroupName } = require('./item-group');
const { ensureCustomerGroup, ensureSupplierGroup, getCustomerGroupName, getSupplierGroupName } = require('./party-group');
const { applyTenantFence } = require('./user-permission');
const { fetchRate } = require('../exchange');
const { bindPendingByPhone } = require('../links/linked-transactions');
const { refreshCoaCache } = require('./coa-cache');
const twilio = require('../twilio-client');

// Roles granted to every per-tenant bot user.
//
// CRITICAL: System Manager is INTENTIONALLY NOT included. System
// Manager bypasses User Permissions, which would defeat the per-tenant
// fence we set up via applyTenantFence (Company / Customer Group /
// Supplier Group / Item Group restrictions). The whole privacy model
// depends on the bot being unable to see other tenants' data — so
// we grant full functional Manager + User roles for every module the
// tenant might use, then rely on User Permissions for isolation.
//
// Intentionally NOT included:
//   • System Manager           — bypasses User Permissions; would leak across tenants
//   • Script Manager           — can run arbitrary server-side Python
//   • Supplier / Customer / Employee — portal roles for outside parties, not staff
//   • Website / Dashboard / Workspace / Translator / Newsletter / Knowledge Base
//                              — UI / content roles, not bookkeeping-relevant
//   • Auditor / Analytics / Prepared Report User — read-only specializations
//
// Within the fence, the bot has full create/write/delete on its tenant's
// data across every functional module ERPNext ships with.
const ROLES_FOR_BOT_USER = [
  // Accounting
  { role: 'Accounts Manager' },
  { role: 'Accounts User' },
  { role: 'Report Manager' },
  // Sales
  { role: 'Sales Manager' },
  { role: 'Sales Master Manager' },
  { role: 'Sales User' },
  // Purchase
  { role: 'Purchase Manager' },
  { role: 'Purchase Master Manager' },
  { role: 'Purchase User' },
  // Stock / Items
  { role: 'Stock Manager' },
  { role: 'Stock User' },
  { role: 'Item Manager' },
  // HR
  { role: 'HR Manager' },
  { role: 'HR User' },
  // Manufacturing
  { role: 'Manufacturing Manager' },
  { role: 'Manufacturing User' },
  // Projects
  { role: 'Projects Manager' },
  { role: 'Projects User' },
  // Delivery / Fleet / Maintenance / Quality
  { role: 'Delivery Manager' },
  { role: 'Delivery User' },
  { role: 'Fleet Manager' },
  { role: 'Maintenance Manager' },
  { role: 'Maintenance User' },
  { role: 'Quality Manager' },
  // Other ops
  { role: 'Fulfillment User' },
  { role: 'Marketing Manager' },
  { role: 'Support Team' },
];

function deriveAbbreviation(businessName) {
  const words = businessName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    return words[0].slice(0, 5).toUpperCase();
  }
  return words.slice(0, 4).map((w) => w[0]).join('').toUpperCase();
}

/**
 * ERPNext enforces Company.abbr uniqueness across the whole instance.
 * Walk a candidate → candidate2 → candidate3 … until we find one that's
 * not in use. Bails after 50 tries to avoid runaway loops on bad input.
 */
async function resolveUniqueAbbr(admin, candidate) {
  let abbr = candidate;
  for (let i = 1; i <= 50; i++) {
    const r = await admin.listResource('Company', {
      filters: [['abbr', '=', abbr]],
      fields: ['name'],
      limit: 1,
    });
    if (!r.data || r.data.length === 0) return abbr;
    abbr = `${candidate}${i + 1}`;
  }
  throw new Error(`could not find a unique Company abbr starting from "${candidate}"`);
}

function buildUserEmail({ phone, email }) {
  if (email) return email;
  const sanitized = String(phone).replace(/[^0-9]/g, '');
  return `bot+${sanitized}@berpal.local`;
}

/**
 * ERPNext's `Country` doctype is keyed on the full English name
 * ("Australia", "United States", "Hong Kong"), not the ISO 3166-1
 * alpha-2 code we get from libphonenumber-js. Convert before sending.
 *
 * Intl.DisplayNames returns BCP-47-style names that don't always match
 * ERPNext's Country defaults (e.g. "Hong Kong SAR China" vs ERPNext's
 * "Hong Kong"; "Macao SAR China" vs "Macao"). Apply a small override
 * map first; fall back to Intl.DisplayNames; fall back to raw input.
 */
const COUNTRY_NAME_OVERRIDES = {
  HK: 'Hong Kong',
  MO: 'Macao',
  TW: 'Taiwan',
  KR: 'South Korea',
  KP: 'North Korea',
  RU: 'Russia',
  VN: 'Vietnam',
  IR: 'Iran',
  SY: 'Syria',
  VE: 'Venezuela',
  BO: 'Bolivia',
  LA: 'Laos',
  CD: 'Congo, Democratic Republic of',
  CG: 'Congo',
  TZ: 'Tanzania',
  MD: 'Moldova',
  PS: 'Palestine',
  TL: 'Timor-Leste',
  CV: 'Cape Verde',
  CI: "Cote d'Ivoire",
};

function isoToCountryName(iso) {
  if (!iso) return iso;
  if (typeof iso === 'string' && iso.length > 2) return iso; // already a name
  const code = String(iso).toUpperCase();
  if (COUNTRY_NAME_OVERRIDES[code]) return COUNTRY_NAME_OVERRIDES[code];
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'region' });
    const name = dn.of(code);
    return name || iso;
  } catch {
    return iso;
  }
}

async function provisionTenant({
  phone,
  display_name,
  business_name,
  country,
  currency,
  abbreviation = null,
  email = null,
  business_type = null,        // 'service' | 'product' | 'both'
  entity_type = null,          // 'individual' | 'company'
  nature_of_business = null,
  tax_id = null,
  address_line1 = null,
  address_line2 = null,
  city = null,
  state_province = null,
  postal_code = null,
  wallets = [],                // [{ type: 'cash'|'bank', name, currency, opening_balance }]
}) {
  if (!phone || !business_name || !country || !currency) {
    throw new Error('provision: phone, business_name, country, currency are all required');
  }

  const partial = {};
  const admin = getAdminClient();
  const userEmail = buildUserEmail({ phone, email });
  const candidateAbbr = (abbreviation || deriveAbbreviation(business_name)).slice(0, 10);
  // Resolve abbr against ERPNext to avoid collision (Company.abbr is
  // site-unique). If candidate is free, returns as-is.
  const abbr = await resolveUniqueAbbr(admin, candidateAbbr);
  if (abbr !== candidateAbbr) {
    console.log(`• [provision] [${ts()}] abbr "${candidateAbbr}" taken; using "${abbr}"`);
  }

  // ── 1. Create Company ───────────────────────────────────────────────
  // ERPNext Country lookup is by full English name, not ISO code.
  const erpCountry = isoToCountryName(country);

  let companyName;
  try {
    const r = await admin.createResource('Company', {
      company_name: business_name,
      abbr,
      default_currency: currency,
      country: erpCountry,
      enable_perpetual_inventory: 1, // always on — UX gating happens in the web app
      // Force the numbered chart template so accounts are uniformly named
      // "1110 - Cash - <ABBR>", "4110 - Sales - <ABBR>", etc. across every
      // tenant. Without this, ERPNext picks the country default which for
      // most countries is "Standard" (no number prefixes), making
      // account-resolution less predictable.
      chart_of_accounts: 'Standard with Numbers',
      ...(tax_id ? { tax_id } : {}),
    });
    companyName = r.data?.name;
    partial.company = companyName;
    console.log(`• [provision] [${ts()}] created Company "${companyName}" (abbr=${abbr}, country=${country}, currency=${currency})`);
  } catch (err) {
    if (/already exists/i.test(err.message)) {
      companyName = business_name;
      partial.company = companyName;
      console.log(`• [provision] [${ts()}] Company "${companyName}" already exists — reusing`);
      // Best-effort: backfill tax_id if it wasn't set before.
      if (tax_id) {
        try {
          await admin.updateResource('Company', companyName, { tax_id });
        } catch (e) {
          console.warn(`• [provision] [${ts()}] tax_id backfill skipped: ${e.message}`);
        }
      }
    } else {
      console.error(`× [provision] [${ts()}] Company create failed for "${business_name}" (abbr=${abbr}, country=${country}→${erpCountry}, currency=${currency}):`);
      console.error(err);
      return { ok: false, error: `Company create failed: ${err.message}`, partial };
    }
  }

  // ── 2. Create User ──────────────────────────────────────────────────
  try {
    await admin.getResource('User', userEmail);
    partial.user = userEmail;
    console.log(`• [provision] [${ts()}] User "${userEmail}" already exists — reusing`);
  } catch (err) {
    try {
      const personName = (display_name || business_name).trim();
      const nameParts = personName.split(/\s+/);
      const firstName = nameParts[0];
      const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

      await admin.createResource('User', {
        email: userEmail,
        first_name: firstName,
        ...(lastName ? { last_name: lastName } : {}),
        send_welcome_email: 0,
        enabled: 1,
        // CRITICAL — REST API access requires System User. Without this
        // the role assignment below is meaningless (Website Users can't
        // hit /api/resource/* regardless of roles). Default in many
        // Frappe versions is "Website User" if omitted, so always set
        // explicitly.
        user_type: 'System User',
        roles: ROLES_FOR_BOT_USER,
      });

      // Frappe's User REST endpoint silently drops the `roles` child
      // table on insert in many versions — the user ends up without
      // permissions, every Supplier/Customer/Invoice create then fails
      // with "User X does not have doctype access". PUT both fields
      // immediately after to force-persist. Idempotent.
      try {
        await admin.updateResource('User', userEmail, {
          user_type: 'System User',
          roles: ROLES_FOR_BOT_USER,
        });
        // Per-user permission cache: Frappe builds it lazily on first
        // access and doesn't invalidate when the User doc is updated
        // via REST. Clear it explicitly so the brand-new roles take
        // effect on the very first /api/resource/* call.
        try {
          await admin.callMethod('frappe.clear_cache', { user: userEmail });
        } catch (cacheErr) {
          console.warn(`• [provision] [${ts()}] cache-clear warning: ${cacheErr.message}`);
        }
        console.log(`• [provision] [${ts()}] user_type + roles confirmed + cache cleared on "${userEmail}"`);
      } catch (roleErr) {
        console.warn(`• [provision] [${ts()}] role PUT failed for "${userEmail}": ${roleErr.message}`);
      }

      partial.user = userEmail;
      console.log(`• [provision] [${ts()}] created User "${userEmail}"`);
    } catch (createErr) {
      console.error(`× [provision] [${ts()}] User create failed for "${userEmail}":`);
      console.error(createErr);
      return { ok: false, error: `User create failed: ${createErr.message}`, partial };
    }
  }

  // ── 3. Generate API key + secret ────────────────────────────────────
  let apiKey, apiSecret;
  try {
    const r = await admin.callMethod('frappe.core.doctype.user.user.generate_keys', {
      user: userEmail,
    });
    apiSecret = r.message?.api_secret;
    const fresh = await admin.getResource('User', userEmail);
    apiKey = fresh.data?.api_key;
    if (!apiKey || !apiSecret) throw new Error('generate_keys returned empty key or secret');
    partial.api_key = apiKey;
    console.log(`• [provision] [${ts()}] generated API key for "${userEmail}"`);
  } catch (err) {
    console.error(`× [provision] [${ts()}] API key generation failed for "${userEmail}":`);
    console.error(err);
    return { ok: false, error: `API key generation failed: ${err.message}`, partial };
  }

  // ── 4. Set FX account on Company ────────────────────────────────────
  try {
    const comp = await admin.getResource('Company', companyName);
    if (!comp.data?.exchange_gain_loss_account) {
      const candidates = await admin.listResource('Account', {
        filters: [
          ['company', '=', companyName],
          ['is_group', '=', 0],
          ['account_name', 'like', '%Exchange%'],
        ],
        fields: ['name'],
        limit: 1,
      });
      const acct = candidates.data?.[0]?.name;
      if (acct) {
        await admin.updateResource('Company', companyName, {
          exchange_gain_loss_account: acct,
        });
        console.log(`• [provision] [${ts()}] set Company.exchange_gain_loss_account = ${acct}`);
        partial.fx_account = acct;
      }
    }
  } catch (err) {
    console.warn(`• [provision] [${ts()}] could not set FX account: ${err.message}`);
  }

  // ── 4b. Per-tenant master-data groups + User Permission fence ───────
  // ERPNext multi-tenancy: bind the bot user to its Company AND to
  // per-tenant Customer/Supplier/Item groups so it can't see or modify
  // any other tenant's master data via the API. Bot user has no
  // System Manager role, so these User Permissions actually fire.
  //
  // The admin client (Administrator) creates the groups + the
  // UserPermission rows; the bot user can only USE them.
  const adminErp = {
    getResource: (dt, n) => admin.getResource(dt, n),
    createResource: (dt, d) => admin.createResource(dt, d),
    listResource: (dt, args) => admin.listResource(dt, args),
  };
  const itemGroupName = getCompanyItemGroupName(abbr);
  const customerGroupName = getCustomerGroupName(abbr);
  const supplierGroupName = getSupplierGroupName(abbr);
  try {
    await ensureCompanyItemGroup(adminErp, abbr);
    await ensureCustomerGroup(adminErp, abbr);
    await ensureSupplierGroup(adminErp, abbr);
    partial.item_group = itemGroupName;
    partial.customer_group = customerGroupName;
    partial.supplier_group = supplierGroupName;
  } catch (err) {
    console.warn(`• [provision] [${ts()}] per-tenant group create skipped: ${err.message}`);
  }

  // Apply the fence. Failures here are loud (warn only) so partial
  // provisioning doesn't get rolled back, but they're a privacy risk
  // — operator should re-run scripts/harden-tenant.js to repair.
  try {
    await applyTenantFence(admin, {
      user: userEmail,
      company: companyName,
      customerGroup: customerGroupName,
      supplierGroup: supplierGroupName,
      itemGroup: itemGroupName,
    });
    console.log(`• [provision] [${ts()}] tenant fence applied to "${userEmail}"`);
  } catch (err) {
    console.warn(`• [provision] [${ts()}] tenant fence skipped (RUN harden-tenant!): ${err.message}`);
  }

  // ── 5. Provision starter wallets ────────────────────────────────────
  // Build a per-user ERPNext client so wallet/JE creation is scoped to
  // this Company (admin client uses a fixed company).
  const userForErp = {
    erpnext_company: companyName,
    erpnext_api_key: apiKey,
    erpnext_api_secret: apiSecret,
    reporting_currency: currency,
    default_currency: currency,
  };
  const erp = erpnext.forUser(userForErp);

  partial.wallets = [];

  // Provision each wallet — type determines the parent group account in
  // ERPNext (Cash = '1000', Bank = '1100'). A user can have many wallets
  // of either type, e.g. multi-currency cash drawers.
  for (const w of wallets || []) {
    if (!w || !w.name || !String(w.name).trim()) continue;
    const wName = String(w.name).trim();
    const wCcy = w.currency || currency;
    const wOpening = Number(w.opening_balance) || 0;
    const parentCode = w.type === 'bank' ? '1100' : '1000';
    try {
      const erpName = await resolveWalletAccount(erp, parentCode, wCcy, wName);
      partial.wallets.push({ kind: w.type === 'bank' ? 'bank' : 'cash', name: erpName });
      if (wOpening > 0) {
        await postOpeningBalanceSafe(userForErp, erp, erpName, wCcy, wOpening);
      }
    } catch (err) {
      console.warn(`• [provision] [${ts()}] wallet "${wName}" (${w.type}) skipped: ${err.message}`);
    }
  }

  // ── 6. Persist to users table ───────────────────────────────────────
  const now = new Date().toISOString();
  const upsert = await query(
    `INSERT INTO users (
       phone, email, display_name,
       default_currency, reporting_currency, country,
       subscription_status, subscription_expires_at,
       erpnext_company, erpnext_company_abbr, erpnext_api_key, erpnext_api_secret,
       business_type, entity_type, nature_of_business, tax_id,
       address_line1, address_line2, city, state_province, postal_code,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3,
       $4, $4, $5,
       'active', '2027-12-31',
       $6, $7, $8, $9,
       $10, $11, $12, $13,
       $14, $15, $16, $17, $18,
       $19, $19
     )
     ON CONFLICT (phone) DO UPDATE SET
       email = COALESCE(EXCLUDED.email, users.email),
       display_name = COALESCE(EXCLUDED.display_name, users.display_name),
       default_currency = EXCLUDED.default_currency,
       reporting_currency = EXCLUDED.reporting_currency,
       country = EXCLUDED.country,
       erpnext_company = EXCLUDED.erpnext_company,
       erpnext_company_abbr = EXCLUDED.erpnext_company_abbr,
       erpnext_api_key = EXCLUDED.erpnext_api_key,
       erpnext_api_secret = EXCLUDED.erpnext_api_secret,
       business_type = COALESCE(EXCLUDED.business_type, users.business_type),
       entity_type = COALESCE(EXCLUDED.entity_type, users.entity_type),
       nature_of_business = COALESCE(EXCLUDED.nature_of_business, users.nature_of_business),
       tax_id = COALESCE(EXCLUDED.tax_id, users.tax_id),
       address_line1 = COALESCE(EXCLUDED.address_line1, users.address_line1),
       address_line2 = COALESCE(EXCLUDED.address_line2, users.address_line2),
       city = COALESCE(EXCLUDED.city, users.city),
       state_province = COALESCE(EXCLUDED.state_province, users.state_province),
       postal_code = COALESCE(EXCLUDED.postal_code, users.postal_code),
       updated_at = EXCLUDED.updated_at
     RETURNING id`,
    [
      phone,
      email,
      display_name,
      currency,
      country,
      companyName,
      abbr,
      apiKey,
      apiSecret,
      business_type,
      entity_type,
      nature_of_business,
      tax_id,
      address_line1,
      address_line2,
      city,
      state_province,
      postal_code,
      now,
    ]
  );
  const userId = upsert.rows[0]?.id;
  console.log(`• [provision] [${ts()}] users.id=${userId} provisioned (phone=${phone}, company=${companyName})`);

  // ── 6.5. Seed the chart-of-accounts cache ───────────────────────────
  // Pull the post-provisioning CoA snapshot (standard chart + the
  // wallets we just created) into PG. Resolvers read from here going
  // forward; ERPNext round-trips happen only on cache misses.
  try {
    await refreshCoaCache({ id: userId }, erp);
  } catch (err) {
    console.warn(`• [provision] [${ts()}] CoA cache seed failed: ${err.message}`);
  }

  // ── 7. Welcome WhatsApp ──────────────────────────────────────────────
  // Send the welcome message FIRST so it lands before any catch-up
  // invoice messages from bindPendingByPhone below. Fire-and-forget —
  // a Twilio hiccup here shouldn't fail onboarding.
  try {
    // Use the user's typed business_name (not ERPNext's normalized
    // companyName) — ERPNext strips '&' and other punctuation, which
    // makes "SS & Co" come back as "SS Co" and feels wrong on the
    // very first message the user sees.
    await twilio.sendText(
      phone,
      `Congratulations! I'm here to assist you with ${business_name}. Let me know when you need me.`
    );
    console.log(`• [provision] [${ts()}] welcome message sent to ${phone}`);
  } catch (err) {
    console.warn(`• [provision] [${ts()}] welcome message failed: ${err.message}`);
  }

  // ── 8. Claim any invoices waiting for this phone ─────────────────────
  // If suppliers have already sent invoices to this user's phone (before
  // they signed up), bind them so they show up in /inbox. bindPendingByPhone
  // also fires a catch-up WhatsApp per claimed row.
  let pendingInvoicesCount = 0;
  try {
    pendingInvoicesCount = await bindPendingByPhone(userId, phone);
  } catch (err) {
    console.warn(`• [provision] [${ts()}] bindPendingByPhone failed: ${err.message}`);
  }

  return {
    ok: true,
    user_id: userId,
    phone,
    erpnext_company: companyName,
    erpnext_user_email: userEmail,
    default_currency: currency,
    country,
    business_type,
    wallets: partial.wallets,
    pending_invoices_count: pendingInvoicesCount,
  };
}

/**
 * Post an opening balance JE without failing the whole provisioning if
 * something goes wrong (missing Opening Balance Equity, FX fetch fail, etc.).
 * For multi-currency wallets, fetches FX from frankfurter on the spot.
 */
async function postOpeningBalanceSafe(user, erp, walletErpName, walletCurrency, amount) {
  try {
    let exchangeRate = null;
    if (walletCurrency !== user.reporting_currency) {
      const r = await fetchRate(walletCurrency, user.reporting_currency);
      if (r.error || !r.rate) {
        console.warn(`• [provision] [${ts()}] opening balance JE skipped — FX fetch failed: ${r.error || 'no rate'}`);
        return;
      }
      exchangeRate = r.rate;
    }
    await recordOpeningBalance(user, erp, {
      walletErpName,
      walletCurrency,
      amount,
      exchangeRate,
    });
  } catch (err) {
    console.warn(`• [provision] [${ts()}] opening balance JE for ${walletErpName} skipped: ${err.message}`);
  }
}

module.exports = { provisionTenant, deriveAbbreviation };
