'use client';

/**
 * View-only catalog pieces shared by /inventory/settings and
 * /inventory/settings/category/[key]: varieties list, attributes table, request form,
 * requests list. The catalog is admin-only; businesses can only request.
 */

import { useMemo, useState } from 'react';
import { LockSimple, X, Diamond, Watch, Package, Plus, MagnifyingGlass, CaretRight } from '@phosphor-icons/react';

export const input =
  'w-full px-3 py-2 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-500 bg-white';
export const label = 'block text-xs font-medium text-slate-600 mb-1.5';
export const primaryBtn =
  'inline-flex items-center justify-center gap-1 px-3 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition disabled:opacity-50 font-medium';
export const ghostBtn = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border transition';
const linkBtn = 'text-xs text-[var(--color-brand-accent)] hover:underline';
const STATUS = {
  pending: 'bg-amber-50 text-amber-800',
  added: 'bg-emerald-50 text-emerald-700',
  declined: 'bg-slate-100 text-slate-500',
};
const KIND_LABEL = { category: 'Category', variety: 'Variety', option: 'Option', field: 'Attribute' };
const ICONS = { gemstones: Diamond, watches: Watch };

export const categoryIcon = (key) => ICONS[key] || Package;
export const unitWord = (units, uom) => (units[uom] || uom).toLowerCase().replace(/s$/, '');

export async function call(url, method, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

/**
 * Active toggle for a category: a pill with the state label and a switch.
 * Turning off the last active category is refused with a tooltip message
 * (the switch springs back) rather than being silently disabled.
 * onChange(enabled) lets a parent track how many are active.
 */
export function CategoryToggle({ category, othersActive, onChange }) {
  const [on, setOn] = useState(!!category.enabled);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  function flash(msg) {
    setMessage(msg);
    setTimeout(() => setMessage(''), 3500);
  }

  async function flip() {
    if (busy) return;
    setMessage('');
    if (on && othersActive === 0) return flash('At least one category must be active.');
    const next = !on;
    setOn(next);
    setBusy(true);
    try {
      await call(`/api/catalog/roots/${category.id}`, 'PATCH', { enabled: next });
      onChange?.(next);
    } catch (err) {
      setOn(!next);
      flash(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`${category.name}: ${on ? 'active' : 'off'}`}
        onClick={flip}
        className={`inline-flex items-center gap-2.5 h-8 pl-3 pr-1.5 rounded-full border text-xs font-medium transition
          focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-emerald-500 ${
            on
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
              : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
          }`}
      >
        {on ? 'Active' : 'Off'}
        {/* 36×20 track, 16px knob, 2px inset on both sides */}
        <span className={`relative w-9 h-5 rounded-full transition-colors duration-200 ${on ? 'bg-emerald-600' : 'bg-slate-300'}`}>
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
              on ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </span>
      </button>
      {message && (
        <div
          role="alert"
          className="absolute right-0 top-full mt-2 z-20 w-56 rounded-lg bg-slate-900 text-white text-xs leading-snug px-3 py-2 shadow-lg"
        >
          <span className="absolute -top-1 right-5 w-2 h-2 rotate-45 bg-slate-900" aria-hidden="true" />
          {message}
        </div>
      )}
    </div>
  );
}

export function RequestsList({ requests }) {
  if (!requests.length) return null;
  return (
    <section className="bg-white border border-[var(--color-border)] rounded-xl px-5 py-4">
      <h2 className="text-sm font-medium text-slate-700 mb-3">Your requests</h2>
      <ul className="space-y-1.5">
        {requests.map((r) => (
          <li key={r.id} className="flex items-center gap-2 text-sm">
            <span className={`text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded ${STATUS[r.status] || STATUS.pending}`}>
              {r.status}
            </span>
            <span className="text-xs text-slate-400 w-14 shrink-0">{KIND_LABEL[r.kind] || r.kind}</span>
            <span className="text-slate-700 truncate">
              “{r.value}”{r.field_key ? ` · ${r.field_key}` : ''}
            </span>
            {r.note && <span className="text-xs text-slate-400 truncate">— {r.note}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ViewOnlyNote() {
  return (
    <p className="text-xs text-slate-500 flex items-start gap-1.5">
      <LockSimple size={13} className="mt-0.5 shrink-0" />
      Maintained by the Caratpal team so names and options stay consistent across the industry. Missing something? Send a request.
    </p>
  );
}

/** Section toolbar: optional left content, request button top-right. */
function Toolbar({ left, buttonLabel, onRequest, disabled }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex-1 min-w-[200px]">{left}</div>
      <button
        type="button"
        onClick={onRequest}
        disabled={disabled}
        className={`${ghostBtn} border-slate-300 text-slate-700 hover:border-slate-500 disabled:opacity-50 shrink-0`}
      >
        <Plus size={14} weight="bold" /> {buttonLabel}
      </button>
    </div>
  );
}

const th = 'font-medium py-2 pr-3 text-left';

const az = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
// One fixed line box for every tree row (parent, childless parent, child)
// so they're all the same height whatever they contain.
const ROW_LINE = 'flex items-center gap-1 h-6 leading-6';

/**
 * Family › variety tree, A–Z at both levels. A family whose only variety
 * shares its name (Aquamarine) is a single row. Search keeps a family when
 * it or any of its varieties match (matching family → all its varieties).
 */
function buildTree(varieties, q) {
  const term = q.trim().toLowerCase();
  const hit = (x) => (x || '').toLowerCase().includes(term);
  const fams = new Map();
  for (const v of varieties) {
    if (!fams.has(v.family)) fams.set(v.family, []);
    fams.get(v.family).push(v);
  }
  return [...fams.entries()]
    .sort(([a], [b]) => az(a, b))
    .map(([family, list]) => {
      const sorted = [...list].sort((a, b) => az(a.variety, b.variety));
      const kids = !term || hit(family) ? sorted : sorted.filter((v) => hit(v.variety) || hit(v.code_prefix));
      return { family, single: list.length === 1 && list[0].variety === family ? list[0] : null, kids };
    })
    .filter((f) => f.kids.length);
}

/** Varieties as a searchable family › variety tree with code prefixes. */
export function VarietiesView({ category, varieties, onRequested }) {
  const [requesting, setRequesting] = useState(false);
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState(() => new Set());
  const tree = useMemo(() => buildTree(varieties, q), [varieties, q]);
  const shown = tree.reduce((n, f) => n + f.kids.length, 0);
  const searching = !!q.trim();
  const toggle = (family) =>
    setCollapsed((s) => {
      const n = new Set(s);
      n.has(family) ? n.delete(family) : n.add(family);
      return n;
    });

  return (
    <div className="space-y-4">
      <Toolbar
        left={
          <div className="relative max-w-xs">
            <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search families, varieties, prefixes"
              className={`${input} pl-8`}
              aria-label="Search varieties"
            />
          </div>
        }
        buttonLabel="Request a variety"
        onRequest={() => setRequesting((r) => !r)}
        disabled={!category.enabled}
      />
      {requesting && (
        <RequestForm
          body={{ kind: 'variety', category_id: category.id }}
          title="Variety you need"
          placeholder="e.g. Peach Moonstone"
          withFamily
          onSent={(r) => { onRequested(r); setRequesting(false); }}
          onCancel={() => setRequesting(false)}
        />
      )}
      <ViewOnlyNote />
      <div className="overflow-x-auto -mx-5">
        <table className="w-full min-w-[420px] text-sm table-fixed">
          <colgroup>
            <col />
            <col className="w-32" />
          </colgroup>
          <thead>
            <tr className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] border-b border-[var(--color-border)]">
              <th className={`${th} pl-5`}>Family › Variety</th>
              <th className={`${th} pr-5 text-right`}>Code prefix</th>
            </tr>
          </thead>
          <tbody>
            {tree.map(({ family, single, kids }) =>
              single ? (
                // Family that is its own only variety (Aquamarine): a parent row
                // with no children; blank space where the caret would be keeps
                // the names aligned.
                <tr key={family} className="border-b border-[var(--color-border)] bg-white hover:bg-slate-50">
                  <td className="py-2 pl-5 pr-3">
                    <span className={ROW_LINE}>
                      <span className="w-3" aria-hidden="true" />
                      <span className="font-semibold text-slate-900">{family}</span>
                    </span>
                  </td>
                  <td className="py-2 pr-5 text-right tabular text-slate-500">
                    <span className={`${ROW_LINE} justify-end`}>{single.code_prefix}</span>
                  </td>
                </tr>
              ) : (
                <FamilyRows
                  key={family}
                  family={family}
                  kids={kids}
                  open={searching || !collapsed.has(family)}
                  onToggle={() => toggle(family)}
                />
              )
            )}
            {tree.length === 0 && (
              <tr><td colSpan={2} className="py-4 pl-5 text-slate-500">No varieties match “{q.trim()}”.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-400 tabular">
        {searching ? `${shown} of ${varieties.length} varieties` : `${tree.length} families · ${varieties.length} varieties`}
      </p>
    </div>
  );
}

function FamilyRows({ family, kids, open, onToggle }) {
  return (
    <>
      <tr className="border-b border-[var(--color-border)] bg-white hover:bg-slate-50 cursor-pointer" onClick={onToggle}>
        <td className="py-2 pl-5 pr-3" colSpan={2}>
          <button type="button" aria-expanded={open} className={`${ROW_LINE} text-left`} onClick={(e) => { e.stopPropagation(); onToggle(); }}>
            <CaretRight size={12} className={`text-slate-400 transition ${open ? 'rotate-90' : ''}`} />
            <span className="font-semibold text-slate-900">{family}</span>
            <span className="ml-1.5 text-xs text-slate-400 tabular">{kids.length}</span>
          </button>
        </td>
      </tr>
      {open &&
        kids.map((v) => (
          <tr key={v.id} className="border-b border-[var(--color-border)] bg-slate-50 hover:bg-slate-100">
            <td className="py-2 pl-10 pr-3 text-slate-700">
              <span className={ROW_LINE}>
                <span className="text-slate-300 mr-1" aria-hidden="true">–</span>
                {v.variety}
              </span>
            </td>
            <td className="py-2 pr-5 text-right tabular text-slate-500">
              <span className={`${ROW_LINE} justify-end`}>{v.code_prefix}</span>
            </td>
          </tr>
        ))}
    </>
  );
}

/** Attributes as a list: name, type (+ options), required. */
export function AttributesView({ category, fields, fieldTypes, onRequested }) {
  const [openOptions, setOpenOptions] = useState(null);
  const [requestingFor, setRequestingFor] = useState(null); // field_key | 'new'

  return (
    <div className="space-y-4">
      <Toolbar
        left={<p className="text-sm text-slate-600"><span className="tabular">{fields.length}</span> attributes recorded for each lot</p>}
        buttonLabel="Request an attribute"
        onRequest={() => setRequestingFor((k) => (k === 'new' ? null : 'new'))}
        disabled={!category.enabled}
      />
      {requestingFor === 'new' && (
        <RequestForm
          body={{ kind: 'field', category_id: category.id }}
          title="Attribute you need"
          placeholder="e.g. Fluorescence"
          onSent={(r) => { onRequested(r); setRequestingFor(null); }}
          onCancel={() => setRequestingFor(null)}
        />
      )}
      <ViewOnlyNote />
      <div className="overflow-x-auto -mx-5">
        {/* Fixed layout: opening an options/request panel must not resize columns. */}
        <table className="w-full min-w-[480px] text-sm table-fixed">
          <colgroup>
            <col className="w-[38%]" />
            <col className="w-[32%]" />
            <col className="w-[12%]" />
            <col className="w-[18%]" />
          </colgroup>
          <thead>
            <tr className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] border-b border-[var(--color-border)]">
              <th className={`${th} pl-5`}>Attribute</th>
              <th className={th}>Type</th>
              <th className={th}>Required</th>
              <th className={`${th} pr-5`}></th>
            </tr>
          </thead>
          <tbody>
            {/* Catalog order is meaningful (essentials first, L → W → H) — don't sort. */}
            {fields.map((f) => (
              <FieldRow
                key={f.field_key}
                field={f}
                category={category}
                fieldTypes={fieldTypes}
                optionsOpen={openOptions === f.field_key}
                onToggleOptions={() => setOpenOptions((k) => (k === f.field_key ? null : f.field_key))}
                requesting={requestingFor === f.field_key}
                onRequest={() => setRequestingFor((k) => (k === f.field_key ? null : f.field_key))}
                onRequested={(r) => { onRequested(r); setRequestingFor(null); }}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FieldRow({ field: f, category, fieldTypes, optionsOpen, onToggleOptions, requesting, onRequest, onRequested }) {
  const options = f.options || [];
  const expanded = optionsOpen || requesting;
  return (
    <>
      {/* While a panel is open below, drop this row's divider so row + panel read as one. */}
      <tr className={`hover:bg-slate-50 ${expanded ? '' : 'border-b border-[var(--color-border)]'}`}>
        <td className="py-2 pl-5 pr-3 text-slate-900">{f.field_label}</td>
        <td className="py-2 pr-3 text-slate-600">
          {fieldTypes[f.field_type] || f.field_type}
          {f.field_type === 'select' && (
            <button type="button" onClick={onToggleOptions} className="ml-2 text-xs text-slate-500 hover:text-slate-900">
              {options.length} options <span className="inline-block w-2.5 text-center">{optionsOpen ? '▴' : '▾'}</span>
            </button>
          )}
        </td>
        <td className="py-2 pr-3 text-slate-600">{f.required ? 'Yes' : '—'}</td>
        <td className="py-2 pr-5 text-right whitespace-nowrap">
          {f.field_type === 'select' && category.enabled && (
            <button type="button" onClick={onRequest} className={linkBtn}>Request option</button>
          )}
        </td>
      </tr>
      {optionsOpen && (
        <tr className={requesting ? '' : 'border-b border-[var(--color-border)]'}>
          <td colSpan={4} className="px-5 pt-3 pb-4 bg-slate-50">
            <p className="text-xs text-slate-500 mb-2.5 tabular">{options.length} options</p>
            <div className="flex flex-wrap gap-2">
              {/* Catalog order — some lists are scales (clarity IF → I), not A–Z. */}
              {options.map((o) => (
                <span key={o} className="text-xs leading-5 px-2.5 py-0.5 rounded-full bg-white border border-slate-200 text-slate-700">
                  {o}
                </span>
              ))}
            </div>
          </td>
        </tr>
      )}
      {requesting && (
        <tr className="border-b border-[var(--color-border)]">
          <td colSpan={4} className="px-5 pt-3 pb-4 bg-slate-50">
            <RequestForm
              body={{ kind: 'option', category_id: category.id, field_key: f.field_key }}
              title={`New ${f.field_label.toLowerCase()} option`}
              placeholder="e.g. Vietnam"
              onSent={onRequested}
              onCancel={onRequest}
            />
          </td>
        </tr>
      )}
    </>
  );
}

export function RequestForm({ body, title, placeholder, withFamily = false, onSent, onCancel }) {
  const [value, setValue] = useState('');
  const [family, setFamily] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { request } = await call('/api/catalog/requests', 'POST', { ...body, value, family, note });
      onSent(request);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid grid-cols-12 gap-3 items-end p-3 rounded-lg bg-sky-50/60 border border-sky-100">
      <div className={`col-span-12 ${withFamily ? 'sm:col-span-3' : 'sm:col-span-4'}`}>
        <label className={label}>{title}</label>
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} className={input} required autoFocus />
      </div>
      {withFamily && (
        <div className="col-span-12 sm:col-span-3">
          <label className={label}>Family <span className="font-normal text-slate-400">(optional)</span></label>
          <input value={family} onChange={(e) => setFamily(e.target.value)} placeholder="e.g. Moonstone" className={input} />
        </div>
      )}
      <div className={`col-span-12 ${withFamily ? 'sm:col-span-3' : 'sm:col-span-5'}`}>
        <label className={label}>Why / example <span className="font-normal text-slate-400">(optional)</span></label>
        <input value={note} onChange={(e) => setNote(e.target.value)} className={input} />
      </div>
      <div className="col-span-12 sm:col-span-3 flex gap-2">
        <button type="submit" disabled={busy} className={`${primaryBtn} flex-1`}>Send request</button>
        <button type="button" onClick={onCancel} className={`${ghostBtn} border-slate-300 text-slate-600`} aria-label="Cancel"><X size={13} /></button>
      </div>
      {error && <p className="col-span-12 text-sm text-red-700">{error}</p>}
      <p className="col-span-12 text-xs text-slate-500">The Caratpal team reviews requests and adds approved ones for everyone.</p>
    </form>
  );
}
