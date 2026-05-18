/**
 * Fetch metadata about a counterparty (Customer / Supplier / both) from ERPNext.
 * Used when the user asks identity / contact / configuration questions like
 * "what currency is X", "what's X's phone", "details of X".
 *
 * When partyType='Both', returns whatever sides exist as { customer, supplier }.
 * Empty sides are null (e.g. Acme is a Supplier only → customer: null).
 *
 * Each side carries the most-commonly-asked fields:
 *   name, default_currency, mobile_no, email_id, group, territory
 */

const FIELDS = {
  Customer: [
    'name',
    'customer_name',
    'default_currency',
    'mobile_no',
    'email_id',
    'customer_group',
    'territory',
    'tax_id',
  ],
  Supplier: [
    'name',
    'supplier_name',
    'default_currency',
    'mobile_no',
    'email_id',
    'supplier_group',
  ],
};

function normalize(doctype, row) {
  if (!row) return null;
  return {
    doctype,
    erpnext_name: row.name,
    display_name: row.customer_name || row.supplier_name,
    default_currency: row.default_currency || null,
    phone: row.mobile_no || null,
    email: row.email_id || null,
    group: row.customer_group || row.supplier_group || null,
    territory: row.territory || null,
    tax_id: row.tax_id || null,
  };
}

async function getCounterpartyDetails(user, erp, { partyName, partyType = 'Both' }) {
  if (!partyName) throw new Error('partyName is required');

  const wanted =
    partyType === 'Both' ? ['Customer', 'Supplier'] : [partyType];

  const out = { customer: null, supplier: null };
  for (const dt of wanted) {
    try {
      const r = await erp.listResource(dt, {
        filters: [[dt === 'Customer' ? 'customer_name' : 'supplier_name', '=', partyName]],
        fields: FIELDS[dt],
        limit: 1,
      });
      const row = r.data?.[0] || null;
      out[dt.toLowerCase()] = normalize(dt, row);
    } catch (err) {
      // Skip this side on error rather than aborting the whole lookup.
      console.warn(`[counterparty-details] ${dt} lookup failed: ${err.message}`);
    }
  }

  return out;
}

module.exports = { getCounterpartyDetails };
