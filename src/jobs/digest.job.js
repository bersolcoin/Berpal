/**
 * Morning digest: cash per wallet, what's overdue / due this week, yesterday's in & out.
 * Plain text (WhatsApp renders markdown literally in this bot's style). Empty sections are
 * dropped, and a digest with nothing in it isn't sent at all — no daily "all zero" spam.
 *
 * Delivery goes over the user's own channel (deps.channel, picked from their address):
 *  - channels with templates (WhatsApp): free-form business messages are only allowed within 24h
 *    of the user's last message. Twilio still ACCEPTS free-form text outside it (returns a SID)
 *    and the 63016 failure arrives later, so: with TWILIO_DIGEST_CONTENT_SID set we always send
 *    the approved template; without it we only send free-form when the user wrote to us in the
 *    last 23h, else skip.
 *  - channels without templates (LINE): a plain-text push, any time — no 24h window.
 */
const { query } = require('../db');
const { getCashBankBalance } = require('../erp-query/cash-balance');
const { getOpenInvoices } = require('../erp-query/open-invoices');
const { getTransactionSummary } = require('../erp-query/transaction-summary');
const { companyCurrency, round2 } = require('../erp-sync/common');
const review = require('../trust/review');
const { localClock, addDays } = require('./index');

const MAX_WALLETS = 4;
const MAX_ITEMS = 3; // per invoice section, keeps the whole message around a dozen lines
const SERVICE_WINDOW_MS = 23 * 3600 * 1000; // 1h margin inside WhatsApp's 24h
const TEMPLATE_VAR_MAX = 900; // WhatsApp caps a template body at 1024 chars

const num = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function money(currency, amount) {
  return `${currency} ${num.format(amount)}`;
}
const nonZero = (v) => Math.abs(v) >= 0.005;

function headerDate(isoDate) {
  // Format the local calendar date itself (noon UTC can't roll over to another day).
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(`${isoDate}T12:00:00Z`));
}
function shortDate(isoDate) {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(`${isoDate}T12:00:00Z`));
}

/**
 * "Awaiting accountant review: 3 (oldest 3 Nov)", or null. A reminder, not news: it only rides
 * along on a digest that has something else to say (buildDigest). A Postgres hiccup must not
 * cost the digest, so a failure here is just no line.
 */
async function reviewLine(user, now) {
  try {
    const { count, oldest } = await review.pendingSummary(user.id, { now });
    if (!count) return null;
    return `Awaiting accountant review: ${count}${oldest ? ` (oldest ${shortDate(oldest)})` : ''}`;
  } catch (err) {
    console.error(`[digest] review summary failed (user ${user.id}):`, err.message);
    return null;
  }
}

/** "DBS USD 5.00", not "DBS USD USD 5.00", when the name already says the currency. */
function walletAmount(name, currency, amount) {
  const last = String(name).trim().split(/\s+/).pop();
  return last.toUpperCase() === String(currency).toUpperCase()
    ? `${name} ${num.format(amount)}`
    : `${name} ${money(currency, amount)}`;
}

/** Cash/bank wallets (with totals) and, separately, what's owed on credit cards. */
function cashSection(cash) {
  const lines = [];
  const accounts = cash.accounts || [];
  const pots = accounts.filter((a) => a.type !== 'Credit Card' && nonZero(a.balance));
  if (pots.length) {
    const totals = {};
    for (const a of pots) totals[a.currency] = round2((totals[a.currency] || 0) + a.balance);
    const listed = pots.slice(0, MAX_WALLETS);
    const shownCurrencies = new Set(listed.map((a) => a.currency));
    // A currency whose wallets net to zero still gets "THB 0.00" when its wallets are listed
    // below, so the totals line always matches the list.
    const totalLine = Object.entries(totals)
      .filter(([cur, v]) => nonZero(v) || shownCurrencies.has(cur))
      .map(([cur, v]) => money(cur, v));
    const shown = listed.map((a) => walletAmount(a.name, a.currency, a.balance));
    if (pots.length > MAX_WALLETS) shown.push(`+${pots.length - MAX_WALLETS} more`);
    lines.push(`Cash: ${totalLine.join(' · ')}`, `  ${shown.join(' · ')}`);
  }
  // A card's ledger balance is negative when money is owed on it.
  const cards = accounts.filter((a) => a.type === 'Credit Card' && a.balance <= -0.005);
  if (cards.length) {
    lines.push(`Owed on cards: ${cards.slice(0, MAX_WALLETS).map((a) => walletAmount(a.name, a.currency, -a.balance)).join(' · ')}`);
  }
  return lines;
}

function invoiceLine(r, tail) {
  return r.kind === 'receivable'
    ? `- ${r.counterparty} owes you ${money(r.currency, r.outstanding)} (${tail})`
    : `- You owe ${r.counterparty} ${money(r.currency, r.outstanding)} (${tail})`;
}

/** `count` is the full count (from total_count), `rows` only what we got back to show. */
function invoiceSection(title, count, rows, tailFor) {
  if (!count) return [];
  const shown = rows.slice(0, MAX_ITEMS);
  const lines = [`${title} (${count}):`, ...shown.map((r) => invoiceLine(r, tailFor(r)))];
  const more = count - shown.length;
  if (more > 0) lines.push(shown.length ? `- …and ${more} more` : `- ${more} items, ask me for the list`);
  return lines;
}

/** Build the digest text, or null when there's nothing worth sending. Exported for tests. */
async function buildDigest(user, erp, { now = new Date(), clock = null } = {}) {
  // clock.date is the user's REAL local date, even when the run belongs to the previous day
  // (window crossing midnight, clock.run_date): due/overdue and "yesterday" are about now.
  const { date } = clock || localClock(now, user.timezone);
  const yesterday = addDays(date, -1);
  const base = companyCurrency(user);

  const cash = await getCashBankBalance(user, erp);
  // Two reads so both counts are exact: due within 7 days (overdue included) and overdue only
  // (due on/before yesterday). Days are counted from the user's local date, not UTC.
  const soon = await getOpenInvoices(user, erp, { direction: 'both', due_within_days: 7, sort: 'due_date_asc', limit: 50, today: date });
  const late = await getOpenInvoices(user, erp, { direction: 'both', due_within_days: -1, sort: 'due_date_asc', limit: MAX_ITEMS, today: date });
  const income = await getTransactionSummary(user, erp, { direction: 'income', date_from: yesterday, date_to: yesterday });
  const expense = await getTransactionSummary(user, erp, { direction: 'expense', date_from: yesterday, date_to: yesterday });

  const overdueCount = late.ok ? late.total_count : 0;
  const upcomingCount = soon.ok ? Math.max(0, soon.total_count - overdueCount) : 0;
  const upcomingRows = soon.ok ? soon.rows.filter((r) => !(r.overdue_days > 0)) : [];

  const sections = [
    cashSection(cash),
    invoiceSection('Overdue', overdueCount, late.ok ? late.rows : [], (r) => `${r.overdue_days}d late`),
    invoiceSection('Due next 7 days', upcomingCount, upcomingRows, (r) => (r.days_until_due === 0 ? 'today' : `in ${r.days_until_due}d`)),
  ];
  const inc = income.ok ? income.total || 0 : 0;
  const exp = expense.ok ? expense.total || 0 : 0;
  if (nonZero(inc) || nonZero(exp)) {
    sections.push([`Yesterday: in ${money(base, inc)} · out ${money(base, exp)}`]);
  }

  const body = sections.filter((s) => s.length);
  if (body.length === 0) return null;
  // Trailing, and only once there is a digest to append it to: the queue alone is no reason to send.
  const pending = await reviewLine(user, now);
  return [`Your books, ${headerDate(date)}:`, ...body.flat(), ...(pending ? [pending] : [])].join('\n');
}

/**
 * Template variables: {1: date, 2: body}. WhatsApp rejects newlines, tabs and 4+ spaces in
 * template variables, so the body is flattened onto one line.
 */
function templateVariables(text, date) {
  const flat = (s) => String(s).replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  const lines = text.split(/\r?\n/).slice(1).map(flat).filter(Boolean);
  let body = lines.join(' | ');
  if (body.length > TEMPLATE_VAR_MAX) body = `${body.slice(0, TEMPLATE_VAR_MAX - 1)}…`;
  return { 1: flat(headerDate(date)), 2: body };
}

/** Did the user message us recently enough that free-form text will be delivered? */
async function inServiceWindow(userId, now) {
  const r = await query('SELECT last_message_at FROM conversations WHERE user_id = $1', [userId]);
  const last = r.rows[0] && r.rows[0].last_message_at;
  return !!last && now.getTime() - new Date(last).getTime() < SERVICE_WINDOW_MS;
}

function isEnabled(user) {
  // Only an explicit 0 turns it off; a row predating the column counts as on.
  return !(user.digest_enabled != null && !Number(user.digest_enabled));
}

module.exports = {
  name: 'digest',
  defaultTime: '08:00',
  window: 120,
  enabled: isEnabled,
  buildDigest,
  templateVariables,
  async run(user, { erp, channel = null, twilio = null, now = new Date(), clock = null }) {
    const ch = channel || twilio; // `twilio` is the legacy dep name for the same channel
    if (!isEnabled(user)) return { skipped: true, note: 'digest disabled' };
    const c = clock || localClock(now, user.timezone);
    const text = await buildDigest(user, erp, { now, clock: c });
    if (!text) return { skipped: true, note: 'nothing to report' };

    // The user's address; the channel formats it for its provider.
    const to = user.phone;
    // A stub without the flag is a WhatsApp-like channel (the old Twilio client shape).
    const templates = ch.supportsTemplates !== false;
    const contentSid = process.env.TWILIO_DIGEST_CONTENT_SID;
    let sid;
    let via;
    if (templates && contentSid) {
      via = 'template';
      sid = await ch.sendTemplate(to, contentSid, templateVariables(text, c.date));
    } else if (templates) {
      if (!(await inServiceWindow(user.id, now))) {
        return { skipped: true, note: 'outside 24h window; set TWILIO_DIGEST_CONTENT_SID' };
      }
      via = 'text';
      sid = await ch.sendText(to, text);
    } else {
      via = 'push';
      sid = await ch.sendText(to, text);
    }
    // sendTemplate throws with Twilio's code; sendText swallows errors and returns null.
    if (!sid) throw new Error(`${ch.name || 'channel'} ${via} send returned no message sid`);
    return { sent: 1, via, message_sid: sid };
  },
};
