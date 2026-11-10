/**
 * Startup env validation. server.js calls assertEnv() before db.init(), so a missing or
 * malformed variable stops the boot with one line per problem instead of failing on the first
 * message. `npm run check:env` runs the same check without starting the server.
 *
 * Messages name the variable, never its value: boot logs end up in hosted log viewers.
 *
 * Not checked here: MEDIA_MAX_BYTES (src/media/download.js throws at load), the exact webhook
 * URL rules (src/webhook.js throws at boot on a malformed one; repeated here only so the
 * problem is listed alongside the others).
 */

const ALWAYS_REQUIRED = ['DATABASE_URL', 'OPENAI_API_KEY', 'ERPNEXT_URL'];
// Required unless LINE is the configured channel (see "messaging channels" in validateEnv).
const TWILIO_REQUIRED = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'];
const LINE_VARS = ['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN'];

const OPTIONAL_TEMPLATES = [
  ['TWILIO_DIGEST_CONTENT_SID', 'morning digest goes free-form, only inside the 24h window'],
  ['TWILIO_INVOICE_CONTENT_SID', 'invoices go free-form, only delivered inside the 24h window'],
  ['TWILIO_REMINDER_CONTENT_SID', 'payment reminders go free-form, only delivered inside the 24h window'],
];

function isSet(v) {
  return v != null && String(v).trim() !== '';
}

/** Parses an http(s) URL; returns { url } with any trailing slashes removed, or { error }. */
function parseHttpUrl(name, value) {
  let u;
  try {
    u = new URL(String(value).trim());
  } catch {
    return { error: `${name} is not a valid URL` };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: `${name} must be an http(s) URL` };
  return { url: String(value).trim().replace(/\/+$/, ''), https: u.protocol === 'https:' };
}

/**
 * The WhatsApp sender for TWILIO_ENV, i.e. the variable resolveFromNumber() in
 * src/channels/twilio.js (instantiated by src/twilio-client.js) will actually send from. That function picks, in live mode,
 * LIVE || SANDBOX || legacy, so a live config without *_LIVE but with *_SANDBOX set would send
 * from the sandbox number: refused here. Live falls back to the legacy number only when
 * *_SANDBOX is unset. TWILIO_ENV is lowercased but not trimmed, exactly as twilio-client.js
 * reads it (" live" would silently mean sandbox there, so it is an error here).
 * Returns { mode, name } of the variable used, or { error }.
 */
function senderFor(env) {
  const mode = String(env.TWILIO_ENV || 'sandbox').toLowerCase();
  if (mode !== 'sandbox' && mode !== 'live') return { error: 'TWILIO_ENV must be "sandbox" or "live"' };
  // twilio-client.js tests truthiness, not isSet(): a whitespace-only value is "set" there.
  const has = (name) => Boolean(env[name]);
  if (mode === 'live') {
    if (isSet(env.TWILIO_WHATSAPP_NUMBER_LIVE)) return { mode, name: 'TWILIO_WHATSAPP_NUMBER_LIVE' };
    if (has('TWILIO_WHATSAPP_NUMBER_SANDBOX')) {
      return { mode, error: 'TWILIO_ENV=live needs TWILIO_WHATSAPP_NUMBER_LIVE (without it the bot sends from TWILIO_WHATSAPP_NUMBER_SANDBOX)' };
    }
    if (isSet(env.TWILIO_WHATSAPP_NUMBER)) return { mode, name: 'TWILIO_WHATSAPP_NUMBER' };
    return { mode, error: 'TWILIO_ENV=live needs TWILIO_WHATSAPP_NUMBER_LIVE (or the legacy TWILIO_WHATSAPP_NUMBER)' };
  }
  if (isSet(env.TWILIO_WHATSAPP_NUMBER_SANDBOX)) return { mode, name: 'TWILIO_WHATSAPP_NUMBER_SANDBOX' };
  if (has('TWILIO_WHATSAPP_NUMBER_SANDBOX')) return { mode, error: 'TWILIO_WHATSAPP_NUMBER_SANDBOX is blank' };
  if (isSet(env.TWILIO_WHATSAPP_NUMBER)) return { mode, name: 'TWILIO_WHATSAPP_NUMBER' };
  return { mode, error: 'TWILIO_ENV=sandbox needs TWILIO_WHATSAPP_NUMBER_SANDBOX (or the legacy TWILIO_WHATSAPP_NUMBER)' };
}

/**
 * Checks `env` without touching it. Returns { ok, errors, warnings, normalized } where
 * `normalized` holds cleaned values (ERPNEXT_URL without a trailing slash) for assertEnv to apply.
 */
function validateEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  const normalized = {};
  const production = env.NODE_ENV === 'production';

  for (const name of ALWAYS_REQUIRED) {
    if (!isSet(env[name])) errors.push(`${name} is not set`);
  }

  if (isSet(env.ERPNEXT_URL)) {
    const r = parseHttpUrl('ERPNEXT_URL', env.ERPNEXT_URL);
    if (r.error) errors.push(r.error);
    else if (r.url !== env.ERPNEXT_URL) normalized.ERPNEXT_URL = r.url;
  }

  // ── messaging channels (Twilio WhatsApp / LINE) ─────────────────────────────────────────
  // Twilio is required unless LINE is fully configured; then it's optional (a warning when
  // absent) but, once any TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN is set, validated in full.
  // At least one channel must be complete. LINE here is only "both vars or neither"; anything
  // further about LINE belongs to the LINE adapter.
  const lineSet = LINE_VARS.filter((n) => isSet(env[n]));
  const lineOn = lineSet.length === LINE_VARS.length;
  if (lineSet.length && !lineOn) {
    errors.push(`${LINE_VARS.find((n) => !isSet(env[n]))} is not set (LINE needs both ${LINE_VARS.join(' and ')}, or neither)`);
  }
  const twilioOn = !lineOn || TWILIO_REQUIRED.some((n) => isSet(env[n]));
  if (twilioOn) {
    for (const name of TWILIO_REQUIRED) {
      if (!isSet(env[name])) errors.push(`${name} is not set`);
    }
  } else {
    warnings.push('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set: WhatsApp is off (LINE only; customer invoices and reminders need WhatsApp)');
  }
  // ── end messaging channels ──────────────────────────────────────────────────────────────

  const sender = twilioOn ? senderFor(env) : {};
  if (sender.error) errors.push(sender.error);
  else if (sender.name && !String(env[sender.name]).trim().startsWith('whatsapp:')) {
    warnings.push(`${sender.name} should start with "whatsapp:" (e.g. whatsapp:+14155238886)`);
  }
  if (production && sender.mode === 'sandbox') warnings.push('NODE_ENV=production with TWILIO_ENV=sandbox: only numbers that joined the sandbox can use the bot');

  // Callback URLs: a malformed one is an error anywhere (src/webhook.js would throw at boot anyway).
  const callbackUrls = [];
  for (const name of ['PUBLIC_BASE_URL', 'TWILIO_WEBHOOK_URL']) {
    if (!isSet(env[name])) continue;
    const r = parseHttpUrl(name, env[name]);
    if (r.error) errors.push(r.error);
    else callbackUrls.push({ name, https: r.https });
  }

  if (production) {
    if (twilioOn && !isSet(env.PUBLIC_BASE_URL) && !isSet(env.TWILIO_WEBHOOK_URL)) {
      errors.push('NODE_ENV=production needs PUBLIC_BASE_URL or TWILIO_WEBHOOK_URL (otherwise POST /webhook refuses every request)');
    }
    for (const u of callbackUrls) {
      if (!u.https) errors.push(`${u.name} must be https in production`);
    }
    if (isSet(env.TWILIO_WEBHOOK_URL) && !isSet(env.PUBLIC_BASE_URL)) {
      warnings.push('PUBLIC_BASE_URL is not set: POST /twilio/status refuses callbacks and sends request no status callback');
    }
    if (twilioOn && !isSet(env.TWILIO_CONFIRMATION_CONTENT_SID)) errors.push('TWILIO_CONFIRMATION_CONTENT_SID is not set (confirmation cards need it; create with `npm run create-template`)');
    // Same test as src/messages.js.
    if (String(env.LOG_MESSAGES || '').toLowerCase() === 'true') errors.push('LOG_MESSAGES must not be true in production (retention policy: no chat logs)');
    if (isSet(env.SEED_TEST_USER_PHONE)) errors.push('SEED_TEST_USER_PHONE must be unset in production (it seeds a test user on every boot)');
  }

  for (const [name, effect] of twilioOn ? OPTIONAL_TEMPLATES : []) {
    if (!isSet(env[name])) warnings.push(`${name} is not set: ${effect}`);
  }
  for (const name of ['ERPNEXT_API_KEY', 'ERPNEXT_API_SECRET']) {
    if (!isSet(env[name])) warnings.push(`${name} is not set: only needed by the seeded test user and scripts/ (real users carry their own credentials)`);
  }

  return { ok: errors.length === 0, errors, warnings, normalized };
}

/**
 * Validates process.env, logs each problem on its own line, applies `normalized`, and exits(1)
 * when anything is an error. `exit` and `log` are injectable for scripts/tests.
 */
function assertEnv({ env = process.env, exit = (code) => process.exit(code), log = console } = {}) {
  const result = validateEnv(env);
  for (const w of result.warnings) log.warn(`[config] ⚠ ${w}`);
  for (const e of result.errors) log.error(`[config] ✖ ${e}`);
  if (!result.ok) {
    log.error(`[config] ${result.errors.length} problem(s) in the environment; see .env.example and DEPLOY.md`);
    exit(1);
    return result;
  }
  Object.assign(env, result.normalized);
  return result;
}

module.exports = { validateEnv, assertEnv, senderFor };

// `npm run check:env` — same checks, no server.
if (require.main === module) {
  require('dotenv').config();
  const r = assertEnv();
  if (r.ok) console.log(`[config] env OK (${r.warnings.length} warning(s))`);
}
