/**
 * Merged recent-transactions stream across the four accounting doctypes
 * the bot can produce: Sales Invoice, Purchase Invoice, Payment Entry,
 * Journal Entry. Sorted newest-first by posting_date (then by `name` for
 * stable order within a date).
 *
 * Returns:
 *   {
 *     rows: [{
 *       doctype, erpnext_name, kind, party, posting_date,
 *       currency, amount, status, raw,
 *       flow,        // { from: [names], to: [names] } — where value moved (credit → debit)
 *       direction,   // 'in' | 'out' | 'transfer' | 'neutral' (company view)
 *     }, ...],
 *     hasMore: boolean
 *   }
 *
 * `kind` is a friendly label: 'Invoice', 'Purchase', 'Expense', 'Cash',
 * 'Receipt', 'Payment'. `party` is the customer / supplier when applicable.
 *
 * Pagination model: pass `offset` to skip rows, `limit` for page size.
 * Because we merge four streams and re-sort client-side, each doctype
 * is fetched up to `limit + offset + 1` from ERPNext — fine for typical
 * small-business volumes, gets inefficient past page 20+.
 */

const DEFAULT_LIMIT_PER_DOCTYPE = 50;

// Accounts that are the business's money (wallets).
const WALLET_TYPES = new Set(['Cash', 'Bank']);

const unique = (list) => [...new Set(list)];

/**
 * Money in or out from the company's point of view: debiting a wallet
 * brings money in, crediting one sends it out, both = a transfer between
 * wallets, neither (accruals, reclassifications) = neutral.
 */
function journalDirection(lines) {
  const debitWallet = lines.some((l) => Number(l.debit) > 0 && WALLET_TYPES.has(l.account_type));
  const creditWallet = lines.some((l) => Number(l.credit) > 0 && WALLET_TYPES.has(l.account_type));
  if (debitWallet && creditWallet) return 'transfer';
  if (debitWallet) return 'in';
  if (creditWallet) return 'out';
  return 'neutral';
}

async function listRecentTransactions(user, erp, { limit = 25, offset = 0, filters = {} } = {}) {
  const perType = Math.max(limit + offset + 1, DEFAULT_LIMIT_PER_DOCTYPE);

  // Per-doctype filters built from the global filter object (so the
  // server-side query slims the result early). Type filtering happens
  // post-merge (cleaner than special-casing which doctypes to query).
  const dateFilters = [];
  if (filters.from) dateFilters.push(['posting_date', '>=', filters.from]);
  if (filters.to) dateFilters.push(['posting_date', '<=', filters.to]);

  const baseFilters = (extra = []) => [
    ['company', '=', erp.company],
    ['docstatus', '!=', 2],
    ...dateFilters,
    ...extra,
  ];

  const [si, pi, pe, je] = await Promise.all([
    erp.listResource('Sales Invoice', {
      filters: baseFilters(),
      fields: ['name', 'customer', 'posting_date', 'currency', 'grand_total', 'outstanding_amount', 'status', 'docstatus'],
      limit: perType,
      orderBy: 'posting_date desc, name desc',
    }),
    erp.listResource('Purchase Invoice', {
      filters: baseFilters(),
      fields: ['name', 'supplier', 'posting_date', 'currency', 'grand_total', 'outstanding_amount', 'status', 'docstatus'],
      limit: perType,
      orderBy: 'posting_date desc, name desc',
    }),
    erp.listResource('Payment Entry', {
      filters: baseFilters(),
      fields: [
        'name', 'payment_type', 'party_type', 'party',
        'paid_from', 'paid_to',
        'posting_date', 'paid_amount',
        'paid_from_account_currency', 'paid_to_account_currency',
        'docstatus',
      ],
      limit: perType,
      orderBy: 'posting_date desc, name desc',
    }),
    erp.listResource('Journal Entry', {
      filters: baseFilters(),
      fields: ['name', 'title', 'posting_date', 'total_debit', 'docstatus'],
      limit: perType,
      orderBy: 'posting_date desc, name desc',
    }),
  ]);

  // Journal lines for from → to + direction: credited accounts are the
  // source, debited the destination. One query for all listed journals.
  const jeNames = (je.data || []).map((r) => r.name);
  const jeLines = new Map();
  if (jeNames.length) {
    const lines = await erp.listResource('Journal Entry', {
      filters: [['name', 'in', jeNames]],
      fields: ['name', 'accounts.account', 'accounts.debit', 'accounts.credit', 'accounts.account_type'],
      limit: 0,
    });
    for (const l of lines.data || []) {
      if (!jeLines.has(l.name)) jeLines.set(l.name, []);
      jeLines.get(l.name).push(l);
    }
  }

  const rows = [];

  for (const r of si.data || []) {
    rows.push({
      direction: 'in',
      // Accounting direction (credit → debit): Sales → the customer, who now owes.
      flow: { from: ['Sales'], to: [r.customer].filter(Boolean) },
      doctype: 'Sales Invoice',
      erpnext_name: r.name,
      kind: 'Invoice',
      party: r.customer,
      posting_date: r.posting_date,
      currency: r.currency,
      amount: Number(r.grand_total) || 0,
      outstanding: Number(r.outstanding_amount) || 0,
      status: r.docstatus === 0 ? 'Draft' : (r.status || 'Submitted'),
      raw: r,
    });
  }
  for (const r of pi.data || []) {
    rows.push({
      direction: 'out',
      // Credit → debit: the supplier (now owed) → purchases / stock.
      flow: { from: [r.supplier].filter(Boolean), to: ['Purchases'] },
      doctype: 'Purchase Invoice',
      erpnext_name: r.name,
      kind: 'Purchase',
      party: r.supplier,
      posting_date: r.posting_date,
      currency: r.currency,
      amount: Number(r.grand_total) || 0,
      outstanding: Number(r.outstanding_amount) || 0,
      status: r.docstatus === 0 ? 'Draft' : (r.status || 'Submitted'),
      raw: r,
    });
  }
  for (const r of pe.data || []) {
    const receive = r.payment_type === 'Receive';
    rows.push({
      direction: receive ? 'in' : 'out',
      // Receive: party → wallet; Pay: wallet → party.
      flow: receive
        ? { from: [r.party || r.paid_from].filter(Boolean), to: [r.paid_to].filter(Boolean) }
        : { from: [r.paid_from].filter(Boolean), to: [r.party || r.paid_to].filter(Boolean) },
      doctype: 'Payment Entry',
      erpnext_name: r.name,
      kind: r.payment_type === 'Receive' ? 'Receipt' : 'Payment',
      party: r.party,
      posting_date: r.posting_date,
      currency: r.payment_type === 'Receive' ? r.paid_from_account_currency : r.paid_to_account_currency,
      amount: Number(r.paid_amount) || 0,
      outstanding: 0,
      status: r.docstatus === 0 ? 'Draft' : 'Submitted',
      raw: r,
    });
  }
  for (const r of je.data || []) {
    const isExpense = /expense|bill|cost/i.test(r.title || '');
    const lines = jeLines.get(r.name) || [];
    rows.push({
      direction: journalDirection(lines),
      flow: {
        from: unique(lines.filter((l) => Number(l.credit) > 0).map((l) => l.account)),
        to: unique(lines.filter((l) => Number(l.debit) > 0).map((l) => l.account)),
      },
      doctype: 'Journal Entry',
      erpnext_name: r.name,
      kind: isExpense ? 'Expense' : 'Cash',
      party: null,
      posting_date: r.posting_date,
      currency: null,
      amount: Number(r.total_debit) || 0,
      outstanding: 0,
      status: r.docstatus === 0 ? 'Draft' : 'Submitted',
      raw: { ...r, title: r.title },
    });
  }

  // Post-merge filters (kind + free-text search).
  let filtered = rows;
  if (filters.type) {
    const t = String(filters.type).toLowerCase();
    filtered = filtered.filter((r) => r.kind.toLowerCase() === t);
  }
  if (filters.q) {
    const q = String(filters.q).toLowerCase().trim();
    if (q) {
      filtered = filtered.filter(
        (r) =>
          (r.party || '').toLowerCase().includes(q) ||
          (r.erpnext_name || '').toLowerCase().includes(q) ||
          (r.raw?.title || '').toLowerCase().includes(q)
      );
    }
  }

  filtered.sort((a, b) => {
    const da = a.posting_date || '';
    const db = b.posting_date || '';
    if (da !== db) return db.localeCompare(da);
    return (b.erpnext_name || '').localeCompare(a.erpnext_name || '');
  });

  // Slice and detect hasMore by fetching one extra row.
  const page = filtered.slice(offset, offset + limit + 1);
  const hasMore = page.length > limit;
  return { rows: page.slice(0, limit), hasMore };
}

/**
 * Total transaction count across the four doctypes for the user's company.
 * Used for numbered pagination. Single Promise.all so the four calls run
 * in parallel.
 */
/**
 * Count for pagination. Honors date-range filters (cheap per-doctype counts)
 * but ignores type/search filters — those would require fetching + post-
 * filtering, which defeats the point of the count. When type or q is set,
 * the caller should hide the "of N" display or treat the number as the
 * pre-filter universe.
 */
async function countRecentTransactions(user, erp, { filters = {} } = {}) {
  const baseFilters = [
    ['company', '=', erp.company],
    ['docstatus', '!=', 2],
  ];
  if (filters.from) baseFilters.push(['posting_date', '>=', filters.from]);
  if (filters.to) baseFilters.push(['posting_date', '<=', filters.to]);

  const callCount = (doctype) =>
    erp.callMethod('frappe.client.get_count', { doctype, filters: baseFilters });

  const [si, pi, pe, je] = await Promise.all([
    callCount('Sales Invoice'),
    callCount('Purchase Invoice'),
    callCount('Payment Entry'),
    callCount('Journal Entry'),
  ]);

  return (
    (Number(si.message) || 0) +
    (Number(pi.message) || 0) +
    (Number(pe.message) || 0) +
    (Number(je.message) || 0)
  );
}

module.exports = { listRecentTransactions, countRecentTransactions };
