/**
 * Turn a user who finished in-chat onboarding (subscription_status 'pending_provisioning') into
 * an active one: create their ERPNext Company, run the same setup `smoke-erpnext.js --fix` does
 * (scripts/lib/company-setup.js), then point the users row at it.
 *
 *   node scripts/provision-user.js --list-pending
 *   node scripts/provision-user.js --user 12 --dry-run
 *   node scripts/provision-user.js --user 12 [--company "Siam Gems Co., Ltd."] [--abbr SG] [--notify]
 *
 * PILOT MODE: the user row gets the ADMIN API key/secret from ERPNEXT_API_KEY / ERPNEXT_API_SECRET.
 * Those credentials can read and write every Company on the instance; the bot scopes itself to
 * users.erpnext_company, but nothing on the ERPNext side enforces that. Before onboarding users
 * who must not be able to reach each other's books, issue a per-company ERPNext user with a User
 * Permission on its Company and store that user's keys instead.
 *
 * Exit code: 0 done, 1 an ERPNext / database step failed, 2 refused (bad arguments, unknown or
 * closed user, currency mismatch).
 */
const H = require('./lib/smoke-helpers');
const { setupCompany } = require('./lib/company-setup');
const { countryInfo } = require('../src/onboarding/countries');
const { maskPhone } = require('../src/onboarding');
const M = require('../src/onboarding/messages');

const USAGE = `Usage:
  node scripts/provision-user.js --list-pending
  node scripts/provision-user.js --user <id> [--company "Name"] [--abbr ABC] [--dry-run] [--notify]

  --user <id>        users.id to provision (status pending_provisioning, or active to re-run setup)
  --company "Name"   ERPNext Company name (default: the user's existing erpnext_company, else display_name)
  --abbr ABC         Company abbreviation for a new Company (default: derived from the name)
  --dry-run          print what would happen; no ERPNext call, no database write
  --notify           WhatsApp the user that their books are ready (free-form: needs the 24h window)
  --list-pending     list users waiting for provisioning
  -h, --help         this text

Env: DATABASE_URL, ERPNEXT_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET (admin — see PILOT MODE in the file header)
`;

const CHART_OF_ACCOUNTS = 'Standard with Numbers';
const LEGAL_WORDS = /^(co|company|ltd|limited|inc|llc|plc|pte|pty|sdn|bhd|pt|tbk|jsc|corp|corporation|the|and|of)$/i;

function parseArgs(argv) {
  const opts = { user: null, company: null, abbr: null, dryRun: false, notify: false, listPending: false, help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const value = () => {
      if (inline != null) return inline;
      const v = argv[i + 1];
      if (v == null || v.startsWith('--')) {
        opts.errors.push(`${flag} needs a value`);
        return null;
      }
      i++;
      return v;
    };
    switch (flag) {
      case '-h':
      case '--help': opts.help = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--notify': opts.notify = true; break;
      case '--list-pending': opts.listPending = true; break;
      case '--user': {
        const v = value();
        if (v != null && !/^\d+$/.test(v)) opts.errors.push(`--user must be a numeric users.id, got "${v}"`);
        else if (v != null) opts.user = Number(v);
        break;
      }
      case '--company': opts.company = value(); break;
      case '--abbr': opts.abbr = value(); break;
      default: opts.errors.push(`unknown argument ${a}`);
    }
  }
  if (!opts.help && !opts.listPending && opts.user == null) opts.errors.push('pass --user <id> or --list-pending');
  if (opts.abbr != null && !/^[A-Za-z0-9]{1,10}$/.test(opts.abbr)) opts.errors.push('--abbr must be 1–10 letters/digits');
  return opts;
}

/** "Siam Gems Co., Ltd." → "SG"; "Bersol" → "BER". ASCII letters/digits only (ERPNext suffixes every record with it). */
function deriveAbbr(name, fallback = 'CO') {
  const words = String(name || '')
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const meaningful = words.filter((w) => !LEGAL_WORDS.test(w));
  const use = meaningful.length ? meaningful : words;
  let abbr = use.length > 1 ? use.map((w) => w[0]).join('') : (use[0] || '').slice(0, 3);
  abbr = abbr.toUpperCase().slice(0, 5);
  return abbr || fallback;
}

function addYears(date, n) {
  const d = new Date(date);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
}

async function tryGet(erp, doctype, name) {
  try {
    return (await erp.getResource(doctype, name)).data;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** First of ABBR, ABBR2 … ABBR9 that no other Company uses. */
async function freeAbbr(erp, wanted) {
  for (let i = 1; i <= 9; i++) {
    const candidate = i === 1 ? wanted : `${wanted}${i}`;
    const r = await erp.listResource('Company', { filters: [['abbr', '=', candidate]], fields: ['name'], limit: 1 });
    if (!(r.data || []).length) return candidate;
  }
  throw new Error(`abbreviations ${wanted}…${wanted}9 are all taken; pass --abbr`);
}

async function listPending(db, out) {
  const r = await db.query(
    `SELECT id, phone, display_name, country, reporting_currency, vat_registered, tax_id, onboarding_source, created_at
     FROM users WHERE subscription_status = 'pending_provisioning' ORDER BY id`
  );
  if (!r.rows.length) {
    out('[provision] no users pending provisioning');
    return 0;
  }
  out(`[provision] ${r.rows.length} pending:`);
  for (const u of r.rows) {
    const vat = u.vat_registered == null ? '?' : Number(u.vat_registered) === 1 ? 'yes' : 'no';
    out(`  id=${u.id}  ${JSON.stringify(u.display_name)}  ${u.country}/${u.reporting_currency}  vat=${vat}  tax_id=${u.tax_id ? 'set' : '-'}  phone=${maskPhone(u.phone)}  source=${u.onboarding_source || '-'}  since ${String(u.created_at).slice(0, 10)}`);
  }
  return 0;
}

/**
 * The script body. `deps` lets tests inject the db module, an output function and a channel (deps.channel, or the legacy deps.twilio);
 * the CLI wrapper at the bottom uses the real ones.
 */
async function run(argv, deps = {}) {
  const db = deps.db || require('../src/db');
  const out = deps.out || ((s) => console.log(s));
  const env = deps.env || process.env;
  const opts = parseArgs(argv);
  if (opts.help) {
    out(USAGE);
    return 0;
  }
  if (opts.errors.length) {
    for (const e of opts.errors) out(`[provision] ${e}`);
    out(USAGE);
    return 2;
  }
  if (opts.listPending) return listPending(db, out);

  const user = (await db.query('SELECT * FROM users WHERE id = $1', [opts.user])).rows[0];
  if (!user) {
    out(`[provision] no user with id ${opts.user}`);
    return 2;
  }
  if (!['pending_provisioning', 'active'].includes(user.subscription_status)) {
    out(`[provision] user ${user.id} is "${user.subscription_status}" — only pending_provisioning (or active, to re-run setup) can be provisioned`);
    return 2;
  }

  const companyName = (opts.company || user.erpnext_company || user.display_name || '').trim();
  if (!companyName) {
    out('[provision] the user has no display_name; pass --company "Name"');
    return 2;
  }
  const currency = user.reporting_currency || user.default_currency || 'THB';
  const countryName = countryInfo(user.country)?.name || user.country || 'Thailand';
  // Names with no ASCII letters (e.g. Thai) fall back to U<id>, so they don't all collide on one abbr.
  const abbrWanted = (opts.abbr || deriveAbbr(companyName, `U${user.id}`)).toUpperCase();
  // A re-run on an active user keeps a still-valid expiry; provisioning starts the year.
  const current = user.subscription_status === 'active' && user.subscription_expires_at ? String(user.subscription_expires_at).slice(0, 10) : null;
  const expires = current && current >= new Date().toISOString().slice(0, 10) ? current : addYears(new Date(), 1);

  // Another user already on this Company would share its books (ERPNext matches names case-insensitively).
  const taken = (await db.query(
    'SELECT id FROM users WHERE LOWER(erpnext_company) = LOWER($1) AND id <> $2 ORDER BY id LIMIT 1', [companyName, user.id]
  )).rows[0];
  if (taken) {
    out(`[provision] REFUSED: Company ${JSON.stringify(companyName)} already belongs to user ${taken.id}; pass --company with a distinct name`);
    return 2;
  }
  const { ERPNEXT_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET } = env;

  out(`[provision] user ${user.id} ${JSON.stringify(user.display_name)} (${user.subscription_status}) phone=${maskPhone(user.phone)}`);
  out(`[provision] Company ${JSON.stringify(companyName)}  currency=${currency}  country=${countryName}  chart="${CHART_OF_ACCOUNTS}"`);

  const missing = [['ERPNEXT_URL', ERPNEXT_URL], ['ERPNEXT_API_KEY', ERPNEXT_API_KEY], ['ERPNEXT_API_SECRET', ERPNEXT_API_SECRET]]
    .filter(([, v]) => !v).map(([k]) => k);

  if (opts.dryRun) {
    out('[provision] DRY RUN — no ERPNext call, no database write. Would:');
    out(`  1. find Company ${JSON.stringify(companyName)}, or create it (abbr ${abbrWanted} unless taken, default_currency ${currency}, country ${countryName}, chart "${CHART_OF_ACCOUNTS}")`);
    out('  2. set it up like smoke-erpnext --fix: receivable in a 2nd currency, Duties and Taxes group, Output VAT / Input VAT / WHT Payable, Stores warehouse, Products item group, GEN-SALE / GEN-PURCHASE');
    out(`  3. update users ${user.id}: erpnext_company=${JSON.stringify(companyName)}, erpnext_api_key/secret = admin creds (PILOT MODE), subscription_status=active, subscription_expires_at=${expires}`);
    if (opts.notify) out('  4. WhatsApp the user that their books are ready (free-form: delivered only inside the 24h window)');
    if (missing.length) out(`[provision] note: ${missing.join(', ')} not set — a real run would refuse`);
    return 0;
  }
  if (missing.length) {
    out(`[provision] missing env: ${missing.join(', ')}`);
    return 2;
  }

  const erpnext = require('../src/erpnext');
  const erp = erpnext.forUser({
    erpnext_url: ERPNEXT_URL.replace(/\/$/, ''), erpnext_api_key: ERPNEXT_API_KEY, erpnext_api_secret: ERPNEXT_API_SECRET,
    erpnext_company: companyName,
  });

  let created = false;
  let setup;
  try {
    let company = await tryGet(erp, 'Company', companyName);
    if (company) {
      if (company.default_currency && company.default_currency !== currency) {
        out(`[provision] REFUSED: Company ${JSON.stringify(companyName)} exists with currency ${company.default_currency}, the user reports in ${currency}`);
        return 2;
      }
      out(`[provision] Company exists (abbr ${company.abbr || '?'}) — reusing it`);
    } else {
      const abbr = await freeAbbr(erp, abbrWanted);
      const r = await erp.createResource('Company', {
        company_name: companyName,
        abbr,
        default_currency: currency,
        country: countryName,
        create_chart_of_accounts_based_on: 'Standard Template',
        chart_of_accounts: CHART_OF_ACCOUNTS,
      });
      company = r.data || { name: companyName, abbr };
      created = true;
      out(`[provision] + created Company ${JSON.stringify(company.name)} (abbr ${company.abbr || abbr})`);
    }
    setup = await setupCompany(erp, { base: currency });
    for (const s of setup) out(`  ${s.created ? '+ created' : '✔ exists '} ${s.doctype} ${s.name} (${s.why})`);
  } catch (err) {
    out(`[provision] ERPNext step failed: ${H.serverMessage(err)}`);
    out('[provision] the users row was NOT changed; fix the cause and re-run (every step is idempotent)');
    return 1;
  }

  await db.query(
    `UPDATE users SET erpnext_company = $1, erpnext_api_key = $2, erpnext_api_secret = $3,
       subscription_status = 'active', subscription_expires_at = $4, updated_at = $5
     WHERE id = $6`,
    [companyName, ERPNEXT_API_KEY, ERPNEXT_API_SECRET, expires, new Date().toISOString(), user.id]
  );

  let notified = 'no (--notify not given)';
  if (opts.notify) {
    try {
      // The user's own channel, picked from their address (WhatsApp number or LINE user).
      // deps.channel / deps.twilio (legacy name) are test injections.
      const channel = deps.channel || deps.twilio || require('../src/channels').forAddress(user.phone);
      const sid = await channel.sendText(user.phone, M.BOOKS_READY);
      if (channel.supportsTemplates === false) {
        // LINE push: no 24h window, delivered as soon as LINE accepts it.
        notified = sid ? `pushed over ${channel.name} (${sid})` : `FAILED: not sent (${channel.name} not configured? see the log above)`;
      } else {
        // No approved template exists for this message: free-form, so WhatsApp delivers it only if the
        // user wrote in the last 24h. Twilio returns a SID either way; a late failure (63016) shows
        // only in the status callback.
        notified = sid
          ? `accepted by Twilio (${sid}) — free-form, so delivered only if the user messaged in the last 24h; otherwise tell them another way`
          : 'FAILED: not sent (Twilio not configured? see the log above)';
      }
    } catch (err) {
      notified = `FAILED: ${err.message}`;
    }
  }

  const made = setup.filter((s) => s.created).length;
  out('');
  out('[provision] done');
  out(`  user:     ${user.id} ${JSON.stringify(user.display_name)} → active until ${expires}`);
  out(`  company:  ${JSON.stringify(companyName)} (${created ? 'created' : 'existing'}), ${made} setup record(s) created, ${setup.length - made} already there`);
  out('  creds:    admin ERPNEXT_API_KEY / SECRET (PILOT MODE — not isolated per company)');
  out(`  notified: ${notified}`);
  return 0;
}

if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[provision] failed:', err);
      process.exit(1);
    });
}

module.exports = { run, parseArgs, deriveAbbr, USAGE, CHART_OF_ACCOUNTS };
