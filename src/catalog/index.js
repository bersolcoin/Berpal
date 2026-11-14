/**
 * Catalog service — the shared product catalog and each business's choice
 * of which categories are on.
 *
 * Tree: Category (Gemstones, Watches…) › Family › Variety, plus each
 * category's standard fields. The catalog is ADMIN-ONLY: defined in
 * src/catalog/* (an admin panel comes later) and seeded as shared rows
 * (owner_user_id NULL). A business can only:
 *   - switch categories on/off (business_categories; at least one on),
 *   - view varieties and fields,
 *   - request additions (catalog_requests) — we review and add them.
 *
 *   CATALOG                                  categories defined in code (some "coming soon")
 *   listCategories(userId)                   → [{ id, key, name, uom, attribute_set, enabled, comingSoon }]
 *   setCategoryEnabled(user, id, on)
 *   enableCategoriesByKey(userId, keys)      onboarding
 *   listVarieties(userId)                    → varieties of the enabled categories
 *   loadCategoryFields(categoryId)           → standard fields (view-only)
 *   requestStandard / listRequests
 *   nextLotCode(user, erp, prefix)           → 'AQ0007'
 *   createLot(user, erp, { variety, code?, name?, attributes })
 *
 * Fields the catalog marks required (gem pieces + weight) are mandatory.
 */

const { query } = require('../db');
const { createItem } = require('../erp-sync/item');
const { ensureVarietyItemGroup, tenantItemGroupFilter } = require('../erp-sync/item-group');
const { getAdminClient } = require('../erp-admin');
const gem = require('./gemstones');

// Every category we offer. key = attribute_set. comingSoon entries are
// shown greyed out and never seeded.
const CATALOG = [
  {
    key: gem.INDUSTRY,
    name: gem.CATEGORY,
    uom: gem.UOM,
    attribute_set: gem.INDUSTRY,
    ordinal: 0,
    varieties: gem.VARIETIES.map(([family, variety, prefix]) => ({ family, variety, prefix })),
  },
  { key: 'watches', name: 'Watches', uom: 'Nos', ordinal: 1, comingSoon: true, varieties: [] },
];

// Units (ERPNext UOM → label).
const UNITS = { Nos: 'Pieces', Carat: 'Carat', Gram: 'Gram' };

// Field type labels for the view-only field list.
const FIELD_TYPES = { data: 'Text', select: 'Dropdown', int: 'Whole number', float: 'Decimal number', check: 'Yes / No' };

const userError = (msg) => Object.assign(new Error(msg), { userMessage: msg });
const tidy = (v) => String(v || '').trim().replace(/\s+/g, ' ');

// ── Categories ─────────────────────────────────────────────────────────

/** Seeded categories with this business's on/off, then the coming-soon ones. */
async function listCategories(userId) {
  const r = await query(
    `SELECT r.id, r.industry AS key, r.name, r.uom, r.attribute_set, (b.category_id IS NOT NULL) AS enabled
       FROM item_category_roots r
       LEFT JOIN business_categories b ON b.category_id = r.id AND b.owner_user_id = $1
      WHERE r.owner_user_id IS NULL
      ORDER BY r.ordinal, r.id`,
    [userId]
  );
  const soon = CATALOG.filter((c) => c.comingSoon).map((c) => ({
    id: null,
    key: c.key,
    name: c.name,
    uom: c.uom,
    attribute_set: null,
    enabled: false,
    comingSoon: true,
  }));
  return [...r.rows.map((c) => ({ ...c, comingSoon: false })), ...soon];
}

/** Switch a catalog category on/off for a business — at least one stays on. */
async function setCategoryEnabled(user, categoryId, on) {
  const all = await listCategories(user.id);
  const cat = all.find((c) => c.id === Number(categoryId));
  if (!cat) throw userError('Category not found.');
  if (on) {
    await query(
      `INSERT INTO business_categories (owner_user_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [user.id, cat.id]
    );
  } else {
    if (!all.some((c) => c.enabled && c.id !== cat.id)) throw userError('At least one category must stay on.');
    await query(`DELETE FROM business_categories WHERE owner_user_id = $1 AND category_id = $2`, [user.id, cat.id]);
  }
}

/** Enable catalog categories by key (onboarding: ['gemstones']). */
async function enableCategoriesByKey(userId, keys) {
  for (const key of keys || []) {
    const r = await query(`SELECT id FROM item_category_roots WHERE owner_user_id IS NULL AND industry = $1`, [key]);
    if (r.rows[0]) await setCategoryEnabled({ id: userId }, r.rows[0].id, true);
  }
}

// ── Varieties ──────────────────────────────────────────────────────────

/**
 * Varieties of the given categories (default: the business's enabled ones).
 * Pass { allCategories: true } to list every seeded category's varieties
 * (the view-only settings page shows switched-off categories too).
 */
async function listVarieties(userId, { allCategories = false } = {}) {
  const r = await query(
    `SELECT c.id, c.category, r.id AS category_id, c.family, c.variety, c.code_prefix, r.uom, r.attribute_set
       FROM item_categories c
       JOIN item_category_roots r ON r.owner_user_id IS NULL AND lower(r.name) = lower(c.category)
       ${allCategories ? '' : 'JOIN business_categories b ON b.category_id = r.id AND b.owner_user_id = $1'}
      WHERE c.owner_user_id IS NULL ${allCategories ? 'AND $1::int IS NOT NULL' : ''}
      ORDER BY r.ordinal, r.id, c.ordinal, c.id`,
    [userId]
  );
  return r.rows;
}

async function getVariety(userId, variety) {
  const rows = await listVarieties(userId);
  return rows.find((v) => v.variety.toLowerCase() === String(variety).toLowerCase()) || null;
}

// ── Fields ─────────────────────────────────────────────────────────────

const parseJson = (s) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

/**
 * A category's standard fields (view-only; defined in the catalog).
 * Returns [{ field_key, field_label, field_type, options, required, ui, mandatory }].
 */
async function loadCategoryFields(categoryId) {
  const r = await query(
    `SELECT s.field_key, s.field_label, s.field_type, s.options_json, s.required, s.ui
       FROM item_category_roots root
       JOIN industry_attribute_schema s ON s.industry = root.attribute_set AND s.ui <> 'system'
      WHERE root.id = $1
      ORDER BY s.ordinal`,
    [categoryId]
  );
  return r.rows.map((row) => ({
    field_key: row.field_key,
    field_label: row.field_label,
    field_type: row.field_type,
    options: parseJson(row.options_json),
    required: !!row.required,
    ui: row.ui,
    mandatory: !!row.required,
  }));
}

/** A catalog category this business has switched on. */
async function enabledCategory(user, categoryId) {
  const cat = (await listCategories(user.id)).find((c) => c.id === Number(categoryId));
  if (!cat || !cat.enabled) throw userError('Category not found or not switched on.');
  return cat;
}

// ── Requests to extend the catalog ─────────────────────────────────────

const REQUEST_KINDS = new Set(['category', 'variety', 'option', 'field']);

/**
 * kind: 'category' (new top-level category — categoryId null) |
 *       'variety'  (new variety in a category; family in `note` context) |
 *       'option'   (new value for a standard dropdown, field_key) |
 *       'field'    (new standard field for a category)
 */
async function requestStandard(user, categoryId, { kind, field_key = null, family = null, value, note = null }) {
  if (!REQUEST_KINDS.has(kind)) throw userError('Invalid request.');
  value = tidy(value);
  if (value.length < 1 || value.length > 80) throw userError('Enter what you need (up to 80 characters).');

  let template = 'new';
  if (kind !== 'category') {
    const cat = await enabledCategory(user, categoryId);
    template = cat.attribute_set || cat.name;
    if (kind === 'option') {
      const field = (await loadCategoryFields(categoryId)).find((f) => f.field_key === field_key);
      if (!field || field.field_type !== 'select') throw userError('Pick a standard dropdown field.');
      if ((field.options || []).some((o) => o.toLowerCase() === value.toLowerCase())) {
        throw userError(`"${value}" is already an option.`);
      }
    }
    if (kind === 'variety') {
      const hit = (await listVarieties(user.id)).find((v) => v.variety.toLowerCase() === value.toLowerCase());
      if (hit) throw userError(`"${hit.variety}" already exists.`);
    }
  } else {
    const hit = (await listCategories(user.id)).find((c) => c.name.toLowerCase() === value.toLowerCase());
    if (hit) throw userError(`"${hit.name}" already exists${hit.enabled ? '' : ' — switch it on'}.`);
  }

  const fullNote = [kind === 'variety' && tidy(family) ? `Family: ${tidy(family)}` : null, tidy(note)]
    .filter(Boolean)
    .join(' — ')
    .slice(0, 300);
  const r = await query(
    `INSERT INTO catalog_requests (owner_user_id, template, kind, field_key, value, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, template, kind, field_key, value, note, status, created_at`,
    [user.id, template, kind, kind === 'option' ? field_key : null, value, fullNote || null]
  );
  return r.rows[0];
}

async function listRequests(userId) {
  const r = await query(
    `SELECT id, template, kind, field_key, value, note, status, created_at
       FROM catalog_requests WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [userId]
  );
  return r.rows;
}

// ── Lots ───────────────────────────────────────────────────────────────

/**
 * Next lot code for a prefix within this tenant: highest existing
 * <PREFIX><digits> + 1, zero-padded to 4. Tenant Item codes carry a
 * "-<ABBR>" suffix in ERPNext (createItem adds it); returned code is bare.
 */
async function nextLotCode(user, erp, prefix) {
  const abbr = user.erpnext_company_abbr;
  const sfx = abbr ? `-${abbr}` : '';
  const r = await erp.listResource('Item', {
    filters: [['item_code', 'like', `${prefix}%${sfx}`]],
    fields: ['item_code'],
    limit: 0,
  });
  const re = new RegExp(`^${prefix}(\\d+)${sfx.replace(/[-]/g, '\\-')}$`);
  let max = 0;
  for (const row of r.data || []) {
    const m = re.exec(row.item_code);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

/** Coerce raw form values to the fields' declared types; drop unknowns. */
function coerceAttributes(fields, raw = {}) {
  const out = {};
  for (const def of fields) {
    const v = raw[def.field_key];
    if (v === undefined || v === null || v === '') continue;
    if (def.field_type === 'float') {
      const n = Number(v);
      if (Number.isFinite(n)) out[def.field_key] = n;
    } else if (def.field_type === 'int') {
      const n = parseInt(v, 10);
      if (Number.isFinite(n)) out[def.field_key] = n;
    } else if (def.field_type === 'check') {
      out[def.field_key] = v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
    } else if (def.field_type === 'select' && Array.isArray(def.options)) {
      if (def.options.includes(String(v))) out[def.field_key] = String(v);
    } else {
      out[def.field_key] = String(v).trim();
    }
  }
  return out;
}

/** Selling price list for a currency — created site-wide on first use. */
const _priceLists = new Set();
async function ensureSellingPriceList(currency, companyCurrency) {
  const name = currency === companyCurrency ? 'Standard Selling' : `Standard Selling ${currency}`;
  if (_priceLists.has(name)) return name;
  const admin = getAdminClient();
  try {
    await admin.getResource('Price List', name);
  } catch (err) {
    if (err.status !== 404 && !String(err.message).includes('DoesNotExistError')) throw err;
    await admin.createResource('Price List', { price_list_name: name, currency, selling: 1, buying: 0, enabled: 1 });
  }
  _priceLists.add(name);
  return name;
}

/**
 * Create a lot in one of the business's enabled varieties. Returns
 * { erpnext_name, item_code, uom, weight_ct? } or throws an Error with a
 * user-facing message (err.userMessage).
 */
async function createLot(user, erp, { variety, code = null, name = null, attributes = {}, media = null, sellingPrice = null }) {
  const cat = await getVariety(user.id, variety);
  if (!cat) throw userError(`"${variety}" isn’t in your categories.`);

  // Standard fields → their Item Custom Fields.
  const fields = await loadCategoryFields(cat.category_id);
  const attrs = coerceAttributes(fields, attributes);
  const missing = fields.filter((f) => f.required && attrs[f.field_key] == null);
  if (missing.length) throw userError(`${missing.map((f) => f.field_label).join(', ')} required.`);

  const isGem = cat.attribute_set === gem.INDUSTRY;
  if (isGem) {
    if (!(attrs.weight_ct > 0)) throw userError('Weight must be more than 0 ct.');
    if (!(attrs.pieces > 0)) throw userError('Pieces must be at least 1.');
    // Derived defaults (shop rules) — only when the user didn't set them.
    if (!attrs.parcel_type) attrs.parcel_type = gem.parcelTypeForPieces(attrs.pieces);
    if (attrs.calibrated == null) {
      const c = gem.isCalibrated(attrs.meas1, attrs.meas2);
      if (c != null) attrs.calibrated = c ? 1 : 0;
    }
  }
  // Category path on the Item for search/filters.
  attrs.gem_family = cat.family;
  attrs.gem_type = cat.variety;
  // media: { image, images: [], video } — main image on Item.image, rest as JSON.
  const extraMedia = media ? { images: media.images || [], video: media.video || null } : null;
  if (extraMedia && (extraMedia.images.length || extraMedia.video)) attrs.media = JSON.stringify(extraMedia);

  const itemGroup = await ensureVarietyItemGroup(getAdminClient(), user.erpnext_company_abbr, {
    category: cat.category,
    family: cat.family,
    variety: cat.variety,
  });

  const lotCode = (code && String(code).trim().toUpperCase()) || (await nextLotCode(user, erp, cat.code_prefix || 'LT'));
  const title =
    (name && String(name).trim()) ||
    (isGem
      ? `${cat.variety} ${attrs.weight_ct}ct${attrs.parcel_type && attrs.parcel_type !== 'Single' ? ` ${attrs.parcel_type}` : ''}`
      : `${cat.variety} ${lotCode}`);

  const created = await createItem(user, erp, {
    code: lotCode,
    name: title,
    uom: cat.uom || 'Nos',
    isStockItem: true,
    attributes: attrs,
    itemGroup,
    image: media?.image || null,
  });

  // Selling price (e.g. the web price) → ERPNext Item Price, on a selling
  // price list in that currency ("Standard Selling" for the company
  // currency, "Standard Selling USD" etc. otherwise). Non-fatal.
  if (sellingPrice?.amount > 0) {
    try {
      const priceList = await ensureSellingPriceList(sellingPrice.currency, user.default_currency);
      await erp.createResource('Item Price', {
        item_code: created.erpnext_name,
        price_list: priceList,
        currency: sellingPrice.currency,
        price_list_rate: Number(sellingPrice.amount),
      });
    } catch (err) {
      console.warn(`[catalog] selling price for ${created.erpnext_name} not saved: ${err.message}`);
    }
  }
  return { ...created, uom: cat.uom || 'Nos', ...(isGem ? { weight_ct: attrs.weight_ct } : {}) };
}

module.exports = {
  CATALOG,
  UNITS,
  FIELD_TYPES,
  listCategories,
  setCategoryEnabled,
  enableCategoriesByKey,
  listVarieties,
  loadCategoryFields,
  requestStandard,
  listRequests,
  nextLotCode,
  createLot,
};
