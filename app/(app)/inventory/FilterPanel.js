'use client';

/**
 * Sort & filter panel for the inventory — a centred pop-up on desktop, a
 * full-screen drawer on mobile. Works on a draft: nothing changes until
 * "Show N lots" (N is counted live from /api/inventory as you tick).
 *
 * `only` (a column key): the same pop-up for just that column's filter
 * (no sort — clicking the header name sorts). Opened from a table
 * header's funnel.
 *
 * Sort: column + direction. Filters: text columns tick values — chips
 * for short lists, a searchable multi-select dropdown for long ones;
 * number columns take min / max. Sections with a single
 * value (nothing to choose between) are hidden unless already filtered.
 * Same URL state as the column-header funnels (grid.js), so both always
 * agree.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Check, CaretDown } from '@phosphor-icons/react';
import { ALL_COLUMNS } from './columns';
import { gridQuery, activeFilterCount, BLANK } from './grid';

const FILTER_COLS = [
  ...ALL_COLUMNS.filter((c) => c.key === 'status'),
  ...ALL_COLUMNS.filter((c) => c.filter && c.key !== 'status'),
];
const SORT_COLS = ALL_COLUMNS.filter((c) => c.type);
const SORT_WORDS = {
  text: ['A → Z', 'Z → A'],
  number: ['Low → high', 'High → low'],
  date: ['Oldest first', 'Newest first'],
};
// Up to this many values: tappable chips. More: a multi-select dropdown
// (search + checkboxes) — catalogs grow, chips don't scale.
const CHIP_MAX = 6;

export default function FilterPanel({ open, onClose, state, facets, onApply, only = null }) {
  const single = only ? ALL_COLUMNS.find((c) => c.key === only) : null;
  const [draft, setDraft] = useState(state);
  const [count, setCount] = useState(null);

  // Fresh draft each time it opens.
  useEffect(() => {
    if (open) setDraft(state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Live "Show N lots" for the draft (debounced).
  useEffect(() => {
    if (!open) return;
    setCount(null);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const qs = new URLSearchParams(gridQuery(draft)).toString();
        const res = await fetch(`/api/inventory?${qs}${qs ? '&' : ''}limit=0`, { signal: ctrl.signal });
        const data = await res.json();
        if (data.ok) setCount(data.total);
      } catch {}
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [open, draft]);

  // Escape closes; the page behind doesn't scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  const setList = (key, vals) => setDraft((d) => {
    const list = { ...d.list };
    if (vals.length) list[key] = vals;
    else delete list[key];
    return { ...d, list };
  });
  const setRange = (key, r) => setDraft((d) => {
    const range = { ...d.range };
    if (r.min == null && r.max == null) delete range[key];
    else range[key] = r;
    return { ...d, range };
  });
  const clearAll = () =>
    single
      ? setDraft((d) => {
          const list = { ...d.list };
          const range = { ...d.range };
          delete list[single.key];
          delete range[single.key];
          return { ...d, list, range };
        })
      : setDraft((d) => ({ ...d, list: {}, range: {}, sort: '', dir: 'asc' }));
  const changed = single
    ? (draft.list[single.key]?.length ? 1 : 0) + (draft.range[single.key] ? 1 : 0)
    : activeFilterCount(draft) + (draft.sort ? 1 : 0);
  const cols = single ? [single] : FILTER_COLS;
  // A value filter with one value has nothing to choose — hidden in the full panel unless in use.
  const listCols = cols.filter(
    (c) => c.filter === 'list' && (single || (facets[c.key] || []).length > 1 || draft.list[c.key]?.length)
  );
  const rangeCols = cols.filter((c) => c.filter === 'range');

  return createPortal(
    <div className="fixed inset-0 z-50 flex md:items-center md:justify-center md:p-6" role="dialog" aria-modal="true" aria-label="Sort and filter">
      <div className="hidden md:block absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div
        className={`relative flex flex-col w-full h-full md:h-auto md:max-h-[85vh] ${
          single ? 'md:max-w-lg' : 'md:max-w-3xl'
        } bg-white md:rounded-2xl md:shadow-2xl overflow-hidden`}
      >
        <div className="flex items-center justify-between h-14 px-4 md:px-6 border-b border-slate-100 shrink-0">
          <h2 className="text-base font-semibold text-slate-900">{single ? single.label : <>Sort &amp; filter</>}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-2 -mr-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4 space-y-6">
          {/* Single column: no sort here — clicking the header name sorts. */}
          {!single && <SortSection draft={draft} setDraft={setDraft} />}
          {/* Value filters — two per row on desktop, like the number ranges.
              Each block renders only when it has something (an empty one
              would still add the vertical gap). */}
          {listCols.length > 0 && (
            <div className={`grid gap-6 items-start ${single ? '' : 'md:grid-cols-2'}`}>
              {listCols.map((c) => (
                <ListSection
                  key={c.key}
                  col={c}
                  facet={facets[c.key] || []}
                  ticked={draft.list[c.key] || []}
                  onChange={(v) => setList(c.key, v)}
                  single={!!single}
                />
              ))}
            </div>
          )}
          {/* Number ranges — two per row on desktop. */}
          {rangeCols.length > 0 && (
            <div className={`grid gap-6 ${single ? '' : 'md:grid-cols-2'}`}>
              {rangeCols.map((c) => (
                <RangeSection key={c.key} col={c} value={draft.range[c.key]} onChange={(r) => setRange(c.key, r)} single={!!single} />
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 px-4 md:px-6 py-3 border-t border-slate-100 shrink-0 bg-white">
          <button
            type="button"
            onClick={clearAll}
            disabled={!changed}
            className="h-11 px-4 text-sm font-medium text-slate-600 rounded-lg hover:bg-slate-100 disabled:opacity-40"
          >
            {single ? 'Clear' : 'Clear all'}
          </button>
          <button
            type="button"
            onClick={() => onApply(draft)}
            className="flex-1 md:flex-none md:ml-auto md:min-w-[180px] h-11 px-5 text-sm font-medium rounded-lg bg-slate-900 text-white hover:bg-slate-800 tabular"
          >
            {count == null ? 'Show lots' : count === 1 ? 'Show 1 lot' : `Show ${count.toLocaleString()} lots`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// title = null: no heading (single-column pop-up — the header already names it).
function Section({ title, badge, children }) {
  if (title == null) return <section>{children}</section>;
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-sm font-medium text-slate-900">{title}</h3>
        {badge ? (
          <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-[var(--color-brand-accent)] text-white text-[11px] font-medium inline-flex items-center justify-center tabular">
            {badge}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function SortSection({ draft, setDraft }) {
  const col = SORT_COLS.find((c) => c.key === draft.sort);
  const [asc, desc] = SORT_WORDS[col?.type] || SORT_WORDS.text;
  return (
    <Section title="Sort by">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={draft.sort}
          onChange={(e) => setDraft((d) => ({ ...d, sort: e.target.value, dir: 'asc' }))}
          className="h-10 pl-3 pr-8 text-sm border border-slate-300 rounded-lg bg-white outline-none focus:border-slate-500 select-arrow"
        >
          <option value="">Newest added</option>
          {SORT_COLS.map((c) => (
            <option key={c.key} value={c.key}>{c.label}</option>
          ))}
        </select>
        {col && (
          <div className="inline-flex h-10 p-1 rounded-lg bg-slate-100">
            {[
              ['asc', asc],
              ['desc', desc],
            ].map(([dir, label]) => (
              <button
                key={dir}
                type="button"
                onClick={() => setDraft((d) => ({ ...d, dir }))}
                className={`px-3 text-sm rounded-md ${draft.dir === dir ? 'bg-white shadow-sm font-medium text-slate-900' : 'text-slate-600'}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}

/** Tick the values to show; none ticked = no filter. Chips for short lists, dropdown for long ones. */
function ListSection({ col, facet, ticked, onChange, single }) {
  const toggle = (v) => onChange(ticked.includes(v) ? ticked.filter((x) => x !== v) : [...ticked, v]);
  return (
    <Section title={single ? null : col.label} badge={ticked.length}>
      {facet.length <= CHIP_MAX ? (
        <div className="flex flex-wrap gap-2">
          {facet.map((f) => {
            const on = ticked.includes(f.value);
            return (
              <button
                key={f.value}
                type="button"
                onClick={() => toggle(f.value)}
                aria-pressed={on}
                className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-full border text-sm transition ${
                  on ? 'bg-slate-900 border-slate-900 text-white' : 'bg-white border-slate-300 text-slate-700 hover:border-slate-500'
                } ${f.value === BLANK && !on ? 'italic text-slate-400' : ''}`}
              >
                {on && <Check size={12} weight="bold" />}
                {f.value}
                <span className={`text-xs tabular ${on ? 'text-white/70' : 'text-slate-400'}`}>{f.count}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <MultiSelect col={col} facet={facet} ticked={ticked} toggle={toggle} onChange={onChange} alwaysOpen={single} />
      )}
    </Section>
  );
}

/**
 * Multi-select dropdown: a field summarising the picks ("Any" / "Oval,
 * Cushion +2"); opens a searchable checkbox list that floats over the
 * panel (portal, fixed position — opens upward when there's no room
 * below). Closes on outside click, Escape or when the panel scrolls.
 * `alwaysOpen` (single-column pop-up): just the list, inline.
 */
function MultiSelect({ col, facet, ticked, toggle, onChange, alwaysOpen = false }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const field = useRef(null);
  const list = useRef(null);
  const summary = !ticked.length
    ? 'Any'
    : ticked.length <= 2
      ? ticked.join(', ')
      : `${ticked.slice(0, 2).join(', ')} +${ticked.length - 2}`;

  const openList = () => {
    const r = field.current.getBoundingClientRect();
    const height = 330; // search + list, roughly
    const below = window.innerHeight - r.bottom;
    setPos(
      below >= height || below >= r.top
        ? { top: r.bottom + 6, left: r.left, width: r.width, maxHeight: Math.max(160, below - 16) }
        : { bottom: window.innerHeight - r.top + 6, left: r.left, width: r.width, maxHeight: Math.max(160, r.top - 16) }
    );
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const inside = (e) => list.current?.contains(e.target) || field.current?.contains(e.target);
    const onDown = (e) => !inside(e) && setOpen(false);
    const onScroll = (e) => !list.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation(); // close the list, not the whole panel
        setOpen(false);
      }
    };
    const onResize = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  if (alwaysOpen) return <ValueList col={col} facet={facet} ticked={ticked} toggle={toggle} />;

  return (
    <>
      <button
        ref={field}
        type="button"
        onClick={() => (open ? setOpen(false) : openList())}
        aria-expanded={open}
        className={`w-full flex items-center gap-2 h-10 px-3 text-sm text-left border rounded-lg bg-white transition ${
          open ? 'border-slate-500' : 'border-slate-300 hover:border-slate-500'
        }`}
      >
        <span className={`flex-1 truncate ${ticked.length ? 'text-slate-900 font-medium' : 'text-slate-400'}`}>{summary}</span>
        {ticked.length > 0 && (
          <span
            role="button"
            tabIndex={0}
            aria-label={`Clear ${col.label}`}
            onClick={(e) => {
              e.stopPropagation();
              onChange([]);
            }}
            className="p-1 rounded text-slate-400 hover:text-slate-900 hover:bg-slate-100"
          >
            <X size={12} weight="bold" />
          </span>
        )}
        <CaretDown size={14} className={`text-slate-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div ref={list} style={pos} className="fixed z-[60] flex flex-col bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden">
            <ValueList col={col} facet={facet} ticked={ticked} toggle={toggle} autoFocus bare />
          </div>,
          document.body
        )}
    </>
  );
}

/** Search box + checkbox list of values with counts. */
// bare: inside the floating dropdown (which has its own border).
function ValueList({ col, facet, ticked, toggle, autoFocus = false, bare = false }) {
  const [find, setFind] = useState('');
  const term = find.trim().toLowerCase();
  const shown = facet.filter((f) => !term || f.value.toLowerCase().includes(term));
  return (
    <div className={`flex flex-col min-h-0 bg-white overflow-hidden ${bare ? '' : 'border border-slate-200 rounded-lg'}`}>
      <div className="p-2 border-b border-slate-100 shrink-0">
        <input
          autoFocus={autoFocus}
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder={`Search ${col.label.toLowerCase()}…`}
          className="w-full h-9 px-3 text-sm border border-slate-300 rounded-md outline-none focus:border-slate-500"
        />
      </div>
      <div className="max-h-64 min-h-0 overflow-y-auto p-1">
        {shown.map((f) => {
          const on = ticked.includes(f.value);
          return (
            <button
              key={f.value}
              type="button"
              onClick={() => toggle(f.value)}
              aria-pressed={on}
              className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left text-sm hover:bg-slate-50 ${
                f.value === BLANK ? 'italic text-slate-400' : 'text-slate-700'
              }`}
            >
              <span
                className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                  on ? 'bg-slate-900 border-slate-900 text-white' : 'border-slate-300 bg-white'
                }`}
              >
                {on && <Check size={11} weight="bold" />}
              </span>
              <span className="flex-1 truncate">{f.value}</span>
              <span className="text-xs text-slate-400 tabular">{f.count}</span>
            </button>
          );
        })}
        {shown.length === 0 && <div className="px-2.5 py-2 text-sm text-slate-400">No matches.</div>}
      </div>
    </div>
  );
}

function RangeSection({ col, value, onChange, single = false }) {
  const [min, setMin] = useState(value?.min ?? '');
  const [max, setMax] = useState(value?.max ?? '');
  const first = useRef(true);
  useEffect(() => {
    // Keep in sync when "Clear all" empties the draft.
    if (first.current) {
      first.current = false;
      return;
    }
    if (!value) {
      setMin('');
      setMax('');
    }
  }, [value]);

  const commit = (lo, hi) => {
    const a = parseFloat(lo);
    const b = parseFloat(hi);
    onChange({ min: Number.isFinite(a) ? a : null, max: Number.isFinite(b) ? b : null });
  };
  const clean = (v) => String(v).replace(/[^\d.]/g, '');
  const input = 'w-full h-10 px-3 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-500 tabular';

  return (
    <Section title={single ? null : col.label} badge={value ? 1 : 0}>
      <div className="flex items-center gap-2">
        <input
          value={min}
          onChange={(e) => {
            const v = clean(e.target.value);
            setMin(v);
            commit(v, max);
          }}
          inputMode="decimal"
          placeholder="Min"
          aria-label={`${col.label} minimum`}
          className={input}
        />
        <span className="text-slate-300">–</span>
        <input
          value={max}
          onChange={(e) => {
            const v = clean(e.target.value);
            setMax(v);
            commit(min, v);
          }}
          inputMode="decimal"
          placeholder="Max"
          aria-label={`${col.label} maximum`}
          className={input}
        />
      </div>
    </Section>
  );
}

const LABEL = Object.fromEntries(ALL_COLUMNS.map((c) => [c.key, c.label.replace(/ \((ct|mm)\)$/, '')]));
const UNIT = { weight: ' ct', meas1: ' mm', meas2: ' mm', meas3: ' mm' };

/** Active filters as removable tags under the search bar, plus "Clear all". */
export function FilterChips({ state, go }) {
  const chips = [
    ...Object.entries(state.list)
      .filter(([, v]) => v?.length)
      .map(([k, v]) => ({
        key: k,
        text: `${LABEL[k]}: ${v.length > 2 ? `${v.slice(0, 2).join(', ')} +${v.length - 2}` : v.join(', ')}`,
        title: v.join(', '),
        remove: () => {
          const list = { ...state.list };
          delete list[k];
          go({ ...state, list });
        },
      })),
    ...Object.entries(state.range).map(([k, r]) => {
      const u = UNIT[k] || '';
      const text = r.min != null && r.max != null ? `${r.min}–${r.max}${u}` : r.min != null ? `≥ ${r.min}${u}` : `≤ ${r.max}${u}`;
      return {
        key: k,
        text: `${LABEL[k]}: ${text}`,
        remove: () => {
          const range = { ...state.range };
          delete range[k];
          go({ ...state, range });
        },
      };
    }),
  ];
  if (!chips.length) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      {chips.map((c) => (
        <span key={c.key} title={c.title} className="inline-flex items-center gap-1 h-8 pl-3 pr-1 rounded-full bg-blue-50 border border-blue-200 text-sm text-slate-800">
          {c.text}
          <button type="button" onClick={c.remove} aria-label={`Remove ${c.text}`} className="p-1 rounded-full text-slate-500 hover:bg-blue-100 hover:text-slate-900">
            <X size={12} weight="bold" />
          </button>
        </span>
      ))}
      <button type="button" onClick={() => go({ ...state, list: {}, range: {} })} className="h-8 px-2 text-sm text-[var(--color-brand-accent)] hover:underline">
        Clear all
      </button>
    </div>
  );
}
