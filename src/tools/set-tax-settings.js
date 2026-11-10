const { query } = require('../db');
const { ts } = require('../erp-sync/common');

const definition = {
  name: 'set_tax_settings',
  description:
    "Record the USER's own VAT registration (and optionally their 13-digit tax id). Call when the user says they are / aren't VAT-registered (จดทะเบียนภาษีมูลค่าเพิ่ม / ภ.พ.20), typically after request_confirmation asked. Only the user's own status matters — never a counterparty's.",
  parameters: {
    type: 'object',
    properties: {
      vat_registered: { type: 'boolean', description: 'true if the user (their business) is VAT-registered.' },
      tax_id: { type: 'string', description: "The user's 13-digit Thai tax id, if they gave it." },
    },
    required: ['vat_registered'],
  },
};

async function execute(args, ctx) {
  if (typeof args.vat_registered !== 'boolean') return { ok: false, error: 'vat_registered must be true or false.' };
  let taxId = null;
  if (args.tax_id != null && String(args.tax_id).trim()) {
    taxId = String(args.tax_id).replace(/\D/g, '');
    if (taxId.length !== 13) return { ok: false, error: 'A Thai tax id has 13 digits.' };
  }
  const r = await query(
    `UPDATE users SET vat_registered = $1, tax_id = COALESCE($2, tax_id), updated_at = $3 WHERE id = $4
     RETURNING vat_registered, tax_id`,
    [args.vat_registered ? 1 : 0, taxId, new Date().toISOString(), ctx.user.id]
  );
  // Keep this turn's user row current so the retried request_confirmation sees it.
  Object.assign(ctx.user, r.rows[0]);
  console.log(`• [tools] [${ts()}] tool=set_tax_settings user_id=${ctx.user.id} vat_registered=${r.rows[0].vat_registered}`);
  return { ok: true, vat_registered: !!r.rows[0].vat_registered, tax_id: r.rows[0].tax_id || null };
}

module.exports = { definition, execute };
