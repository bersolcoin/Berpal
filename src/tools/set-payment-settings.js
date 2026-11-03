const { query } = require('../db');
const { parseTarget } = require('../outreach/promptpay');
const { maskPayee } = require('../outreach/send-invoice');
const gate = require('../outreach/gate');
const { parseJobPrefs } = require('../jobs/index');
const { ts } = require('../erp-sync/common');

const TOOL = 'set_payment_settings';
const TYPE_LABEL = { mobile: 'mobile number', tax_id: 'national/tax id', ewallet: 'e-wallet' };

const definition = {
  name: TOOL,
  description:
    "Set the user's own payment/outreach settings: their PromptPay id (Thai mobile number, 13-digit national/tax id, or 15-digit e-wallet id) that goes into the QR on invoices and reminders, and whether automatic daily payment reminders go to customers. Removing the PromptPay id (promptpay_id '') or turning reminders OFF applies at once. Setting/changing the PromptPay id (it decides where customers' money goes) or turning reminders ON is two-step: call without confirmed, show the user the returned preview, and only after they reply yes call again with the same arguments and confirmed:true.",
  parameters: {
    type: 'object',
    properties: {
      promptpay_id: { type: 'string', description: "The user's PromptPay id, or '' to remove." },
      reminders_enabled: { type: 'boolean', description: 'Turn automatic daily reminders to customers on/off.' },
      confirmed: { type: 'boolean', description: 'For setting the PromptPay id or turning reminders ON: true after the user said yes to the preview.' },
    },
  },
};

function reminderTime(user) {
  return parseJobPrefs(user.job_prefs).reminders?.time || '09:00';
}

async function execute(args, ctx) {
  const user = ctx.user;
  if (args.reminders_enabled !== undefined && typeof args.reminders_enabled !== 'boolean') {
    return { ok: false, error: 'reminders_enabled must be true or false.' };
  }
  const sets = [];
  const params = [];
  let promptpayValue;
  let promptpayType = null;
  if (args.promptpay_id !== undefined) {
    promptpayValue = null;
    if (String(args.promptpay_id).trim()) {
      const t = parseTarget(args.promptpay_id);
      if (!t) return { ok: false, error: 'Not a valid PromptPay id — use a Thai mobile number, 13-digit tax id or 15-digit e-wallet id.' };
      // Store the digits the user knows (0812345678), not the 0066… wire format.
      promptpayValue = t.type === 'mobile' ? `0${t.value.slice(4)}` : t.value;
      promptpayType = t.type;
    }
    params.push(promptpayValue);
    sets.push(`promptpay_id = $${params.length}`);
  }
  if (args.reminders_enabled !== undefined) {
    params.push(args.reminders_enabled ? 1 : 0);
    sets.push(`reminders_enabled = $${params.length}`);
  }
  if (!sets.length) return { ok: false, error: 'Nothing to change — give promptpay_id and/or reminders_enabled.' };

  // Outward-facing changes go through the same preview → yes → confirm gate as a send:
  // a new payee redirects customers' money, and enabling reminders messages them on a timer.
  const lines = [];
  const newPayee = promptpayValue && promptpayValue !== user.promptpay_id;
  if (newPayee) {
    lines.push(`QR codes on your invoices and reminders will pay PromptPay ${maskPayee(promptpayValue)} (${TYPE_LABEL[promptpayType]}).`);
  }
  if (args.reminders_enabled === true && !Number(user.reminders_enabled)) {
    lines.push(`This will message your customers automatically at ${reminderTime(user)} for overdue invoices (and ones due within 3 days), at most once every 3 days per customer.`);
  }
  if (lines.length) {
    const view = {
      to: ['your account settings'],
      body: [[...lines, 'Confirm?'].join('\n')],
      attachments: [[]],
      // Full id bound into the hash (the preview text only shows the last 4 digits).
      refs: [`promptpay:${promptpayValue === undefined ? '-' : promptpayValue}`, `reminders:${args.reminders_enabled}`],
    };
    const blocked = args.confirmed === true ? gate.verify(ctx, TOOL, view) : 'Not changed yet. Show the user this and ask for a yes.';
    if (blocked) {
      gate.storePreview(ctx, TOOL, args, view);
      return { ok: false, needs_confirmation: true, error: blocked, preview: view.body[0] };
    }
  }
  gate.clearPreview(ctx, TOOL);

  params.push(new Date().toISOString(), user.id);
  const r = await query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = $${params.length - 1} WHERE id = $${params.length}
     RETURNING promptpay_id, reminders_enabled`,
    params
  );
  const row = r.rows[0];
  // Keep this turn's user row current so later tool calls (e.g. send_invoice) see the new id.
  Object.assign(user, row);
  console.log(`• [outreach] [${ts()}] settings user_id=${user.id} promptpay=${row.promptpay_id ? maskPayee(row.promptpay_id) : 'none'} reminders=${row.reminders_enabled}`);
  return { ok: true, promptpay_id: row.promptpay_id, reminders_enabled: !!row.reminders_enabled };
}

module.exports = { definition, execute };
