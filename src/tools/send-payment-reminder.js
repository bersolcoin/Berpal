const counterparties = require('../counterparties');
const {
  planReminders, deliver, previewView, previewEntry, previewNotes, listOpenReceivables, localToday, daysBetween,
} = require('../outreach/send-invoice');
const gate = require('../outreach/gate');
const { getErp } = require('./context');

const TOOL = 'send_payment_reminder';
// One confirmation shouldn't fan out into a flood of messages; past this, ask the user to narrow it.
const MAX_PER_CALL = 20;
const DUE_SOON_DAYS = 3;

const definition = {
  name: TOOL,
  description:
    "Send payment reminders for unpaid Sales Invoices to the customers' WhatsApp (one reminder per customer listing their invoices, with up to 3 PDFs and a PromptPay QR when set; each attachment is its own WhatsApp message). Pick invoices by ref, by counterparty_id (all their unpaid invoices), and/or scope ('overdue' = past due, 'due_soon' = due within 3 days). This messages THIRD PARTIES. First call WITHOUT confirmed: it returns previews and sends nothing. Show them; only after the user replies yes in a later message call again with the same selection and confirmed:true.",
  parameters: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'One Sales Invoice name, e.g. ACC-SINV-2026-00004.' },
      counterparty_id: { type: 'number', description: 'Contact id from lookup_counterparty: remind about all their unpaid invoices.' },
      scope: { type: 'string', enum: ['overdue', 'due_soon'], description: 'Filter: overdue only, or due within the next 3 days.' },
      confirmed: { type: 'boolean', description: 'true ONLY after the user said yes to these exact previews in their latest message.' },
    },
  },
};

/** Which invoices, judged against the user's local date (not ERPNext/UTC "today"). */
async function selectRefs(user, erp, { ref, counterparty_id, scope }, today) {
  if (ref) return { ok: true, refs: [ref] };
  if (!counterparty_id && !scope) return { ok: false, error: 'Give ref, counterparty_id or scope' };
  let customer = null;
  if (counterparty_id) {
    const contact = await counterparties.getById(user, counterparty_id);
    if (!contact) return { ok: false, error: `counterparty_id ${counterparty_id} not found` };
    if (!contact.erpnext_customer) return { ok: true, refs: [] };
    customer = contact.erpnext_customer;
  }
  let rows = await listOpenReceivables(erp, { customer });
  rows = rows.filter((r) => {
    if (!scope) return true;
    if (!r.due_date) return false;
    const d = daysBetween(today, r.due_date);
    return scope === 'overdue' ? d < 0 : d >= 0 && d <= DUE_SOON_DAYS;
  });
  if (rows.length > MAX_PER_CALL) {
    return { ok: false, error: `${rows.length} invoices match — too many for one go. Narrow it down (counterparty or scope).` };
  }
  return { ok: true, refs: rows.map((r) => r.name) };
}

async function execute(args, ctx) {
  const erp = getErp(ctx);
  const twilio = require('../twilio-client');
  const today = localToday(ctx.user);
  const sel = await selectRefs(ctx.user, erp, args, today);
  if (!sel.ok) return sel;
  if (!sel.refs.length) {
    gate.clearPreview(ctx, TOOL);
    return { ok: true, sent: [], message: 'No unpaid invoices match — nothing to remind.' };
  }

  const { messages, problems } = await planReminders(ctx.user, erp, { refs: sel.refs, today, twilio });
  const cannot = problems.length ? { cannot_send: problems } : {};
  if (!messages.length) {
    gate.clearPreview(ctx, TOOL);
    return { ok: false, error: 'None of these can be sent.', ...cannot };
  }

  const view = previewView(messages);
  const blocked = args.confirmed === true ? gate.verify(ctx, TOOL, view) : 'Preview only — nothing sent. Show the user exactly this and ask for a yes.';
  if (blocked) {
    gate.storePreview(ctx, TOOL, args, view);
    return {
      ok: false,
      needs_confirmation: true,
      error: blocked,
      previews: messages.map(previewEntry),
      notes: previewNotes(messages),
      ...cannot,
    };
  }

  gate.clearPreview(ctx, TOOL);
  const sent = [];
  const failed = [];
  for (const m of messages) {
    try {
      const r = await deliver(ctx.user, erp, m, { twilio, today });
      if (r.ok) sent.push({ refs: m.refs, to: m.customer, phone: m.phone, status: r.status, ...(r.error ? { warning: r.error } : {}) });
      else failed.push({ refs: m.refs, error: r.error });
    } catch (err) {
      failed.push({ refs: m.refs, error: err.message });
    }
  }
  return { ok: failed.length === 0, sent, ...(failed.length ? { failed } : {}), ...cannot };
}

module.exports = { definition, execute };
