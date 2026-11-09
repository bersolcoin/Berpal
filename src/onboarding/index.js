/**
 * In-chat onboarding for unknown addresses (a WhatsApp number or a LINE user, src/channels/address.js;
 * "phone" below means that address — it is what users.phone holds), plus the account-level replies registered users
 * get before the LLM (pending provisioning, closed account, "delete my account").
 *
 * A deterministic state machine — no LLM call — so an unknown number costs a couple of queries and
 * the replies are predictable. Steps (one onboarding_sessions row per phone):
 *
 *   name → country → vat → tax_id → accountant_name → accountant_phone → consent → users row
 *
 * Every step accepts "back" (previous question) and "cancel" (wipe the session). The finished
 * signup is a users row with subscription_status 'pending_provisioning'; an operator then runs
 * scripts/provision-user.js to create the ERPNext Company and activate it.
 *
 * Gating: ONBOARDING_MODE=closed only lets a number start with a code from ONBOARDING_INVITE_CODES
 * (default closed when NODE_ENV=production, open otherwise). Each unknown number gets at most
 * DAILY_LIMIT messages per UTC day; past that the bot stays silent.
 *
 * Logging: this module logs the inbound/outbound onboarding messages itself (whatsapp.js does not),
 * so answers to the tax-ID and accountant questions never reach the server log — they are logged
 * as "[onboarding step N answer]" — and the accountant's name is not echoed in logged prompts.
 *
 * Answers are personal data collected before consent: an abandoned session is dropped after
 * SESSION_TTL_DAYS (checked on read, pruned with the daily rate-limit rows).
 */
const { query, withTransaction } = require('../db');
const { normalizePhone } = require('../users');
const { maskAddress, channelOf } = require('../channels/address');
const { cleanText } = require('../media/vision');
const { ts } = require('../erp-sync/common');
const { normalizeThaiTaxId } = require('./thai-tax-id');
const { DEFAULT_COUNTRY, parseCountry, countryInfo } = require('./countries');
const M = require('./messages');
const log = require('../log');

const DAILY_LIMIT = 20;
const DELETE_CONFIRM_WINDOW_MS = 15 * 60 * 1000;
const SESSION_TTL_DAYS = 7;
const NAME_MAX = 80;
const STEPS = ['name', 'country', 'vat', 'tax_id', 'accountant_name', 'accountant_phone', 'consent'];
// Steps whose answers are never logged, with the step number users see in the README (4 = tax ID, 5 = accountant).
const MASKED_STEPS = { tax_id: 4, accountant_name: 5, accountant_phone: 5 };

// ── helpers ──────────────────────────────────────────────────────────

/**
 * Last 4 characters only (address.maskAddress): operator logs must not carry full phone numbers
 * or LINE user ids. "+66812345678" → "…5678", "line:U…abcd" → "line:…abcd".
 */
function maskPhone(phone) {
  const id = String(phone || '').trim();
  return id ? maskAddress(id) : '?';
}

function mode() {
  const m = String(process.env.ONBOARDING_MODE || '').trim().toLowerCase();
  if (m === 'open' || m === 'closed') return m;
  return process.env.NODE_ENV === 'production' ? 'closed' : 'open';
}

function inviteCodes() {
  return String(process.env.ONBOARDING_INVITE_CODES || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * The configured invite code `text` is (trimmed, case-insensitive), or null. With `inSentence`,
 * a code that appears as a whole word ("my code is GEMS!") also counts.
 */
function matchInvite(text, { inSentence = false } = {}) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  const codes = inviteCodes();
  const exact = codes.find((c) => c.toLowerCase() === t);
  if (exact || !inSentence) return exact || null;
  const words = new Set(t.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean));
  return codes.find((c) => words.has(c.toLowerCase())) || null;
}

/** Lower-cased, trimmed, trailing punctuation dropped: for keyword matching only. */
function keyword(text) {
  return String(text || '').trim().toLowerCase().replace(/[.!]+$/, '').replace(/\s+/g, ' ');
}

const isSkip = (k) => k === 'skip' || k === 'ข้าม';
const YES = new Set(['yes', 'y', 'yeah', 'yep', 'ใช่', 'จด', 'จดแล้ว']);
const NO = new Set(['no', 'n', 'nope', 'ไม่', 'ไม่ใช่', 'ไม่ได้จด', 'ยังไม่จด']);
// A message that is only a greeting is never an answer (no business is called "Hello").
const GREETINGS = new Set(['hi', 'hello', 'hey', 'hiya', 'hi there', 'hello there', 'สวัสดี', 'สวัสดีครับ', 'สวัสดีค่ะ', 'หวัดดี']);
const AGREE = new Set(['i agree', 'agree', 'ตกลง']);
const REFUSE = new Set(['no', 'n', 'nope', 'disagree', 'i disagree', 'i do not agree', "i don't agree", 'i dont agree', 'ไม่', 'ไม่ตกลง', 'ไม่ยินยอม']);

/** A business / person name: 2–NAME_MAX chars after cleaning, at least one letter or digit, no < > (ERPNext rejects them in names). */
function parseName(text) {
  const name = cleanText(String(text || ''), 1000);
  if (!name || name.length < 2 || name.length > NAME_MAX) return null;
  if (/[<>]/.test(name) || !/[\p{L}\p{N}]/u.test(name)) return null;
  return name;
}

/**
 * Accountant phone → "+<digits>" (E.164-ish). Local numbers ("081 234 5678") get the country's
 * calling code; "+…" and "00…" are taken as international. null when it isn't a phone number.
 */
function normalizeContactPhone(raw, countryCode) {
  const s = String(raw || '').trim();
  if (!s || /[^\d\s\-().+]/.test(s) || s.lastIndexOf('+') > 0) return null;
  const digits = s.replace(/\D/g, '');
  const cc = countryInfo(countryCode)?.callingCode || null;
  let e164;
  if (s.startsWith('+')) e164 = digits;
  else if (digits.startsWith('00')) e164 = digits.slice(2);
  else if (digits.startsWith('0')) {
    if (!cc) return null;
    e164 = cc + digits.slice(1);
  } else if (cc && !digits.startsWith(cc)) e164 = cc + digits;
  else e164 = digits;
  if (e164.length < 8 || e164.length > 15) return null;
  return `+${e164}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// The UTC day the pruning DELETEs last ran in this process. Every unknown number still costs the
// one UPSERT (the cap must hold for INVITE_ONLY replies too), but the two table scans run once per
// process per day rather than on each distinct number's first message — a scripted sweep of fresh
// numbers in closed mode used to trigger them per number.
let lastPruneDay = null;

/** Count this message; true when the phone is still under today's cap. */
async function allowMessage(phone) {
  const day = today();
  const r = await query(
    `INSERT INTO onboarding_rate_limits (phone, day, msg_count) VALUES ($1, $2, 1)
     ON CONFLICT (phone, day) DO UPDATE SET msg_count = onboarding_rate_limits.msg_count + 1
     RETURNING msg_count`,
    [phone, day]
  );
  const n = Number(r.rows[0].msg_count);
  if (lastPruneDay !== day) {
    // First time today: drop older days (keeps the table small), and abandoned signups — their
    // answers were collected before consent.
    lastPruneDay = day;
    await query('DELETE FROM onboarding_rate_limits WHERE day < $1', [day]);
    await query('DELETE FROM onboarding_sessions WHERE updated_at < $1', [sessionCutoff()]);
  }
  if (n === DAILY_LIMIT + 1) console.log(`• [onboarding] [${ts()}] rate limit reached phone=${maskPhone(phone)} — silent until tomorrow`);
  return n <= DAILY_LIMIT;
}

// ── sessions ─────────────────────────────────────────────────────────

function sessionCutoff() {
  return new Date(Date.now() - SESSION_TTL_DAYS * 86400000).toISOString();
}

async function loadSession(phone) {
  const r = await query('SELECT * FROM onboarding_sessions WHERE phone = $1', [phone]);
  const row = r.rows[0];
  if (!row) return null;
  if (String(row.updated_at) < sessionCutoff()) {
    await deleteSession(phone);
    return null;
  }
  let answers = {};
  try {
    answers = JSON.parse(row.answers || '{}') || {};
  } catch {
    answers = {};
  }
  return { ...row, answers };
}

async function startSession(phone, source) {
  const now = new Date().toISOString();
  await query(
    `INSERT INTO onboarding_sessions (phone, step, answers, source, created_at, updated_at)
     VALUES ($1, 'name', '{}', $2, $3, $3)`,
    [phone, source, now]
  );
  console.log(`• [onboarding] [${ts()}] session started phone=${maskPhone(phone)} source=${source}`);
}

async function saveSession(phone, step, answers) {
  await query('UPDATE onboarding_sessions SET step = $1, answers = $2, updated_at = $3 WHERE phone = $4',
    [step, JSON.stringify(answers), new Date().toISOString(), phone]);
}

async function deleteSession(phone) {
  await query('DELETE FROM onboarding_sessions WHERE phone = $1', [phone]);
}

/** The question for a step (country-dependent for the tax id, name-dependent for the phone). */
function prompt(step, answers, channel) {
  switch (step) {
    case 'tax_id': return (answers.country || DEFAULT_COUNTRY) === 'TH' ? M.PROMPTS.tax_id_th : M.PROMPTS.tax_id_other;
    case 'accountant_phone': return M.PROMPTS.accountant_phone(answers.accountant_name || 'your accountant');
    case 'consent': return M.consentNotice(channel);
    default: return M.PROMPTS[step];
  }
}

const ask = (step, answers, channel) => `${prompt(step, answers, channel)}${M.FOOTER}`;

function retry(step, answers) {
  if (step === 'tax_id') return (answers.country || DEFAULT_COUNTRY) === 'TH' ? M.RETRY.tax_id_th : M.RETRY.tax_id_other;
  return M.RETRY[step];
}

/**
 * Validate one answer. → { ok: true, set: {…}, next?: step } or { ok: false }.
 * `next` overrides the default "following step" (skipping the accountant skips their phone too).
 */
function parseAnswer(step, text, answers) {
  const k = keyword(text);
  switch (step) {
    case 'name': {
      const name = parseName(text);
      return name ? { ok: true, set: { name } } : { ok: false };
    }
    case 'country': {
      const code = isSkip(k) ? DEFAULT_COUNTRY : parseCountry(text);
      return code ? { ok: true, set: { country: code } } : { ok: false };
    }
    case 'vat':
      if (YES.has(k)) return { ok: true, set: { vat_registered: 1 } };
      if (NO.has(k)) return { ok: true, set: { vat_registered: 0 } };
      return { ok: false };
    case 'tax_id': {
      if (isSkip(k)) return { ok: true, set: { tax_id: null } };
      if ((answers.country || DEFAULT_COUNTRY) === 'TH') {
        const id = normalizeThaiTaxId(text);
        return id ? { ok: true, set: { tax_id: id } } : { ok: false };
      }
      const id = cleanText(String(text || ''), 40);
      return id && id.length >= 5 && id.length <= 20 ? { ok: true, set: { tax_id: id } } : { ok: false };
    }
    case 'accountant_name': {
      if (isSkip(k)) return { ok: true, set: { accountant_name: null, accountant_phone: null }, next: 'consent' };
      const name = parseName(text);
      return name ? { ok: true, set: { accountant_name: name } } : { ok: false };
    }
    case 'accountant_phone': {
      if (isSkip(k)) return { ok: true, set: { accountant_phone: null } };
      const phone = normalizeContactPhone(text, answers.country || DEFAULT_COUNTRY);
      return phone ? { ok: true, set: { accountant_phone: phone } } : { ok: false };
    }
    case 'consent':
      return AGREE.has(k) ? { ok: true, set: { consent_at: new Date().toISOString() } } : { ok: false };
    default:
      return { ok: false };
  }
}

function previousStep(step, answers) {
  const i = STEPS.indexOf(step);
  if (i <= 0) return STEPS[0];
  const prev = STEPS[i - 1];
  // The accountant's phone was never asked when they skipped the accountant.
  if (prev === 'accountant_phone' && !answers.accountant_name) return 'accountant_name';
  return prev;
}

/** Finished answers → users row. Returns the new row. */
async function createUser(phone, answers, source) {
  const country = countryInfo(answers.country) ? answers.country : DEFAULT_COUNTRY;
  const info = countryInfo(country);
  const now = new Date().toISOString();
  const r = await query(
    `INSERT INTO users (
       phone, display_name, country, default_currency, reporting_currency, timezone,
       vat_registered, tax_id, subscription_status, subscription_expires_at, erpnext_company,
       accountant_name, accountant_phone, consent_at, consent_version, onboarding_source,
       created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, 'pending_provisioning', NULL, NULL, $8, $9, $10, $11, $12, $13, $13)
     RETURNING *`,
    [phone, answers.name, country, info.currency, info.timezone,
      answers.vat_registered == null ? null : Number(answers.vat_registered), answers.tax_id || null,
      answers.accountant_name || null, answers.accountant_phone || null,
      answers.consent_at || now, M.consentVersion(channelOf(phone)), source, now]
  );
  return r.rows[0];
}

/**
 * A message from a phone with no users row. Returns the reply text, or null to stay silent
 * (rate-limited). Media is ignored here: only the text answers the current question. Logs the
 * inbound message and the reply itself (masked for the tax-ID / accountant steps).
 */
async function handleUnknownPhone(from, body) {
  const phone = normalizePhone(from);
  if (!phone) return null;
  if (!(await allowMessage(phone))) {
    log.msgIn(from, '[onboarding message, rate-limited — not shown]');
    return null;
  }

  const text = String(body || '');
  const k = keyword(text);
  const session = await loadSession(phone);
  const masked = session && MASKED_STEPS[session.step];
  log.msgIn(from, masked && text.trim() ? `[onboarding step ${masked} answer]` : text);
  // Prompts can carry answers (the accountant's name); the logged copy is built without them.
  const reply = (sent, logged = sent) => {
    log.msgOut(from, logged, 'onboarding');
    return sent;
  };
  const channel = channelOf(phone);
  const askLogged = (step, answers) => reply(ask(step, answers, channel), ask(step, { country: answers.country }, channel));

  if (!session) {
    const code = matchInvite(text, { inSentence: true });
    if (!code && mode() === 'closed') return reply(M.INVITE_ONLY);
    if (k === 'cancel') return reply(M.CANCELLED);
    // Self-serve source = the channel they came in on ('whatsapp' | 'line').
    await startSession(phone, code ? `invite:${code}` : channelOf(phone));
    return reply(`${M.WELCOME}\n\n${ask('name', {})}`);
  }

  const { step, answers } = session;
  if (k === 'cancel') {
    await deleteSession(phone);
    console.log(`• [onboarding] [${ts()}] session cancelled phone=${maskPhone(phone)} at=${step}`);
    return reply(M.CANCELLED);
  }
  if (k === 'back') {
    const prev = previousStep(step, answers);
    await saveSession(phone, prev, answers);
    return askLogged(prev, answers);
  }
  // Blank (media only), the invite code sent again, or a bare greeting (LINE's `follow` event
  // arrives as 'hi', e.g. after unblocking mid-signup): re-ask instead of taking it as the answer.
  if (!text.trim() || matchInvite(text) || GREETINGS.has(k)) return askLogged(step, answers);

  if (step === 'consent' && REFUSE.has(k)) {
    await deleteSession(phone);
    console.log(`• [onboarding] [${ts()}] consent refused phone=${maskPhone(phone)} — session removed`);
    return reply(M.CONSENT_REFUSED);
  }

  const parsed = parseAnswer(step, text, answers);
  if (!parsed.ok) return reply(`${retry(step, answers)}${M.FOOTER}`);
  const next = { ...answers, ...parsed.set };

  const nextStep = parsed.next || STEPS[STEPS.indexOf(step) + 1];
  if (step !== 'consent') {
    await saveSession(phone, nextStep, next);
    return askLogged(nextStep, next);
  }

  // Consent given: the signup is complete.
  let user;
  try {
    user = await createUser(phone, next, session.source);
  } catch (err) {
    // Unique phone: a users row appeared meanwhile (operator added it by hand). Nothing to redo.
    if (err.code === '23505' || /duplicate|unique/i.test(err.message)) {
      await deleteSession(phone);
      return reply(M.COMPLETED);
    }
    throw err;
  }
  await deleteSession(phone);
  console.log(`[onboarding] NEW USER pending provisioning: id=${user.id} name=${JSON.stringify(user.display_name)} ` +
    `country=${user.country} phone=${maskPhone(phone)} source=${user.onboarding_source} — run: node scripts/provision-user.js --user ${user.id}`);
  return reply(M.COMPLETED);
}

// ── registered users ─────────────────────────────────────────────────

const DELETE_REQUEST = /^delete my account$/;

/** Close the account: personal details out, ERPNext ledger untouched. */
async function closeAccount(user) {
  const now = new Date().toISOString();
  // One transaction: a failure part-way leaves the account active with the request still pending
  // (the user can send DELETE again), never "closed" with receipts or messages left behind.
  await withTransaction(async (c) => {
    // Stored receipts and logged message bodies are personal data too; the ledger stays in ERPNext.
    await c.query('DELETE FROM media_blobs WHERE user_id = $1', [user.id]);
    await c.query('DELETE FROM messages WHERE user_id = $1', [user.id]);
    await c.query(`UPDATE conversations SET draft_transaction = NULL, recent_messages = '[]', state = 'idle', updated_at = $1 WHERE user_id = $2`,
      [now, user.id]);
    // Customer phones (outreach log) and counterparty names (duplicate fingerprints) are personal
    // data about third parties; the ERPNext ledger keeps the truth either way.
    await c.query('DELETE FROM outreach_log WHERE user_id = $1', [user.id]);
    await c.query('DELETE FROM trust_fingerprints WHERE user_id = $1', [user.id]);
    // The contact cache holds customers' phones and emails: the "customer contact log" the user is
    // told is removed. ERPNext keeps its own Customer/Supplier records with the ledger.
    await c.query('DELETE FROM counterparty_cache WHERE owner_user_id = $1', [user.id]);
    // users.phone stays: it is how the bot recognises this number afterwards and answers
    // "account closed" instead of starting a fresh signup.
    await c.query(
      `UPDATE users SET subscription_status = 'deleted', display_name = NULL, tax_id = NULL, accountant_name = NULL,
         accountant_phone = NULL, erpnext_api_key = NULL, erpnext_api_secret = NULL, delete_requested_at = NULL, updated_at = $1
       WHERE id = $2`,
      [now, user.id]
    );
  });
  console.log(`[onboarding] ACCOUNT DELETED: id=${user.id} phone=${maskPhone(user.phone)} company=${JSON.stringify(user.erpnext_company || null)} (ERPNext data kept)`);
}

/**
 * Account-level handling for a registered user, before chitchat / media / the LLM. Returns a reply
 * to send (and stop), or null to carry on with the normal flow. Active users only ever pay one
 * column check here unless they typed "delete my account" or have a delete pending.
 */
async function handleRegistered(user, body) {
  const k = keyword(body);
  const status = user.subscription_status;

  if (status === 'deleted') return M.ACCOUNT_CLOSED;

  if (user.delete_requested_at) {
    const fresh = Date.now() - new Date(user.delete_requested_at).getTime() < DELETE_CONFIRM_WINDOW_MS;
    if (fresh && k === 'delete') {
      await closeAccount(user);
      return M.DELETE_DONE;
    }
    await query('UPDATE users SET delete_requested_at = NULL WHERE id = $1', [user.id]);
    user.delete_requested_at = null;
    // Inside the window, any other reply is the "keep it" answer; a stale request just lapses.
    if (fresh && !DELETE_REQUEST.test(k)) return M.DELETE_KEPT;
  }

  if (DELETE_REQUEST.test(k)) {
    const now = new Date().toISOString();
    await query('UPDATE users SET delete_requested_at = $1 WHERE id = $2', [now, user.id]);
    user.delete_requested_at = now;
    console.log(`• [onboarding] [${ts()}] delete requested user_id=${user.id}`);
    return M.DELETE_CONFIRM;
  }

  if (status === 'pending_provisioning') return M.PENDING_PROVISIONING;
  return null;
}

module.exports = {
  handleUnknownPhone, handleRegistered, normalizeContactPhone, maskPhone, mode, matchInvite,
  parseName, DAILY_LIMIT, STEPS, SESSION_TTL_DAYS, NAME_MAX,
  _resetPruneForTests: () => { lastPruneDay = null; },
};
