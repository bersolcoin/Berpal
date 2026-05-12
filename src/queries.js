const { query } = require('./db');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(fromIsoDate, toIsoDate) {
  const a = new Date(fromIsoDate);
  const b = new Date(toIsoDate);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.floor((b - a) / 86400000);
}

async function findCounterpartiesByTerm(userId, term) {
  if (!term) return [];
  const like = `%${term.toLowerCase()}%`;
  const result = await query(
    `SELECT id, name, nickname, phone, email
     FROM counterparties
     WHERE owner_user_id = $1
       AND (
         LOWER(name) LIKE $2
         OR LOWER(COALESCE(nickname, '')) LIKE $2
         OR phone = $3
       )
     ORDER BY id ASC`,
    [userId, like, term]
  );
  return result.rows;
}

function typeFilterClause(direction) {
  if (direction === 'receivable') return ['invoice_issued', 'advance_given'];
  if (direction === 'payable') return ['bill_received', 'advance_received'];
  return ['invoice_issued', 'bill_received', 'advance_given', 'advance_received'];
}

async function getOpenInvoices(userId, {
  direction = 'both',
  counterparty_search = null,
  counterparty_id = null,
  sort = 'due_date_asc',
  limit = 5,
} = {}) {
  const types = typeFilterClause(direction);

  const conditions = ['tx.created_by_user_id = $1'];
  const params = [userId];
  let p = 1;

  const typesPlaceholders = types.map(() => `$${++p}`).join(',');
  conditions.push(`tx.transaction_type IN (${typesPlaceholders})`);
  params.push(...types);

  conditions.push("tx.payment_status IN ('unpaid', 'partial', 'overdue')");

  if (counterparty_id) {
    p++;
    conditions.push(`tx.counterparty_id = $${p}`);
    params.push(counterparty_id);
  } else if (counterparty_search) {
    const cps = await findCounterpartiesByTerm(userId, counterparty_search);
    if (cps.length === 0) {
      return {
        matches: [],
        total_count: 0,
        totals_by_currency: [],
        counterparty_search_failed: true,
        search: counterparty_search,
      };
    }
    const cpPlaceholders = cps.map(() => `$${++p}`).join(',');
    conditions.push(`tx.counterparty_id IN (${cpPlaceholders})`);
    params.push(...cps.map((c) => c.id));
  }

  const whereClause = conditions.join(' AND ');

  // Aggregate query — totals + count per currency, NOT limited
  const aggResult = await query(
    `SELECT tx.currency,
            COUNT(*)::int AS count,
            SUM(tx.amount - COALESCE(tx.paid_amount, 0)) AS total_outstanding
     FROM transactions tx
     WHERE ${whereClause}
     GROUP BY tx.currency`,
    params
  );
  const totals_by_currency = aggResult.rows;
  const total_count = totals_by_currency.reduce((s, r) => s + r.count, 0);

  let orderBy;
  switch (sort) {
    case 'due_date_desc':
      orderBy = 'tx.due_date DESC NULLS LAST, tx.id DESC';
      break;
    case 'amount_desc':
      orderBy = '(tx.amount - COALESCE(tx.paid_amount, 0)) DESC, tx.id DESC';
      break;
    case 'amount_asc':
      orderBy = '(tx.amount - COALESCE(tx.paid_amount, 0)) ASC, tx.id ASC';
      break;
    case 'due_date_asc':
    default:
      orderBy = 'tx.due_date ASC NULLS LAST, tx.id ASC';
  }

  p++;
  const limitPlaceholder = `$${p}`;
  params.push(limit);

  const rowsResult = await query(
    `SELECT
       tx.id, tx.transaction_type, tx.transaction_date, tx.due_date,
       tx.amount, tx.currency, tx.payment_status, tx.paid_amount,
       tx.invoice_number, tx.description, tx.payment_terms,
       cp.name AS counterparty_name, cp.nickname AS counterparty_nickname,
       p.base_amount, p.base_currency, p.exchange_rate
     FROM transactions tx
     LEFT JOIN counterparties cp ON tx.counterparty_id = cp.id
     LEFT JOIN transaction_postings p
       ON p.transaction_id = tx.id AND p.party_user_id = tx.created_by_user_id
     WHERE ${whereClause}
     ORDER BY ${orderBy}
     LIMIT ${limitPlaceholder}`,
    params
  );

  const rows = rowsResult.rows;
  const today = todayStr();
  for (const r of rows) {
    r.outstanding_amount = (r.amount || 0) - (r.paid_amount || 0);
    if (r.due_date) {
      const d = daysBetween(today, r.due_date);
      r.days_until_due = d;
      r.is_overdue = d !== null && d < 0;
    } else {
      r.days_until_due = null;
      r.is_overdue = false;
    }
  }

  return {
    matches: rows,
    total_count,
    totals_by_currency,
    truncated: total_count > rows.length,
    sort_used: sort,
  };
}

async function getBalanceWithCounterparty(userId, { counterparty_search = null, counterparty_id = null } = {}) {
  let cp;

  if (counterparty_id) {
    const cpRes = await query(
      `SELECT id, name, nickname, phone FROM counterparties WHERE id = $1 AND owner_user_id = $2`,
      [counterparty_id, userId]
    );
    if (cpRes.rowCount === 0) return { error: 'counterparty_not_found', counterparty_id };
    cp = cpRes.rows[0];
  } else {
    if (!counterparty_search) return { error: 'counterparty_search_or_id_required' };
    const cps = await findCounterpartiesByTerm(userId, counterparty_search);
    if (cps.length === 0) {
      return { error: 'counterparty_not_found', search: counterparty_search };
    }
    if (cps.length > 1) {
      return {
        error: 'multiple_matches',
        matches: cps.map((c) => ({ id: c.id, name: c.name, nickname: c.nickname, phone: c.phone })),
      };
    }
    cp = cps[0];
  }

  const receivableResult = await query(
    `SELECT currency, SUM(amount - COALESCE(paid_amount, 0)) AS balance, COUNT(*) AS count
     FROM transactions
     WHERE created_by_user_id = $1 AND counterparty_id = $2
       AND transaction_type IN ('invoice_issued', 'advance_given')
       AND payment_status IN ('unpaid', 'partial', 'overdue')
     GROUP BY currency`,
    [userId, cp.id]
  );

  const payableResult = await query(
    `SELECT currency, SUM(amount - COALESCE(paid_amount, 0)) AS balance, COUNT(*) AS count
     FROM transactions
     WHERE created_by_user_id = $1 AND counterparty_id = $2
       AND transaction_type IN ('bill_received', 'advance_received')
       AND payment_status IN ('unpaid', 'partial', 'overdue')
     GROUP BY currency`,
    [userId, cp.id]
  );

  return {
    counterparty: { id: cp.id, name: cp.name, nickname: cp.nickname, phone: cp.phone },
    receivable_by_currency: receivableResult.rows,
    payable_by_currency: payableResult.rows,
  };
}

async function getUpcoming(userId, { days_ahead = 7, direction = 'both' } = {}) {
  const today = new Date();
  const future = new Date(today);
  future.setDate(future.getDate() + days_ahead);
  const todayIso = today.toISOString().slice(0, 10);
  const futureIso = future.toISOString().slice(0, 10);

  const types = typeFilterClause(direction);
  const params = [userId, ...types, futureIso];
  const typesPlaceholders = types.map((_, i) => `$${i + 2}`).join(',');
  const futurePlaceholder = `$${types.length + 2}`;

  const result = await query(
    `SELECT
      tx.id, tx.transaction_type, tx.transaction_date, tx.due_date,
      tx.amount, tx.currency, tx.payment_status, tx.paid_amount,
      tx.invoice_number,
      cp.name AS counterparty_name, cp.nickname AS counterparty_nickname
    FROM transactions tx
    LEFT JOIN counterparties cp ON tx.counterparty_id = cp.id
    WHERE tx.created_by_user_id = $1
      AND tx.transaction_type IN (${typesPlaceholders})
      AND tx.payment_status IN ('unpaid', 'partial', 'overdue')
      AND tx.due_date IS NOT NULL
      AND tx.due_date <= ${futurePlaceholder}
    ORDER BY tx.due_date ASC`,
    params
  );

  const rows = result.rows;
  for (const r of rows) {
    r.outstanding_amount = (r.amount || 0) - (r.paid_amount || 0);
    r.days_until_due = daysBetween(todayIso, r.due_date);
    r.is_overdue = r.days_until_due !== null && r.days_until_due < 0;
  }

  return { upcoming: rows };
}

async function getTransactionSummary(userId, {
  direction = 'all',
  date_from = null,
  date_to = null,
  category_code = null,
  counterparty_search = null,
  counterparty_id = null,
  group_by = 'none',
} = {}) {
  const conditions = ['created_by_user_id = $1'];
  const params = [userId];
  let p = 1;

  // payment-type rows are settlements — exclude from spend/income totals
  conditions.push("transaction_type != 'payment'");
  // Equity entries (opening balance, owner contributions, retained earnings) are NOT income/expense.
  conditions.push("(category_code IS NULL OR category_code NOT IN ('3000', '3100', '3200'))");

  if (direction === 'expense') conditions.push("direction = 'expense'");
  else if (direction === 'income') conditions.push("direction = 'income'");

  if (date_from) {
    p++;
    conditions.push(`transaction_date >= $${p}`);
    params.push(date_from);
  }
  if (date_to) {
    p++;
    conditions.push(`transaction_date <= $${p}`);
    params.push(date_to);
  }
  if (category_code) {
    p++;
    conditions.push(`category_code = $${p}`);
    params.push(category_code);
  }
  if (counterparty_id) {
    p++;
    conditions.push(`counterparty_id = $${p}`);
    params.push(counterparty_id);
  } else if (counterparty_search) {
    const cps = await findCounterpartiesByTerm(userId, counterparty_search);
    if (cps.length === 0) {
      return { totals: [], counterparty_search_failed: true, search: counterparty_search };
    }
    const cpPlaceholders = cps.map(() => `$${++p}`).join(',');
    conditions.push(`counterparty_id IN (${cpPlaceholders})`);
    params.push(...cps.map((c) => c.id));
  }

  let groupCols = 'currency, direction';
  let selectExtras = '';

  if (group_by === 'category') {
    groupCols = 'currency, direction, category_code';
    selectExtras = ', category_code';
  } else if (group_by === 'counterparty') {
    groupCols = 'currency, direction, counterparty_id';
    selectExtras = ', counterparty_id';
  } else if (group_by === 'month') {
    groupCols = "currency, direction, SUBSTRING(transaction_date, 1, 7)";
    selectExtras = ', SUBSTRING(transaction_date, 1, 7) AS month';
  }

  const result = await query(
    `SELECT currency, direction, SUM(amount) AS total, COUNT(*) AS count${selectExtras}
     FROM transactions
     WHERE ${conditions.join(' AND ')}
     GROUP BY ${groupCols}
     ORDER BY currency, direction`,
    params
  );

  // If grouped by counterparty, hydrate counterparty names for the LLM's reply
  if (group_by === 'counterparty' && result.rows.length > 0) {
    const ids = [...new Set(result.rows.map((r) => r.counterparty_id).filter(Boolean))];
    if (ids.length > 0) {
      const cpRes = await query(
        `SELECT id, name, nickname FROM counterparties WHERE id = ANY($1::int[])`,
        [ids]
      );
      const byId = Object.fromEntries(cpRes.rows.map((c) => [c.id, c]));
      for (const r of result.rows) {
        const cp = byId[r.counterparty_id];
        r.counterparty_name = cp?.name || null;
        r.counterparty_nickname = cp?.nickname || null;
      }
    }
  }

  return {
    totals: result.rows,
    filters: { direction, date_from, date_to, category_code, counterparty_search, group_by },
  };
}

module.exports = {
  getOpenInvoices,
  getBalanceWithCounterparty,
  getUpcoming,
  getTransactionSummary,
  findCounterpartiesByTerm,
};
