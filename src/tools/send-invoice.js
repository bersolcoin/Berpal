const { planInvoice, deliver, previewView, previewEntry, previewNotes, previewText, localToday, whatsappReady, NOT_CONFIGURED_ERROR } = require('../outreach/send-invoice');
const gate = require('../outreach/gate');
const { getErp } = require('./context');

const TOOL = 'send_invoice';

const definition = {
  name: TOOL,
  description:
    "Send a Sales Invoice to the customer's WhatsApp: invoice PDF, plus a PromptPay QR for the outstanding amount when the user has set a PromptPay id (THB only). This messages a THIRD PARTY. First call WITHOUT confirmed: it returns a preview and sends nothing. Show the preview to the user; only after they reply yes in a later message call again with the same ref and confirmed:true. If the reply says something changed, show the new preview and ask again.",
  parameters: {
    type: 'object',
    required: ['ref'],
    properties: {
      ref: { type: 'string', description: 'Sales Invoice name, e.g. ACC-SINV-2026-00004.' },
      confirmed: { type: 'boolean', description: "true ONLY after the user said yes to this exact preview in their latest message." },
    },
  },
};

async function execute(args, ctx) {
  const erp = getErp(ctx);
  // Customers are reached over WhatsApp only for now, whatever channel the owner uses.
  const channel = require('../channels').get('whatsapp');
  // Not configured (LINE-only deploy): say so up front instead of previewing an unsendable message.
  if (!whatsappReady(channel)) {
    gate.clearPreview(ctx, TOOL);
    return { ok: false, error: NOT_CONFIGURED_ERROR };
  }
  const today = localToday(ctx.user);
  const plan = await planInvoice(ctx.user, erp, { ref: args.ref, today, channel });
  if (!plan.ok) {
    // Nothing sendable any more (paid, cancelled, phone removed): a stale preview mustn't linger.
    gate.clearPreview(ctx, TOOL);
    return plan;
  }

  const view = previewView([plan.message]);
  const blocked = args.confirmed === true ? gate.verify(ctx, TOOL, view) : 'Preview only — nothing sent. Show the user exactly this and ask for a yes.';
  if (blocked) {
    gate.storePreview(ctx, TOOL, args, view);
    const m = plan.message;
    return {
      ok: false,
      needs_confirmation: true,
      error: blocked,
      preview_text: previewText([m]),
      preview: { ref: m.refs[0], ...previewEntry(m) },
      notes: previewNotes([m]),
    };
  }

  gate.clearPreview(ctx, TOOL);
  return deliver(ctx.user, erp, plan.message, { channel, today });
}

module.exports = { definition, execute };
