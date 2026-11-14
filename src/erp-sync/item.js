/**
 * Ensure a generic catch-all Item exists in ERPNext for use as the line-item
 * placeholder on Sales / Purchase Invoices.
 *
 * ERPNext requires every invoice line to reference an Item. For one-off
 * goods/services we don't want to mint an Item per SKU — so we keep two
 * shared items: GEN-SALE for sales, GEN-PURCHASE for purchases. The actual
 * product/service description goes on the line's `description` field.
 *
 * Per-process memo so we don't hit the API repeatedly during the same run.
 *
 * Items are now tagged with the user's per-company Item Group ("Items - <ABBR>")
 * so the web app can scope inventory views per tenant. The legacy generics
 * (GEN-SALE / GEN-PURCHASE) are namespaced per tenant — each tenant gets
 * their own "GEN-SALE-<ABBR>" so they live in the right Item Group.
 */

const { ts } = require('../log');
const { ensureCompanyItemGroup, abbrFromUser, tenantItemGroupFilter, isTenantItemGroup } = require('./item-group');

const _ensured = new Set();

async function ensureItem(user, erp, { codeBase, name, isSales, isPurchase }) {
  const abbr = abbrFromUser(user);
  // Namespace the code per tenant so each company has its own copy.
  const code = abbr ? `${codeBase}-${abbr}` : codeBase;
  const cacheKey = `${erp.company}|${code}`;
  if (_ensured.has(cacheKey)) return code;

  try {
    await erp.getResource('Item', code);
    _ensured.add(cacheKey);
    return code;
  } catch (err) {
    if (err.status !== 404 && !String(err.message).includes('DoesNotExistError')) throw err;
  }

  // Ensure the per-company Item Group exists before referencing it.
  let itemGroup = 'All Item Groups';
  if (abbr) {
    try {
      itemGroup = await ensureCompanyItemGroup(erp, abbr);
    } catch (err) {
      console.warn(`• [item] [${ts()}] item-group ensure failed, using default: ${err.message}`);
    }
  }

  await erp.createResource('Item', {
    item_code: code,
    item_name: name,
    item_group: itemGroup,
    stock_uom: 'Nos',
    is_stock_item: 0,
    is_sales_item: isSales ? 1 : 0,
    is_purchase_item: isPurchase ? 1 : 0,
    description: `Default item used by bot for ${isSales ? 'sales' : 'purchase'} line items`,
  });

  _ensured.add(cacheKey);
  console.log(`• [item] [${ts()}] created Item ${code} in ERPNext (group=${itemGroup})`);
  return code;
}

function ensureGenericSalesItem(user, erp) {
  return ensureItem(user, erp, {
    codeBase: 'GEN-SALE',
    name: 'Generic Sale',
    isSales: true,
    isPurchase: false,
  });
}

function ensureGenericPurchaseItem(user, erp) {
  return ensureItem(user, erp, {
    codeBase: 'GEN-PURCHASE',
    name: 'Generic Purchase',
    isSales: false,
    isPurchase: true,
  });
}

/**
 * Resolve a user-supplied item reference to the real ERPNext Item name.
 * Used by the invoice handlers to convert "pa2293" / "1ct sapphire" into
 * the actual Item doc to put on the SI/PI line.
 *
 * Lookup order (within the user's Item Group "Items - <ABBR>"):
 *   1. Exact item_code match on the user's literal (e.g. "pa2293")
 *   2. Exact match on the tenant-suffixed form (e.g. "pa2293-TTC") —
 *      what create_item produces, so users typing the bare code still hit
 *   3. Fuzzy LIKE match on item_code OR item_name (two queries, deduped)
 *
 * Throws:
 *   - AMBIGUOUS_ITEM (with .candidates[]) when 2+ rows match fuzzy. LLM
 *     should ask which one and re-call with a tighter input.
 *   - NEW_ITEM (with .suggested_code / .suggested_description) when 0
 *     rows match. LLM should ask the user for details and call
 *     create_item, then re-attempt save_transaction.
 *
 * Caller is the invoice handler. The LLM never calls this directly — it
 * calls lookup_item which has friendlier ambiguity surfacing.
 */
async function resolveItem(user, erp, { code = null, description = null } = {}) {
  if (!code && !description) {
    throw new Error('resolveItem needs at least one of: code, description');
  }

  const abbr = abbrFromUser(user);
  const groupFilter = tenantItemGroupFilter(abbr);

  // 1+2. Exact-code attempts.
  const exactCandidates = [];
  if (code) {
    exactCandidates.push(code);
    if (abbr) exactCandidates.push(`${code}-${abbr}`);
  }
  for (const c of exactCandidates) {
    try {
      const r = await erp.getResource('Item', c);
      const doc = r.data;
      // Reject if the item exists but belongs to a different tenant's group.
      if (!abbr || isTenantItemGroup(abbr, doc.item_group)) {
        return { erpnext_name: doc.name, item_code: doc.item_code, item_name: doc.item_name };
      }
    } catch (err) {
      if (err.status !== 404 && !String(err.message).includes('DoesNotExistError')) throw err;
    }
  }

  // 3. Fuzzy LIKE on code + name (ERPNext REST has no native OR filter,
  //    so two queries + JS dedupe). Description is intentionally NOT
  //    searched — too noisy (every Acme invoice description gets
  //    indexed); item_name is the curated friendly handle and matches
  //    user typing better.
  const term = code || description;
  const fields = ['name', 'item_code', 'item_name', 'item_group', 'is_stock_item'];
  const byCode = await erp.listResource('Item', {
    filters: [...groupFilter, ['disabled', '=', 0], ['item_code', 'like', `%${term}%`]],
    fields,
    limit: 10,
  });
  const byName = await erp.listResource('Item', {
    filters: [...groupFilter, ['disabled', '=', 0], ['item_name', 'like', `%${term}%`]],
    fields,
    limit: 10,
  });
  const merged = new Map();
  for (const row of [...(byCode.data || []), ...(byName.data || [])]) {
    merged.set(row.name, row);
  }
  const rows = [...merged.values()];

  if (rows.length === 1) {
    const hit = rows[0];
    console.log(`• [item] [${ts()}] fuzzy-resolved "${term}" → ${hit.name}`);
    return { erpnext_name: hit.name, item_code: hit.item_code, item_name: hit.item_name };
  }
  if (rows.length > 1) {
    const err = new Error(
      `Multiple items match "${term}": ${rows.map((r) => r.item_code).join(', ')}. Ask the user which one.`
    );
    err.code = 'AMBIGUOUS_ITEM';
    err.candidates = rows.map((r) => ({
      erpnext_name: r.name,
      item_code: r.item_code,
      item_name: r.item_name,
    }));
    throw err;
  }

  // No match — signal that create_item is needed.
  const newErr = new Error(`No item matches "${term}".`);
  newErr.code = 'NEW_ITEM';
  newErr.suggested_code = code || null;
  newErr.suggested_description = description || null;
  throw newErr;
}

/**
 * Create a new ERPNext Item for this tenant.
 *
 * The user-typed code is suffixed with the tenant abbr to avoid
 * collisions with other tenants' items (ERPNext Item names are
 * site-global). Item Group is the per-company group, ensured on first
 * use. is_stock_item is decided by the caller (the create_item LLM
 * tool gates it on business_type).
 *
 * Returns the created Item's ERPNext name. Does NOT post any opening
 * stock — caller does that separately via Stock Reconciliation if
 * opening_qty was provided (kept decoupled so failures of one don't
 * stomp the other).
 */
async function createItem(user, erp, {
  code,
  name = null,
  description = null,
  uom = 'Nos',
  isStockItem = false,
  isSalesItem = true,
  isPurchaseItem = true,
  attributes = null,    // { gem_type: 'Sapphire', weight_ct: 1.05, … } — written to Custom Fields
  itemGroup = null,     // explicit group (catalog variety); default = tenant root
  image = null,         // main image URL (Item.image)
}) {
  if (!code) throw new Error('createItem needs a code');

  const abbr = abbrFromUser(user);
  const erpCode = abbr ? `${code}-${abbr}` : code;

  // Ensure the per-tenant Item Group before referencing it.
  if (!itemGroup) itemGroup = 'All Item Groups';
  if (abbr && itemGroup === 'All Item Groups') {
    try {
      itemGroup = await ensureCompanyItemGroup(erp, abbr);
    } catch (err) {
      console.warn(`• [item] [${ts()}] item-group ensure failed, using default: ${err.message}`);
    }
  }

  const payload = {
    item_code: erpCode,
    item_name: name || code,
    item_group: itemGroup,
    stock_uom: uom,
    is_stock_item: isStockItem ? 1 : 0,
    is_sales_item: isSalesItem ? 1 : 0,
    is_purchase_item: isPurchaseItem ? 1 : 0,
    description: description || name || code,
    ...(image ? { image } : {}),
  };
  // Custom-field attributes are passed inline on the same create —
  // ERPNext accepts custom fieldnames in the resource payload as long
  // as the Custom Field has been installed (which happens at boot).
  if (attributes && typeof attributes === 'object') {
    for (const [k, v] of Object.entries(attributes)) {
      if (v === undefined || v === null || v === '') continue;
      payload[k] = v;
    }
  }
  const result = await erp.createResource('Item', payload);
  const attrCount = attributes ? Object.values(attributes).filter((v) => v !== undefined && v !== null && v !== '').length : 0;
  console.log(`• [item] [${ts()}] created Item ${erpCode} (group=${itemGroup}, stock=${payload.is_stock_item}, uom=${uom}, attrs=${attrCount})`);
  return { erpnext_name: result.data?.name || erpCode, item_code: erpCode };
}

/**
 * Attribute-aware item search. Used by lookup_item when the user
 * references an item by attributes only ("1.05ct paraiba") without an
 * SKU. Parses weight + gem hint out of the free-text term and queries
 * ERPNext Items by the Custom Fields installed at boot (weight_ct,
 * gem_type), constrained to the user's per-tenant Item Group.
 *
 * Falls back to the same code/name fuzzy as resolveItem when no
 * attributes can be parsed.
 *
 * Returns { count, candidates: [{ erpnext_name, item_code, item_name,
 *           gem_type, weight_ct }] }. Up to 10.
 */
async function lookupItemByAttributes(user, erp, term) {
  if (!term) return { count: 0, candidates: [] };

  const abbr = abbrFromUser(user);
  const groupFilter = tenantItemGroupFilter(abbr);

  // Parse "1.05ct" / "1 ct" / "0.75ct" out of the term.
  const weightMatch = term.match(/(\d+(?:\.\d+)?)\s*ct\b/i);
  const weightCt = weightMatch ? Number(weightMatch[1]) : null;

  // Parse gem hint — match against known gem_type options (case-insensitive).
  // Loaded from the industry schema so we don't hardcode here.
  const { loadIndustrySchema } = require('./item-custom-fields');
  const industry = user?.industry || 'gemstones';
  const schema = await loadIndustrySchema(industry);
  const gemTypeDef = schema.find((d) => d.field_key === 'gem_type');
  const gemOptions = gemTypeDef?.options || [];
  const termLower = term.toLowerCase();
  const gemHint = gemOptions.find((opt) => termLower.includes(opt.toLowerCase())) || null;

  const fields = ['name', 'item_code', 'item_name', 'item_group', 'gem_type', 'weight_ct'];

  // Build attribute filters. Loose weight match (±0.05ct) so a typed
  // "1.05ct" still matches a stored 1.05 or 1.0499 (rounding).
  const attrFilters = [];
  if (gemHint) attrFilters.push(['gem_type', '=', gemHint]);
  if (weightCt !== null) {
    attrFilters.push(['weight_ct', '>=', Math.max(0, weightCt - 0.05)]);
    attrFilters.push(['weight_ct', '<=', weightCt + 0.05]);
  }

  let candidates = [];
  if (attrFilters.length > 0) {
    const r = await erp.listResource('Item', {
      filters: [...groupFilter, ['disabled', '=', 0], ...attrFilters],
      fields,
      limit: 10,
    });
    candidates = r.data || [];
  }

  // Fallback / supplement: if we didn't find anything via attributes,
  // try a code/name LIKE so the user gets SOMETHING actionable instead
  // of an empty result that drives the LLM to create_item too eagerly.
  if (candidates.length === 0) {
    const stripped = term.replace(/\d+(?:\.\d+)?\s*ct\b/gi, '').trim();
    if (stripped) {
      const byName = await erp.listResource('Item', {
        filters: [...groupFilter, ['disabled', '=', 0], ['item_name', 'like', `%${stripped}%`]],
        fields,
        limit: 10,
      });
      candidates = byName.data || [];
    }
  }

  return {
    count: candidates.length,
    parsed: { weight_ct: weightCt, gem_type: gemHint },
    candidates: candidates.map((r) => ({
      erpnext_name: r.name,
      item_code: r.item_code,
      item_name: r.item_name,
      gem_type: r.gem_type,
      weight_ct: r.weight_ct,
    })),
  };
}

module.exports = {
  ensureGenericSalesItem,
  ensureGenericPurchaseItem,
  resolveItem,
  createItem,
  lookupItemByAttributes,
};
