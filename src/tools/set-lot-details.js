const store = require('../lots/store');
const lots = require('../lots');
const { figure, plain, CT_UNIT } = require('../lots/draft');
const { ts } = require('../erp-sync/common');

// What may be edited without a confirmation card: words and asking prices, nothing that changes
// carats, pieces, cost, form or place (those move only through an operation) and nothing that has
// tax or accounting weight: the treatment (a treatment operation), who says so, the VAT-exempt
// flag and the supplier document (the accountant's). store.setDetails drops anything else; here
// the model is told so instead.
const TEXT = ['species', 'variety', 'shape', 'size', 'colour', 'clarity', 'origin', 'grade', 'description'];
const PRICES = ['ask_per_ct', 'bottom_per_ct'];
const DETAILS = [...TEXT, ...PRICES, 'price_currency'];
const NOT_HERE = {
  treatment: 'The treatment of a lot changes only through an operation (update_stock_op, e.g. a transform with job heating, then request_confirmation), so that it is on a card and in the lot\'s history.',
  treatment_source: 'Who says what the treatment is stays as it was bought or as the operation recorded it.',
  vat_exempt: 'The VAT-exempt flag is a tax matter for the accountant; tell the trader to ask them.',
  supplier_doc: 'The supplier document is a tax matter for the accountant; tell the trader to ask them.',
};
const CERTIFICATE = ['lab', 'report_no', 'report_date', 'stated_carats', 'url'];
const MAX_TEXT = 200;
const MAX_DESCRIPTION = 500;

const definition = {
  name: 'set_lot_details',
  description:
    'Gem lots: correct or add the DESCRIPTION of a lot (species, variety, shape, size, colour, clarity, origin, grade, description), its asking and bottom price per carat, or attach a lab certificate. Saved at once, no confirmation card. It cannot change the code, weight, pieces, cost, form, place or treatment of a lot: those change only through an operation (update_stock_op → request_confirmation). Only pass what the trader said; null clears a field.',
  parameters: {
    type: 'object',
    properties: {
      lot: { type: 'string', description: 'Lot code, e.g. "L15".' },
      species: { type: 'string' },
      variety: { type: 'string' },
      shape: { type: 'string' },
      size: { type: 'string' },
      colour: { type: 'string' },
      clarity: { type: 'string' },
      origin: { type: 'string' },
      grade: { type: 'string' },
      description: { type: 'string' },
      ask_per_ct: { type: 'number', description: 'Asking price per carat.' },
      bottom_per_ct: { type: 'number', description: 'Lowest price per carat the trader would take.' },
      price_currency: { type: 'string', description: 'ISO currency of the two prices, e.g. THB, USD.' },
      certificate: {
        type: 'object',
        description: 'A lab report to attach to the lot.',
        properties: {
          lab: { type: 'string', description: 'e.g. GIT, GRS, AIGS, Lotus.' },
          report_no: { type: 'string' },
          report_date: { type: 'string', description: 'YYYY-MM-DD' },
          stated_carats: { type: 'number', description: 'The weight the report states.' },
          url: { type: 'string' },
        },
        required: ['lab'],
      },
    },
    required: ['lot'],
  },
};

const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
const fail = (error) => ({ ok: false, error });

/** The whitelisted fields of the call, cleaned; or the problem with one of them. */
function cleanFields(args) {
  const fields = {};
  for (const k of DETAILS) {
    if (!(k in args)) continue;
    const v = args[k];
    if (blank(v)) { fields[k] = null; continue; }
    if (TEXT.includes(k)) {
      const text = plain(v);
      if (text === null) return { error: `${k} must be a word or a few words.` };
      const max = k === 'description' ? MAX_DESCRIPTION : MAX_TEXT;
      if (text.length > max) return { error: `${k} is ${text.length} characters; at most ${max}. Shorten it.` };
      fields[k] = text;
    } else if (PRICES.includes(k)) {
      const n = figure(v);
      if (!(n > 0)) return { error: `${k} ${typeof v === 'object' ? JSON.stringify(v) : v} must be a price per carat more than 0 (null clears it).` };
      fields[k] = n;
    } else if (k === 'price_currency') {
      const c = typeof v === 'string' ? v.trim().toUpperCase() : '';
      if (!/^[A-Z]{3}$/.test(c)) return { error: `price_currency "${v}" must be a 3-letter currency code, e.g. THB.` };
      fields[k] = c;
    }
  }
  return { fields };
}

function cleanCertificate(cert) {
  if (!cert || typeof cert !== 'object' || Array.isArray(cert)) return { error: 'certificate must be { lab, report_no?, report_date?, stated_carats?, url? }.' };
  const extra = Object.keys(cert).filter((k) => !CERTIFICATE.includes(k));
  if (extra.length) return { error: `certificate takes only ${CERTIFICATE.join(', ')}; remove ${extra.join(', ')}.` };
  if (blank(cert.lab)) return { error: 'A certificate needs the lab that issued it. Ask the trader.' };
  if (!blank(cert.report_date) && !/^\d{4}-\d{2}-\d{2}$/.test(String(cert.report_date).trim())) return { error: `certificate.report_date "${cert.report_date}" must be YYYY-MM-DD.` };
  const carats = blank(cert.stated_carats) ? null : figure(cert.stated_carats, CT_UNIT);
  if (!blank(cert.stated_carats) && !(carats > 0)) return { error: `certificate.stated_carats ${typeof cert.stated_carats === 'object' ? JSON.stringify(cert.stated_carats) : cert.stated_carats} must be more than 0.` };
  const text = {};
  for (const k of ['lab', 'report_no', 'report_date', 'url']) {
    const v = blank(cert[k]) ? null : plain(cert[k]);
    if (v === null && !blank(cert[k])) return { error: `certificate.${k} must be text.` };
    text[k] = v;
  }
  return { certificate: { ...text, stated_carats: carats == null ? null : lots.round3(carats) } };
}

async function execute(args, ctx) {
  const { user } = ctx;
  const code = lots.normCode(plain(args.lot));
  if (!code) return fail('Which lot? Pass its code in lot (query_lots lists the lots).');

  // Anything outside the list is refused, never dropped in silence: the model would otherwise
  // tell the trader a weight or a cost was changed when it was not.
  const notHere = Object.keys(args).filter((k) => NOT_HERE[k]);
  if (notHere.length) return fail(`${notHere.map((k) => NOT_HERE[k]).join(' ')} Nothing was changed.`);
  const extra = Object.keys(args).filter((k) => k !== 'lot' && k !== 'certificate' && !DETAILS.includes(k));
  if (extra.length) {
    return fail(`${extra.join(', ')} cannot be changed here. The code, weight, pieces, cost, form and place of a lot change only through an operation `
      + '(update_stock_op, e.g. a re-weigh, then request_confirmation). Nothing was changed.');
  }
  const cleaned = cleanFields(args);
  if (cleaned.error) return fail(`${cleaned.error} Nothing was changed.`);
  const cert = args.certificate == null ? null : cleanCertificate(args.certificate);
  if (cert && cert.error) return fail(`${cert.error} Nothing was changed.`);
  if (!Object.keys(cleaned.fields).length && !cert) return fail('Nothing to change: pass the fields the trader wants corrected, or a certificate.');

  const before = await store.getLot(user.id, code);
  if (!before) return fail(`There is no lot ${code} (query_lots lists the lots). Nothing was changed.`);

  const same = (a, b) => (a == null && b == null) || String(a) === String(b);
  const changed = {};
  for (const [k, v] of Object.entries(cleaned.fields)) {
    if (!same(before[k], v)) changed[k] = { from: before[k] == null ? null : before[k], to: v };
  }
  let added = null;
  if (cert) {
    const known = cert.certificate.report_no
      && (await store.listCertificates(before.id)).find((c) => String(c.lab).toLowerCase() === cert.certificate.lab.toLowerCase()
        && String(c.report_no || '').toLowerCase() === cert.certificate.report_no.toLowerCase());
    if (known) return fail(`Lot ${code} already has the ${known.lab} report ${known.report_no}. It was not added twice. Nothing was changed.`);
  }
  if (Object.keys(changed).length) {
    await store.setDetails(user.id, code, Object.fromEntries(Object.keys(changed).map((k) => [k, changed[k].to])));
  }
  if (cert) {
    const row = await store.addCertificate(user.id, code, cert.certificate);
    added = { lab: row.lab, report_no: row.report_no || null, report_date: row.report_date || null, stated_carats: row.stated_carats };
  }
  console.log(`• [tools] [${ts()}] tool=set_lot_details user_id=${user.id} lot=${code} changed=${Object.keys(changed).join(',') || '-'}${added ? ' +certificate' : ''}`);

  const note = [];
  if (!Object.keys(changed).length && !added) note.push('Nothing changed: the lot already says that.');
  if (added && added.stated_carats != null && Math.abs(added.stated_carats - before.carats) > 0.0005) {
    note.push(`The report states ${added.stated_carats} ct but the lot holds ${before.carats} ct. The lot's weight was NOT changed; a re-weigh (update_stock_op) corrects it if the trader wants.`);
  }
  return {
    ok: true,
    lot: code,
    changed,
    ...(added ? { certificate_added: added } : {}),
    ...(note.length ? { note: note.join(' ') } : {}),
  };
}

module.exports = { definition, execute, niche: 'gems' };
