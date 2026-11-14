/**
 * ERPNext Custom Field installer for the Item doctype.
 *
 * Industry-specific attributes (gem_type, weight_ct, color, origin, shape,
 * treatment, …) need to exist on the ERPNext Item doctype before the bot
 * can set them. ERPNext's Custom Field doctype lets us add fields without
 * touching ERPNext source; we install ours at server boot, idempotently.
 *
 * Site-wide install. Custom fields are global — a fashion tenant's Item
 * will simply leave `gem_type` empty. When we add more industries
 * later, those field_keys get appended; existing fields are left alone.
 *
 * Source of truth: industry_attribute_schema in our PG. Run after init().
 */

const { query } = require('../db');
const { ts } = require('../log');

// Standard (template) fields keep their option lists site-wide — the
// industry standard is enforced by ERPNext too. Business-made fields live
// in the extra_attributes JSON ('json' → Long Text).
const TYPE_MAP = {
  select: 'Select',
  json: 'Long Text',
  data: 'Data',
  float: 'Float',
  int: 'Int',
  check: 'Check',
};

const INSERT_AFTER_DEFAULT = 'description';

/**
 * Build the unique set of (field_key, definition) across all industries.
 * If two industries reuse the same field_key (e.g. both use `color`),
 * the first wins for definition — keep the seeded schemas aligned on
 * shared keys.
 */
async function loadFieldDefs() {
  const r = await query(`
    SELECT industry, field_key, field_label, field_type, options_json, ordinal
      FROM industry_attribute_schema
     ORDER BY industry, ordinal
  `);
  const defs = new Map();
  for (const row of r.rows) {
    if (defs.has(row.field_key)) continue;
    defs.set(row.field_key, row);
  }
  return [...defs.values()];
}

function optionsForSelect(optionsJson) {
  if (!optionsJson) return '';
  try {
    const arr = JSON.parse(optionsJson);
    if (!Array.isArray(arr)) return '';
    // ERPNext Select options are newline-separated. Empty first line lets
    // the field be left blank in the UI.
    return '\n' + arr.join('\n');
  } catch {
    return '';
  }
}

/**
 * Install (or refresh) every industry-attribute Custom Field on the Item
 * doctype. Idempotent — uses ERPNext's deterministic Custom Field naming
 * (`<doctype>-<fieldname>`) to detect existing rows and skip.
 *
 * Called with an admin erp client (site-wide perms). Failures on a single
 * field don't abort the rest — we log and continue.
 */
async function installItemCustomFields(erp) {
  const defs = await loadFieldDefs();
  if (defs.length === 0) {
    console.log(`• [item-cf] [${ts()}] no industry attribute defs to install`);
    return { installed: 0, skipped: 0 };
  }

  let installed = 0;
  let skipped = 0;
  for (const def of defs) {
    const erpType = TYPE_MAP[def.field_type];
    if (!erpType) {
      console.warn(`• [item-cf] [${ts()}] unknown field_type "${def.field_type}" for ${def.field_key} — skipped`);
      continue;
    }
    // ERPNext Custom Field naming: "<DocType>-<fieldname>"
    const cfName = `Item-${def.field_key}`;
    const wantOptions = erpType === 'Select' ? optionsForSelect(def.options_json) : '';
    try {
      const existing = (await erp.getResource('Custom Field', cfName)).data;
      // Refresh in place when the catalog changed the type/label/options
      // (e.g. gem_type Select → Data, a new treatment option).
      const patch = {};
      if (existing.fieldtype !== erpType) patch.fieldtype = erpType;
      if (existing.label !== def.field_label) patch.label = def.field_label;
      if ((existing.options || '') !== wantOptions) patch.options = wantOptions;
      if (Object.keys(patch).length) {
        try {
          await erp.updateResource('Custom Field', cfName, patch);
          console.log(`• [item-cf] [${ts()}] updated ${cfName} (${Object.keys(patch).join(', ')})`);
          installed++;
        } catch (upErr) {
          console.warn(`• [item-cf] [${ts()}] update ${cfName} failed: ${upErr.message}`);
        }
      } else {
        skipped++;
      }
      continue;
    } catch (err) {
      if (err.status !== 404 && !String(err.message).includes('DoesNotExistError')) {
        console.warn(`• [item-cf] [${ts()}] lookup ${cfName} failed: ${err.message}`);
        continue;
      }
    }

    const payload = {
      dt: 'Item',
      fieldname: def.field_key,
      label: def.field_label,
      fieldtype: erpType,
      insert_after: INSERT_AFTER_DEFAULT,
      // Don't mark reqd at ERPNext level — the bot enforces required-ness
      // at create_item time. Forcing it here would block manual ERPNext
      // edits for items that pre-date a schema change.
      reqd: 0,
      in_list_view: ['gem_type', 'weight_ct', 'pieces'].includes(def.field_key) ? 1 : 0,
      in_filter: 1,
    };
    if (erpType === 'Select') payload.options = wantOptions;

    try {
      await erp.createResource('Custom Field', payload);
      installed++;
      console.log(`• [item-cf] [${ts()}] installed ${cfName} (${erpType})`);
    } catch (err) {
      // Race: another process may have created it. Treat duplicate as success.
      if (/already exists|DuplicateEntryError/i.test(err.message)) {
        skipped++;
        continue;
      }
      console.warn(`• [item-cf] [${ts()}] install ${cfName} failed: ${err.message}`);
    }
  }
  console.log(`• [item-cf] [${ts()}] custom fields summary: installed=${installed} skipped=${skipped}`);
  return { installed, skipped };
}

/**
 * Load the attribute schema for one industry, ordered for asking.
 * Returns [{ field_key, field_label, field_type, required, options }, …].
 * Used by create_item to figure out what to ask the user.
 */
async function loadIndustrySchema(industry) {
  if (!industry) return [];
  const r = await query(
    `SELECT field_key, field_label, field_type, required, options_json, ordinal, ui
       FROM industry_attribute_schema
      WHERE industry = $1
      ORDER BY ordinal`,
    [industry]
  );
  return r.rows.map((row) => ({
    field_key: row.field_key,
    field_label: row.field_label,
    field_type: row.field_type,
    required: !!row.required,
    ui: row.ui || 'more',
    options: row.options_json ? safeJsonParse(row.options_json) : null,
  }));
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

module.exports = { installItemCustomFields, loadFieldDefs, loadIndustrySchema };
