'use client';

/**
 * The inventory list: summary blocks, then search + Sort & filter + view
 * switch + Columns, active-filter tags, then the lots — as a table or as
 * cards. Mobile is always cards; desktop can switch (saved per person).
 *
 * Table: Photo + code pinned left, Selling price + Status pinned right,
 * header row sticks while scrolling. Headers work like Excel — click the
 * name to sort (A→Z, Z→A, off); the funnel opens a pop-up with just that
 * column's sort + filter. The Sort & filter panel (FilterPanel) holds every filter at
 * once. All state lives in the URL (grid.js), so they always agree.
 *
 * Infinite scroll: the page renders the first lots, more load from
 * /api/inventory as you near the bottom. "Showing N of M" floats at the
 * bottom while more can load, and sits under the list once all are
 * loaded. Opening a lot and coming back restores the loaded lots and
 * scroll position (sessionStorage). Columns chooser + view are saved per
 * person (/api/me/prefs).
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Columns,
  Check,
  SlidersHorizontal,
  Table as TableIcon,
  SquaresFour,
  Funnel,
  ArrowUp,
  ArrowDown,
} from '@phosphor-icons/react';
import SearchBox from '../_components/SearchBox';
import { COLUMN_GROUPS, ALL_COLUMNS, DEFAULT_COLUMNS } from './columns';
import { cell, num } from './cells';
import InventoryCards from './InventoryCards';
import FilterPanel, { FilterChips } from './FilterPanel';
import { parseGridState, gridQuery, activeFilterCount } from './grid';

const VIEW_KEY = 'inventory-view';

function savePrefs(patch) {
  return fetch('/api/me/prefs', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).catch(() => {});
}

export default function InventoryTable({ rows: firstRows, total, pageSize, facets, initialColumns, initialView, totals, currency, abbr }) {
  const router = useRouter();
  const params = useSearchParams();
  const state = parseGridState(params);
  const qs = new URLSearchParams(gridQuery(state)).toString();
  const [visible, setVisible] = useState(initialColumns);
  const cols = ALL_COLUMNS.filter((c) => visible.includes(c.key));
  const ctx = { currency, abbr };

  const [view, setView] = useState(initialView); // desktop only — mobile is always cards
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterCol, setFilterCol] = useState(null); // header funnel → that column only
  const [rows, setRows] = useState(firstRows);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const scroller = useRef(null);
  const sentinel = useRef(null); // end of the table (scrolls inside its box)
  const cardSentinel = useRef(null); // end of the cards (scroll with the page)
  const busy = useRef(false);
  const hasMore = rows.length < total;

  async function fetchRows(offset, limit) {
    const res = await fetch(`/api/inventory?${qs}${qs ? '&' : ''}offset=${offset}&limit=${limit}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    return data.rows;
  }

  async function loadMore() {
    if (busy.current || !hasMore) return;
    busy.current = true;
    setLoading(true);
    setFailed(false);
    try {
      const more = await fetchRows(rows.length, pageSize);
      setRows((cur) => [...cur, ...more.filter((m) => !cur.some((c) => c.name === m.name))]);
    } catch {
      setFailed(true);
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }

  // Load the next batch when the bottom of the list comes near. Whichever
  // view is hidden (display: none) never intersects, so only the visible
  // one triggers.
  useEffect(() => {
    if (!hasMore || failed) return;
    const observers = [
      [sentinel.current, scroller.current],
      [cardSentinel.current, null],
    ]
      .filter(([el]) => el)
      .map(([el, root]) => {
        const io = new IntersectionObserver((entries) => entries[0].isIntersecting && loadMore(), { root, rootMargin: '400px' });
        io.observe(el);
        return io;
      });
    return () => observers.forEach((io) => io.disconnect());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, hasMore, failed, view]);

  // Coming back from a lot: reload as many lots as were showing, then scroll back.
  useEffect(() => {
    let saved;
    try {
      saved = JSON.parse(sessionStorage.getItem(VIEW_KEY) || 'null');
      sessionStorage.removeItem(VIEW_KEY);
    } catch {
      return;
    }
    if (!saved || saved.qs !== qs) return;
    const restore = () =>
      requestAnimationFrame(() => {
        if (scroller.current) scroller.current.scrollTop = saved.top || 0;
        window.scrollTo(0, saved.winY || 0);
      });
    const missing = Math.min(saved.count, total) - firstRows.length;
    if (missing <= 0) return restore();
    busy.current = true;
    fetchRows(firstRows.length, missing)
      .then((more) => setRows([...firstRows, ...more]))
      .catch(() => {})
      .finally(() => {
        busy.current = false;
        restore();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openLot = (r) => {
    try {
      sessionStorage.setItem(
        VIEW_KEY,
        JSON.stringify({ qs, count: rows.length, top: scroller.current?.scrollTop || 0, winY: window.scrollY })
      );
    } catch {}
    router.push(`/inventory/${encodeURIComponent(r.item_code)}`);
  };

  // Any change to sort / filters goes back to page 1.
  const go = (next) => {
    const qs = new URLSearchParams(gridQuery(next)).toString();
    router.push(qs ? `/inventory?${qs}` : '/inventory');
  };
  const filters = activeFilterCount(state);
  const switchView = (v) => {
    setView(v);
    savePrefs({ inventory_view: v });
  };
  const loadMoreRow = hasMore && (
    <div className="flex items-center justify-center h-14 text-sm text-slate-400">
      {failed ? (
        <button type="button" onClick={loadMore} className="text-[var(--color-brand-accent)] hover:underline">
          Couldn't load more — try again
        </button>
      ) : (
        'Loading more…'
      )}
    </div>
  );

  return (
    <div>
      <Summary totals={totals} />

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex-1 min-w-0 sm:flex-none">
          <SearchBox placeholder="Search code, name or variety…" />
        </div>
        <button
          type="button"
          onClick={() => setFiltersOpen(true)}
          // Desktop table filters from the column funnels — this button is for
          // cards (mobile, or desktop in Cards view), which have no headers.
          className={`inline-flex items-center gap-1.5 h-9 px-3 text-sm rounded-lg border bg-white transition ${
            filters ? 'border-slate-900 text-slate-900 font-medium' : 'border-slate-300 text-slate-700 hover:border-slate-500'
          } ${view === 'table' ? 'md:hidden' : ''}`}
        >
          <SlidersHorizontal size={15} />
          <span className="hidden sm:inline">Sort &amp; filter</span>
          {filters > 0 && (
            <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-[var(--color-brand-accent)] text-white text-[11px] inline-flex items-center justify-center tabular">
              {filters}
            </span>
          )}
        </button>
        {/* Columns only shape the table (desktop, Table view) — it takes the
            slot right after search that Sort & filter has for cards. */}
        {view === 'table' && (
          <div className="hidden md:block">
            <ColumnChooser visible={visible} onChange={setVisible} />
          </div>
        )}
        {/* Desktop only — on mobile an empty box here would still add a gap. */}
        <div className="hidden md:flex ml-auto items-center gap-2">
          <div className="inline-flex h-9 p-0.5 rounded-lg border border-slate-300 bg-white">
            {[
              ['table', 'Table', TableIcon],
              ['cards', 'Cards', SquaresFour],
            ].map(([v, label, Icon]) => (
              <button
                key={v}
                type="button"
                onClick={() => switchView(v)}
                aria-pressed={view === v}
                title={`${label} view`}
                className={`inline-flex items-center gap-1.5 px-2.5 text-sm rounded-md ${
                  view === v ? 'bg-slate-900 text-white' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Icon size={15} />
                <span className="hidden lg:inline">{label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <FilterChips state={state} go={go} />

      <FilterPanel
        open={filtersOpen || !!filterCol}
        only={filterCol}
        onClose={() => {
          setFiltersOpen(false);
          setFilterCol(null);
        }}
        state={state}
        facets={facets}
        onApply={(next) => {
          setFiltersOpen(false);
          setFilterCol(null);
          go(next);
        }}
      />

      {/* Cards: always on mobile; on desktop when chosen. */}
      <div className={view === 'cards' ? '' : 'md:hidden'}>
        <InventoryCards rows={rows} ctx={ctx} onOpen={openLot} />
        {hasMore && <div ref={cardSentinel}>{loadMoreRow}</div>}
        {total > 0 && (
          <div className={`flex justify-center mt-3 ${hasMore ? 'sticky bottom-4 pointer-events-none' : ''}`}>
            <Counter shown={rows.length} total={total} loading={loading} />
          </div>
        )}
      </div>

      {/* Table: desktop only. */}
      {view === 'table' && (
      <div className="hidden md:block">
      <div className="relative">
      <div ref={scroller} className="overflow-auto max-h-[calc(100dvh-6rem)] border border-[var(--color-border)] rounded-xl bg-white">
        <table className="w-full text-sm border-separate border-spacing-0">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--color-ink-muted)]">
              {cols.map((c) => (
                <th
                  key={c.key}
                  className={`font-medium px-3 py-2 whitespace-nowrap border-b border-[var(--color-border)] sticky top-0 ${
                    c.key === state.sort ? 'bg-blue-100 text-slate-900' : 'bg-slate-50'
                  } ${alignClass(c)} ${pinClass(c, cols, true)}`}
                >
                  {c.key === 'image' ? (
                    <span className="sr-only">Photo</span>
                  ) : (
                    <HeaderCell col={c} state={state} go={go} onFilter={setFilterCol} />
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.name}
                onClick={() => openLot(r)}
                className="group cursor-pointer"
              >
                {cols.map((c) => (
                  <td
                    key={c.key}
                    className={`px-3 py-1.5 whitespace-nowrap border-b border-[var(--color-border)] text-slate-700 tabular ${
                      c.key === state.sort ? 'bg-blue-50 group-hover:bg-blue-100' : 'bg-white group-hover:bg-slate-50'
                    } ${alignClass(c)} ${pinClass(c, cols)}`}
                  >
                    {cell(c.key, r, ctx)}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={cols.length} className="px-3 py-8 text-center text-slate-500">No lots match.</td>
              </tr>
            )}
          </tbody>
        </table>
        {hasMore && <div ref={sentinel}>{loadMoreRow}</div>}
      </div>
      {/* More to load: floats centred over the table's bottom edge. */}
      {hasMore && (
        <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-3 z-30">
          <Counter shown={rows.length} total={total} loading={loading} />
        </div>
      )}
      </div>
      {/* All loaded: sits under the table so it never covers the last row. */}
      {!hasMore && total > 0 && (
        <div className="flex justify-center mt-3">
          <Counter shown={rows.length} total={total} />
        </div>
      )}
      </div>
      )}
    </div>
  );
}

function Counter({ shown, total, loading }) {
  return (
    <div className="inline-flex items-center gap-2 h-8 px-3.5 rounded-full bg-white/95 border border-slate-200 text-slate-600 text-xs shadow-md tabular">
      {loading && <span className="w-3 h-3 rounded-full border-2 border-slate-200 border-t-slate-500 animate-spin" />}
      Showing {shown.toLocaleString()} of {total.toLocaleString()}
    </div>
  );
}

/** Totals for everything matching search + filters (all pages), as blocks under the title. */
function Summary({ totals }) {
  // [full label, short label (mobile), value]
  const blocks = [
    ['Lots', 'Lots', totals.lots.toLocaleString()],
    ['In stock', 'In stock', totals.in_stock.toLocaleString()],
    ['Carats on hand', 'Carats', `${num(totals.qty)} ct`],
    ['Pieces on hand', 'Pieces', totals.pieces.toLocaleString()],
  ];
  // One block split into four by dividers — a single compact row on mobile.
  return (
    <div className="grid grid-cols-4 divide-x divide-[var(--color-border)] bg-white border border-[var(--color-border)] rounded-xl mb-4 md:mb-5">
      {blocks.map(([label, short, value]) => (
        <div key={label} className="min-w-0 px-2.5 py-2 md:px-5 md:py-3.5">
          <div className="text-[11px] md:text-xs text-[var(--color-ink-muted)] truncate">
            <span className="md:hidden">{short}</span>
            <span className="hidden md:inline">{label}</span>
          </div>
          <div className="md:mt-1 text-sm md:text-2xl font-semibold text-slate-900 tabular truncate">{value}</div>
        </div>
      ))}
    </div>
  );
}

const alignClass = (c) => (c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : '');

/**
 * Pinned columns: Photo + Code on the left; Selling price + Status on the
 * right edge. Status is 120px wide so Selling price pins at right-[120px].
 * Header cells (head = true) also stick to the top, so they layer above the
 * body: plain headers z-10, pinned headers (corners) z-20, pinned body z-[5].
 * (Literal class names — Tailwind can't see classes built at runtime.)
 */
function pinClass(c, cols, head = false) {
  const z = head ? 'z-20' : 'z-[5]';
  if (c.key === 'image') return `sticky left-0 ${z} w-[60px] min-w-[60px]`;
  if (c.key === 'code') return `sticky left-[60px] ${z} border-r border-r-[var(--color-border)]`;
  if (c.key === 'status') {
    const alone = !cols.some((x) => x.key === 'selling_price');
    return `sticky right-0 ${z} w-[120px] min-w-[120px] ${alone ? 'border-l border-l-[var(--color-border)]' : ''}`;
  }
  if (c.key === 'selling_price') return `sticky right-[120px] ${z} w-[140px] min-w-[140px] border-l border-l-[var(--color-border)]`;
  return head ? 'z-10' : '';
}

/** Column name (click = sort A→Z, Z→A, off) + funnel (opens this column's sort / filter pop-up). */
function HeaderCell({ col, state, go, onFilter }) {
  const sorted = state.sort === col.key ? state.dir : null;
  const filtered = col.filter === 'list' ? state.list[col.key]?.length > 0 : !!state.range[col.key];

  const cycleSort = () =>
    go(
      sorted === 'asc'
        ? { ...state, dir: 'desc' }
        : sorted === 'desc'
          ? { ...state, sort: '', dir: 'asc' }
          : { ...state, sort: col.key, dir: 'asc' }
    );

  return (
    // Block-level flex with a fixed height, so every header lines up on the
    // same middle line whatever it holds (label only, label + funnel).
    <div
      className={`flex items-center h-6 gap-1 ${
        // Right-aligned: reversed, so it starts from the right edge (funnel outermost).
        col.align === 'right' ? 'flex-row-reverse' : col.align === 'center' ? 'justify-center' : ''
      }`}
    >
      {col.type ? (
        <button
          type="button"
          onClick={cycleSort}
          title="Sort"
          className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-slate-900 ${sorted ? 'text-slate-900' : ''}`}
        >
          {col.label}
          {sorted === 'asc' && <ArrowUp size={11} weight="bold" />}
          {sorted === 'desc' && <ArrowDown size={11} weight="bold" />}
        </button>
      ) : (
        <span>{col.label}</span>
      )}
      {col.filter && (
        <button
          type="button"
          onClick={() => onFilter(col.key)}
          title="Sort & filter"
          aria-label={`Filter ${col.label}`}
          className={`flex items-center justify-center w-5 h-5 rounded hover:bg-slate-200 ${filtered ? 'text-[var(--color-brand-accent)]' : 'text-slate-400 hover:text-slate-700'}`}
        >
          <Funnel size={12} weight={filtered ? 'fill' : 'regular'} />
        </button>
      )}
    </div>
  );
}

function ColumnChooser({ visible, onChange }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);
  const timer = useRef(null);

  useEffect(() => {
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Save shortly after the last change (several ticks → one request).
  function persist(next) {
    onChange(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setSaving(true);
      try {
        await fetch('/api/me/prefs', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inventory_columns: next }),
        });
      } finally {
        setSaving(false);
      }
    }, 500);
  }

  const toggle = (key) => persist(visible.includes(key) ? visible.filter((k) => k !== key) : [...visible, key]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 h-9 px-3 text-sm rounded-lg border border-slate-300 bg-white text-slate-700 hover:border-slate-500 transition"
      >
        <Columns size={15} /> Columns
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-2 w-72 max-h-[70vh] overflow-auto bg-white border border-slate-200 rounded-xl shadow-lg p-3">
          {COLUMN_GROUPS.map((g) => (
            <div key={g.label} className="mb-3 last:mb-1">
              <div className="text-[11px] uppercase tracking-wide text-[var(--color-ink-muted)] mb-1.5">{g.label}</div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                {g.columns.map((c) => {
                  const on = c.locked || visible.includes(c.key);
                  return (
                    <label
                      key={c.key}
                      className={`flex items-center gap-2 px-1.5 py-1 rounded-md text-sm ${c.locked ? 'text-slate-400' : 'text-slate-700 hover:bg-slate-50 cursor-pointer'}`}
                    >
                      <span
                        className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                          on ? 'bg-slate-900 border-slate-900 text-white' : 'border-slate-300 bg-white'
                        } ${c.locked ? 'opacity-50' : ''}`}
                      >
                        {on && <Check size={11} weight="bold" />}
                      </span>
                      <input type="checkbox" className="sr-only" checked={on} disabled={c.locked} onChange={() => toggle(c.key)} />
                      {c.label}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between pt-2 border-t border-slate-100">
            <button type="button" onClick={() => persist(DEFAULT_COLUMNS)} className="text-xs text-[var(--color-brand-accent)] hover:underline">
              Reset to default
            </button>
            <span className="text-xs text-slate-400">{saving ? 'Saving…' : 'Saved to your account'}</span>
          </div>
        </div>
      )}
    </div>
  );
}
