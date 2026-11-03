/**
 * Customer outreach: send a Sales Invoice (PDF + optional PromptPay QR) or payment reminders to
 * the customer's WhatsApp.
 *
 * Two phases, so what the user approves is exactly what goes out:
 *   plan*()   — read-only: load + validate invoices, resolve the phone, compose the exact text
 *               and attachment list. Used for the preview AND recomputed at confirm time
 *               (src/outreach/gate.js hashes it).
 *   deliver() — side effects: render PDFs, upload them (and the QR) as public ERPNext Files,
 *               send via Twilio, log to outreach_log.
 *
 * Twilio can only attach media it can download from a public URL, and server.js isn't ours to
 * extend, so attachments are public ERPNext Files with a random suffix (the URL is the only
 * secret). src/jobs/reminders.job.js deletes them after FILE_TTL_DAYS.
 */
const crypto = require('crypto');
const { query } = require('../db');
const { ts, round2 } = require('../erp-sync/common');
const { localClock, addDays } = require('../jobs/index');
const promptpay = require('./promptpay');
const { normalizePhone } = require('./phone');

const FETCH_CAP = 500;
const FREEFORM_NOTE =
  "Goes out as a normal WhatsApp message: if the customer hasn't messaged this WhatsApp number in the last 24 hours, WhatsApp may silently refuse to deliver it.";
const PDF_NOTE = 'The invoice PDF shows the line-item descriptions as entered.';
const ONE_MEDIA_NOTE = 'WhatsApp allows one attachment per message, so each attachment arrives as its own WhatsApp message (see whatsapp_messages).';
const MAX_PDFS_PER_MESSAGE = 3;

/** The user's local calendar date (users.timezone, default Asia/Bangkok). */
function localToday(user, now = new Date()) {
  return localClock(now, user.timezone).date;
}

function daysBetween(fromIso, toIso) {
  return Math.round((new Date(`${toIso}T00:00:00Z`) - new Date(`${fromIso}T00:00:00Z`)) / 86400000);
}

function money(currency, n) {
  return `${currency} ${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * outstanding_amount is in the PARTY ACCOUNT currency (the debtors account), which can differ
 * from the invoice's transaction currency — label amounts with that one.
 */
function amountCurrency(inv) {
  return inv.party_account_currency || inv.currency;
}

function dueLabel(dueDate, today) {
  if (!dueDate) return 'no due date';
  const days = daysBetween(today, dueDate);
  if (days < 0) return `${-days} day${days === -1 ? '' : 's'} overdue (due ${dueDate})`;
  if (days === 0) return `due today (${dueDate})`;
  return `due in ${days} day${days === 1 ? '' : 's'} (${dueDate})`;
}

/** Open receivables for this company straight from ERPNext (no 50-row cap: the job dedupes first). */
async function listOpenReceivables(erp, { dueOnOrBefore = null, customer = null } = {}) {
  const filters = [
    ['company', '=', erp.company],
    ['docstatus', '=', 1],
    ['outstanding_amount', '>', 0],
  ];
  if (dueOnOrBefore) filters.push(['due_date', '<=', dueOnOrBefore]);
  if (customer) filters.push(['customer', '=', customer]);
  const r = await erp.listResource('Sales Invoice', {
    filters, fields: ['name', 'customer', 'due_date', 'outstanding_amount'], limit: FETCH_CAP, orderBy: 'due_date asc',
  });
  return r.data || [];
}

/** Load one invoice and check it's ours to chase. Throws a user-readable Error otherwise. */
async function loadInvoice(erp, ref, kind) {
  if (!ref) throw new Error('ref (Sales Invoice name) is required');
  let inv;
  try {
    inv = (await erp.getResource('Sales Invoice', ref)).data;
  } catch (err) {
    if (err.status === 404) throw new Error(`Sales Invoice ${ref} not found`);
    throw err;
  }
  // Shared ERPNext instance: another tenant's invoice must look exactly like a missing one.
  if (!inv || inv.company !== erp.company) throw new Error(`Sales Invoice ${ref} not found`);
  if (inv.docstatus !== 1) throw new Error(`${ref} is ${inv.docstatus === 2 ? 'cancelled' : 'not submitted'}; only submitted invoices can be sent`);
  if (inv.is_return) throw new Error(`${ref} is a credit note (return), not something the customer owes`);
  if (!(Number(inv.outstanding_amount) > 0)) {
    throw new Error(`${ref} is already paid — nothing to ${kind === 'invoice' ? 'send a payment request for' : 'remind about'}`);
  }
  return inv;
}

/**
 * The customer's WhatsApp, from THIS user's contact cache only. ERPNext Customer.mobile_no is
 * deliberately not used: Customers are shared across Companies on the instance, so a name
 * collision there would hand us another tenant's customer's phone.
 */
async function resolveCustomerPhone(user, inv) {
  const r = await query(
    `SELECT phone FROM counterparty_cache
     WHERE owner_user_id = $1 AND erpnext_customer = $2 AND phone IS NOT NULL
     ORDER BY id LIMIT 1`,
    [user.id, inv.customer]
  );
  const name = inv.customer_name || inv.customer;
  const raw = r.rows[0]?.phone;
  if (!raw) {
    return { ok: false, error: `No WhatsApp number on file for ${name} — ask the user for it and save it with create_contact.` };
  }
  const p = normalizePhone(raw, user.country || null);
  if (!p.ok) return { ok: false, error: `${p.error} (contact ${name}) — ask the user for the correct number and save it with create_contact.` };
  return p;
}

/** Template mode (approved WhatsApp template, works outside the 24h window) when configured. */
function templateSid(kind, twilio) {
  const sid = kind === 'invoice' ? process.env.TWILIO_INVOICE_CONTENT_SID : process.env.TWILIO_REMINDER_CONTENT_SID;
  return sid && twilio && typeof twilio.sendTemplate === 'function' ? sid : null;
}

/** "••••5678" — enough for the user to recognise their own account, no more. */
function maskPayee(id) {
  return `••••${String(id || '').replace(/[^0-9]/g, '').slice(-4)}`;
}

/**
 * What the user sees for a template send: the approved wording with our values substituted
 * (TWILIO_*_TEMPLATE_TEXT, "\n" allowed), or a plain statement that the approved text is used.
 */
function templatePreview(kind, contentSid, vars) {
  const text = kind === 'invoice' ? process.env.TWILIO_INVOICE_TEMPLATE_TEXT : process.env.TWILIO_REMINDER_TEMPLATE_TEXT;
  const shown = { ...vars, ...(kind === 'invoice' ? { 4: '<link to the invoice PDF>' } : {}) };
  if (text) return text.replace(/\\n/g, '\n').replace(/\{\{(\d+)\}\}/g, (m, n) => (shown[n] != null ? String(shown[n]) : m));
  const parts = Object.entries(shown).map(([n, v]) => `{{${n}}}=${v}`).join('; ');
  return `[The approved WhatsApp template ${contentSid} will be used, with ${parts}]`;
}

/**
 * Build one message (one customer, 1+ invoices). Pure apart from what's already loaded.
 *
 * WhatsApp carries one attachment per message, so every PDF is a separate WhatsApp message;
 * past MAX_PDFS_PER_MESSAGE invoices we list the refs in the text and attach only the QR.
 * Template mode: invoices send one template with {{4}} = that invoice's PDF URL; reminders send
 * one statement template (no PDFs, {{1}} customer {{2}} total {{3}} statement). The QR follows
 * as a free-form media message either way.
 */
function composeMessage(user, invoices, { kind, today, to, twilio }) {
  const first = invoices[0];
  const customer = first.customer_name || first.customer;
  const from = first.company || user.display_name || '';
  const totals = {};
  for (const inv of invoices) {
    const cur = amountCurrency(inv);
    totals[cur] = round2((totals[cur] || 0) + Number(inv.outstanding_amount));
  }
  const totalText = Object.entries(totals).map(([c, v]) => money(c, v)).join(' + ');
  // PromptPay only settles THB; one QR for the THB total.
  const qrAmount = user.promptpay_id && totals.THB > 0 ? totals.THB : null;
  const qrLabel = qrAmount ? `PromptPay QR for ${money('THB', qrAmount)} → payee ${maskPayee(user.promptpay_id)}` : null;

  const lines = [];
  if (kind === 'invoice') {
    lines.push(`Invoice ${first.name} from ${from}`, `Amount due: ${totalText}`);
    if (first.due_date) lines.push(`Due: ${first.due_date}`);
  } else {
    lines.push(`Payment reminder from ${from}`);
    for (const inv of invoices) {
      lines.push(`Invoice ${inv.name}: ${money(amountCurrency(inv), inv.outstanding_amount)} — ${dueLabel(inv.due_date, today)}`);
    }
    if (invoices.length > 1) lines.push(`Total outstanding: ${totalText}`);
  }
  if (qrAmount) lines.push(`Scan the QR to pay ${money('THB', qrAmount)} by PromptPay.`);

  const contentSid = templateSid(kind, twilio);
  let body;
  let template = null;
  let pdfRefs;
  if (contentSid) {
    // WhatsApp rejects newlines/tabs inside template variables.
    if (kind === 'invoice') {
      template = { contentSid, variables: { 1: customer, 2: totalText, 3: first.due_date || '-' } };
      pdfRefs = [first.name];
    } else {
      const statement = invoices.map((i) => `${i.name} ${money(amountCurrency(i), i.outstanding_amount)} ${dueLabel(i.due_date, today)}`).join('; ');
      template = { contentSid, variables: { 1: customer, 2: totalText, 3: statement } };
      pdfRefs = [];
    }
    body = templatePreview(kind, contentSid, template.variables);
  } else {
    body = lines.join('\n');
    pdfRefs = invoices.length <= MAX_PDFS_PER_MESSAGE ? invoices.map((i) => i.name) : [];
  }

  const attachments = pdfRefs.map((r) => (template ? `invoice PDF ${r} (as a link)` : `invoice PDF ${r}`));
  if (qrLabel) attachments.push(qrLabel);
  const messageCount = template ? 1 + (qrAmount ? 1 : 0) : Math.max(1, pdfRefs.length + (qrAmount ? 1 : 0));

  return {
    kind, customer, customerId: first.customer, to: to.address, phone: to.e164, refs: invoices.map((i) => i.name),
    body, attachments, pdfRefs, qrAmount, payee: qrAmount ? user.promptpay_id : null, template, messageCount, invoices,
  };
}

/**
 * Plan for send_invoice: one invoice, one message.
 *   returns { ok: true, message } | { ok: false, error }
 */
async function planInvoice(user, erp, { ref, today = localToday(user), twilio = null }) {
  let inv;
  try {
    inv = await loadInvoice(erp, ref, 'invoice');
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const to = await resolveCustomerPhone(user, inv);
  if (!to.ok) return { ok: false, error: to.error, customer: inv.customer_name || inv.customer };
  return { ok: true, message: composeMessage(user, [inv], { kind: 'invoice', today, to, twilio }) };
}

/**
 * Plan reminders for a set of refs, grouped into one message per customer.
 * Problems never abort the rest: each bad ref lands in `problems`.
 *   returns { messages, problems: [{ ref, error }] }
 */
async function planReminders(user, erp, { refs, today = localToday(user), twilio = null }) {
  const byCustomer = new Map();
  const problems = [];
  for (const ref of refs) {
    try {
      const inv = await loadInvoice(erp, ref, 'reminder');
      if (!byCustomer.has(inv.customer)) byCustomer.set(inv.customer, []);
      byCustomer.get(inv.customer).push(inv);
    } catch (err) {
      problems.push({ ref, error: err.message });
    }
  }
  const messages = [];
  for (const invoices of byCustomer.values()) {
    const to = await resolveCustomerPhone(user, invoices[0]);
    if (!to.ok) {
      for (const inv of invoices) problems.push({ ref: inv.name, error: to.error });
      continue;
    }
    messages.push(composeMessage(user, invoices, { kind: 'reminder', today, to, twilio }));
  }
  return { messages, problems };
}

/** What the user sees, and what the gate hashes. */
function previewView(messages) {
  return {
    to: messages.map((m) => `${m.customer} (${m.phone})`),
    body: messages.map((m) => m.body),
    attachments: messages.map((m) => m.attachments),
    refs: messages.flatMap((m) => m.refs),
    payees: messages.map((m) => m.payee),
  };
}

/** One preview entry per outgoing message, as the tools return it. */
function previewEntry(m) {
  return {
    refs: m.refs, to: m.customer, phone: m.phone, message: m.body, attachments: m.attachments,
    whatsapp_messages: m.messageCount,
  };
}

function previewNotes(messages) {
  const notes = [PDF_NOTE, ONE_MEDIA_NOTE];
  if (messages.some((m) => !m.template)) notes.push(FREEFORM_NOTE);
  if (messages.some((m) => m.invoices.length > MAX_PDFS_PER_MESSAGE && !m.template)) {
    notes.push(`More than ${MAX_PDFS_PER_MESSAGE} invoices for one customer: the refs are listed in the text and no PDFs are attached.`);
  }
  return notes;
}

function publicUrl(erp, fileUrl) {
  if (!fileUrl) throw new Error('ERPNext upload returned no file_url');
  return /^https?:\/\//.test(fileUrl) ? fileUrl : `${erp.baseUrl}${fileUrl}`;
}

function errorText(errors) {
  return errors.map((e) => `${e.code != null ? `${e.code}: ` : ''}${e.message}`).join('; ') || null;
}

async function logOutreach(user, msg, { status, error, files, sid, today }) {
  const now = new Date().toISOString();
  // One row per invoice (so "what did invoice X get?" is one lookup); customer + message_sid
  // let dedupe and the cap work per customer / per message.
  for (const ref of msg.refs) {
    await query(
      `INSERT INTO outreach_log (user_id, counterparty_phone, customer, kind, reference, sent_at, sent_local_date, status, error, files, message_sid)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [user.id, msg.phone, msg.customerId, msg.kind, ref, now, today, status, error, files.length ? JSON.stringify(files) : null, sid]
    );
  }
}

/**
 * Render + upload attachments, send, log. Never throws for send problems.
 *   returns { ok, status: 'sent'|'partial'|'failed', refs, sent_to, phone, message_sids, error? }
 */
async function deliver(user, erp, msg, { twilio, today = localToday(user), signal = null }) {
  const files = [];
  let sids = [];
  let errors = [];
  try {
    // Re-check the number before anything is uploaded: a bad one would only bounce at Twilio
    // after the PDFs/QR were already public.
    const check = normalizePhone(msg.phone, null);
    if (!check.ok || check.address !== msg.to) throw new Error(check.error || `phone mismatch for ${msg.customer}`);
    const tag = crypto.randomBytes(8).toString('hex');
    const pdfUrls = [];
    for (const ref of msg.pdfRefs) {
      const pdf = await erp.getPdf('Sales Invoice', ref, { format: process.env.ERPNEXT_INVOICE_PRINT_FORMAT || undefined, signal });
      const up = await erp.uploadFile({
        buffer: pdf, filename: `${ref}-${tag}.pdf`, contentType: 'application/pdf',
        isPrivate: false, doctype: 'Sales Invoice', docname: ref, signal,
      });
      files.push(up.name);
      pdfUrls.push(publicUrl(erp, up.file_url));
    }
    let qrUrl = null;
    if (msg.qrAmount) {
      const png = await promptpay.renderPng(promptpay.buildPayload(user.promptpay_id, { amount: msg.qrAmount }));
      const up = await erp.uploadFile({
        buffer: png, filename: `${msg.refs[0]}-promptpay-${tag}.png`, contentType: 'image/png',
        isPrivate: false, doctype: 'Sales Invoice', docname: msg.refs[0], signal,
      });
      files.push(up.name);
      qrUrl = publicUrl(erp, up.file_url);
    }

    if (msg.template) {
      // {{4}} is exactly one URL (invoice template only).
      const vars = { ...msg.template.variables, ...(pdfUrls.length ? { 4: pdfUrls[0] } : {}) };
      const sid = await twilio.sendTemplate(msg.to, msg.template.contentSid, vars);
      if (sid) {
        sids.push(sid);
        if (qrUrl) {
          const r = await twilio.sendMedia(msg.to, null, [qrUrl]);
          sids.push(...r.sids);
          errors.push(...r.errors);
        }
      } else {
        errors.push({ index: 0, code: null, message: 'template send failed (see [twilio] log)' });
      }
    } else {
      const r = await twilio.sendMedia(msg.to, msg.body, [...pdfUrls, qrUrl].filter(Boolean));
      sids = r.sids;
      errors = r.errors;
    }
  } catch (err) {
    errors.push({ index: null, code: null, message: err.message });
  }

  const status = sids.length === 0 ? 'failed' : errors.length ? 'partial' : 'sent';
  const error = errorText(errors);
  await logOutreach(user, msg, { status, error, files, sid: sids[0] || null, today });
  const line = `• [outreach] [${ts()}] ${msg.kind} ${msg.refs.join(',')} → ${msg.to} ${status}`;
  if (status === 'sent') console.log(line);
  else console.error(`${line}: ${error}`);
  return {
    ok: status !== 'failed', status, refs: msg.refs, sent_to: msg.customer, phone: msg.phone,
    message_sids: sids, ...(error ? { error: status === 'failed' ? `Couldn't send ${msg.refs.join(', ')}: ${error}` : error } : {}),
  };
}

/**
 * Reminder bookkeeping, per CUSTOMER. An "attempt" is a reminder Twilio saw: it has a message_sid
 * (whatever its later status — an undelivered 63016 still counts), or Twilio rejected it outright
 * with an error code ("21211: …", no SID). Counting both means an unreachable customer is never
 * retried daily forever. Failures before Twilio (PDF render, upload) aren't attempts: retried tomorrow.
 *
 * "At most one every 3 days" in the user's calendar: a reminder on day D blocks D, D+1, D+2;
 * the next may go on D+3.
 */
const TWILIO_CODE_RE = /^\d{5}:/;
function isAttempt(row) {
  return !!row.message_sid || TWILIO_CODE_RE.test(row.error || '');
}

/** Attempt rows for this customer (filtered in JS: regex support differs across Postgres stand-ins). */
async function reminderAttemptRows(user, customer) {
  const r = await query(
    `SELECT reference, message_sid, error, sent_at, sent_local_date FROM outreach_log
     WHERE user_id = $1 AND customer = $2 AND kind = 'reminder'`,
    [user.id, customer]
  );
  return r.rows.filter(isAttempt);
}

async function customerRemindedWithin(user, customer, today, days) {
  const since = addDays(today, -days);
  return (await reminderAttemptRows(user, customer)).some((x) => x.sent_local_date > since);
}

/** Reminder messages already attempted to this customer about any of `refs` (their current debts). */
async function customerAttempts(user, customer, refs) {
  const wanted = new Set(refs);
  // One message logs a row per invoice: same SID, or (rejected, no SID) the same sent_at.
  const keys = (await reminderAttemptRows(user, customer))
    .filter((x) => wanted.has(x.reference))
    .map((x) => x.message_sid || `rejected:${x.sent_at}`);
  return new Set(keys).size;
}

module.exports = {
  planInvoice, planReminders, deliver, previewView, previewEntry, previewNotes, listOpenReceivables,
  customerRemindedWithin, customerAttempts, localToday, dueLabel, daysBetween, maskPayee,
  MAX_PDFS_PER_MESSAGE,
};
