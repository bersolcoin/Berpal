/**
 * Excel-style sort + filter for the inventory table. State lives in the
 * URL so a view can be bookmarked or shared:
 *
 *   ?q=ruby                  search (code, name, variety)
 *   ?sort=weight&dir=desc    sort by a column (dir asc | desc)
 *   ?shape=Oval|Cushion      list filter — ticked values, '|'-separated
 *   ?weight_min=2&weight_max=5   range filter on a number column
 *
 * Plain functions — the server page applies them; the client table uses
 * the same helpers to build URLs.
 */

import { ALL_COLUMNS, STATUS_LABELS } from './columns';

export const BLANK = '(Blanks)';
const SEP = '|';

/** What a list filter / facet sees for a row: display text, '(Blanks)' when empty. */
export function listValue(col, row) {
  const v = row[col.field];
  if (col.key === 'status') return STATUS_LABELS[v] || v;
  if (col.key === 'calibrated') return v ? 'Yes' : 'No';
  return v == null || v === '' ? BLANK : String(v);
}

/** URL params (object from searchParams or URLSearchParams) → grid state. */
export function parseGridState(params) {
  const get = (k) => {
    const v = typeof params.get === 'function' ? params.get(k) : params[k];
    return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : '';
  };
  const state = { q: get('q').trim(), sort: '', dir: 'asc', list: {}, range: {} };
  const sortCol = ALL_COLUMNS.find((c) => c.key === get('sort') && c.type);
  if (sortCol) {
    state.sort = sortCol.key;
    state.dir = get('dir') === 'desc' ? 'desc' : 'asc';
  }
  for (const c of ALL_COLUMNS) {
    if (c.filter === 'list') {
      const raw = get(c.key);
      if (raw) state.list[c.key] = raw.split(SEP).filter(Boolean);
    } else if (c.filter === 'range') {
      const min = parseFloat(get(`${c.key}_min`));
      const max = parseFloat(get(`${c.key}_max`));
      if (Number.isFinite(min) || Number.isFinite(max)) {
        state.range[c.key] = { min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null };
      }
    }
  }
  return state;
}

/** Grid state → flat query object (for links / pagination). */
export function gridQuery(state) {
  const out = {};
  if (state.q) out.q = state.q;
  if (state.sort) {
    out.sort = state.sort;
    if (state.dir === 'desc') out.dir = 'desc';
  }
  for (const [k, vals] of Object.entries(state.list)) if (vals?.length) out[k] = vals.join(SEP);
  for (const [k, r] of Object.entries(state.range)) {
    if (r?.min != null) out[`${k}_min`] = String(r.min);
    if (r?.max != null) out[`${k}_max`] = String(r.max);
  }
  return out;
}

/** Number of columns with an active filter. */
export const activeFilterCount = (state) =>
  Object.values(state.list).filter((v) => v?.length).length + Object.keys(state.range).length;

function passes(col, row, state) {
  if (col.filter === 'list') {
    const vals = state.list[col.key];
    return !vals?.length || vals.includes(listValue(col, row));
  }
  if (col.filter === 'range') {
    const r = state.range[col.key];
    if (!r) return true;
    const n = Number(row[col.field]);
    if (row[col.field] == null || row[col.field] === '' || !Number.isFinite(n)) return false;
    return (r.min == null || n >= r.min) && (r.max == null || n <= r.max);
  }
  return true;
}

const FILTER_COLS = ALL_COLUMNS.filter((c) => c.filter);

/**
 * rows → { rows (filtered + sorted), facets }.
 * facets[key] = [{ value, count }] for each list column, counted over the
 * rows that pass every *other* column's filter (as Excel does), A–Z with
 * (Blanks) last.
 */
export function applyGrid(rows, state) {
  const filtered = rows.filter((r) => FILTER_COLS.every((c) => passes(c, r, state)));

  const facets = {};
  for (const col of FILTER_COLS.filter((c) => c.filter === 'list')) {
    const counts = new Map();
    for (const r of rows) {
      if (!FILTER_COLS.every((c) => c === col || passes(c, r, state))) continue;
      const v = listValue(col, r);
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    // Keep ticked values visible even when nothing matches them any more.
    for (const v of state.list[col.key] || []) if (!counts.has(v)) counts.set(v, 0);
    facets[col.key] = [...counts]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => (a.value === BLANK) - (b.value === BLANK) || a.value.localeCompare(b.value, undefined, { numeric: true }));
  }

  const col = ALL_COLUMNS.find((c) => c.key === state.sort);
  if (col) {
    const sign = state.dir === 'desc' ? -1 : 1;
    const empty = (v) => v == null || v === '' || (col.type === 'number' && !Number.isFinite(Number(v)));
    filtered.sort((a, b) => {
      const va = col.key === 'status' ? listValue(col, a) : a[col.field];
      const vb = col.key === 'status' ? listValue(col, b) : b[col.field];
      // Blanks always last, whichever direction.
      if (empty(va) || empty(vb)) return empty(va) - empty(vb);
      if (col.type === 'number') return sign * (Number(va) - Number(vb));
      return sign * String(va).localeCompare(String(vb), undefined, { numeric: true });
    });
  }
  return { rows: filtered, facets };
}
