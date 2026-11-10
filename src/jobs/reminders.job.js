/**
 * Daily payment reminders to the user's customers: unpaid Sales Invoices that are overdue or due
 * within 3 days (in the user's local calendar). One WhatsApp reminder per customer listing their
 * invoices (up to 3 PDFs + one PromptPay QR for the THB total).
 *
 * Per customer: skipped if reminded in the last 3 local days, and after MAX_ATTEMPTS reminder
 * messages about their current invoices — counting every attempt Twilio accepted, delivered or
 * not, so an unreachable customer isn't retried daily forever.
 *
 * Opt-in only: `enabled(user)` (checked by the scheduler, so a same-day switch-on runs today) and
 * users.reminders_enabled, which set_payment_settings turns on behind a preview + yes. This
 * messages third parties with no per-message approval, so that switch is the consent.
 *
 * Called by src/jobs/scheduler.js at most once per user per day with
 * deps = { erp, now, clock, signal?, whatsapp? } (clock.date = the user's local YYYY-MM-DD).
 *
 * Customer outreach is WhatsApp-only for now, whatever channel the OWNER uses: these go to
 * customers' phone numbers, so deps.channel / deps.twilio (the owner's channel — LINE for a LINE
 * user) are deliberately NOT used. deps.whatsapp (tests) else channels.get('whatsapp').
 * The scheduler aborts deps.signal after timeoutMs: we stop before the next customer and pass the
 * signal to every ERPNext call. The Twilio SDK takes no AbortSignal, so a send already in flight
 * completes (and is logged) — we just don't start another.
 */
const {
  planReminders, deliver, listOpenReceivables, customerRemindedWithin, customerAttempts, localToday,
} = require('../outreach/send-invoice');
const { addDays } = require('./index');
const channels = require('../channels');
const { ts } = require('../erp-sync/common');

const DUE_WITHIN_DAYS = 3;
const DEDUPE_DAYS = 3;
const MAX_ATTEMPTS = 5;
// Customers per user per run, applied AFTER dedupe so already-reminded customers can't crowd out
// ones that are due a reminder. Customers come in order of their oldest due invoice.
const MAX_CUSTOMERS_PER_RUN = 50;
// Up to 50 customers × (PDF renders + uploads + sends) — well past the scheduler's 60s default.
const TIMEOUT_MS = 15 * 60 * 1000;

function enabled(user) {
  return !!Number(user.reminders_enabled);
}

async function run(user, deps = {}) {
  if (!enabled(user)) return { skipped: true, note: 'reminders disabled' };
  const { erp, signal = null } = deps;
  const whatsapp = deps.whatsapp || channels.get('whatsapp');
  // Without WhatsApp nothing can reach a customer: skip before any PDF is rendered or made public.
  if (!whatsapp || (typeof whatsapp.isConfigured === 'function' && !whatsapp.isConfigured())) {
    return { skipped: true, note: 'WhatsApp channel not configured (customer reminders go over WhatsApp only)' };
  }
  const today = deps.clock?.date || localToday(user, deps.now || new Date());

  const rows = await listOpenReceivables(erp, { dueOnOrBefore: addDays(today, DUE_WITHIN_DAYS) });
  const byCustomer = new Map();
  for (const row of rows) {
    if (!byCustomer.has(row.customer)) byCustomer.set(row.customer, []);
    byCustomer.get(row.customer).push(row.name);
  }

  let skipped = 0;
  const capped = [];
  const due = [];
  for (const [customer, refs] of byCustomer) {
    if (await customerRemindedWithin(user, customer, today, DEDUPE_DAYS)) {
      skipped += refs.length;
    } else if ((await customerAttempts(user, customer, refs)) >= MAX_ATTEMPTS) {
      skipped += refs.length;
      capped.push(customer);
    } else {
      due.push(refs);
    }
  }
  const batch = due.slice(0, MAX_CUSTOMERS_PER_RUN);
  for (const refs of due.slice(MAX_CUSTOMERS_PER_RUN)) skipped += refs.length;

  let sent = 0;
  let messages = 0;
  let aborted = false;
  const failures = [];
  for (const refs of batch) {
    // Timed out: stop cleanly. Anything not reached is simply due again tomorrow — not a failure.
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    // One customer at a time: a bad invoice, phone or send never stops the others.
    try {
      const plan = await planReminders(user, erp, { refs, today, channel: whatsapp });
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      failures.push(...plan.problems); // no phone / not ours / paid since listing — retried tomorrow
      for (const msg of plan.messages) {
        const r = await deliver(user, erp, msg, { channel: whatsapp, today, signal });
        if (!r.ok && signal?.aborted) {
          aborted = true; // cut off mid-render/upload — not the customer's failure, retried tomorrow
          break;
        }
        if (r.ok) {
          sent += msg.refs.length;
          messages++;
        } else {
          for (const ref of msg.refs) failures.push({ ref, error: r.error });
        }
      }
      if (aborted) break;
    } catch (err) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      for (const ref of refs) failures.push({ ref, error: err.message });
    }
  }

  const note = `sent ${sent}, skipped ${skipped}, failed ${failures.length}`
    + (capped.length ? `; ${capped.length} customer(s) reached the ${MAX_ATTEMPTS}-reminder cap: ${capped.join(', ')}` : '')
    + (aborted ? '; stopped early (timeout), the rest go tomorrow' : '');
  console.log(`• [outreach] [${ts()}] reminders user_id=${user.id} ${note}`);
  return {
    sent, messages, skipped, failed: failures.length, note,
    ...(aborted ? { aborted: true } : {}),
    ...(failures.length ? { failures } : {}),
    ...(capped.length ? { capped } : {}),
  };
}

module.exports = { name: 'reminders', defaultTime: '09:00', timeoutMs: TIMEOUT_MS, enabled, run };
