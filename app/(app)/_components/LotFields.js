'use client';

/**
 * Shared "new lot" fields for transaction/stock forms (New purchase,
 * Opening stock): category variety picker (grouped, A–Z), optional lot
 * code (auto-numbered by the variety's prefix when blank), the category's
 * essential attributes, and the rest behind "+ More details".
 *
 *   value:    { variety, code, attributes }
 *   schemas:  { [category_id]: attribute list (loadCategoryFields) }
 *   varieties: listVarieties(userId) rows
 */

import { useId, useMemo, useState } from 'react';
import { Plus } from '@phosphor-icons/react';

const input =
  'w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-500 bg-white';
const label = 'block text-xs font-medium text-slate-600 mb-1.5';

// Unit labels by ERPNext UOM: [qty label, per-unit label].
export const UNIT_LABELS = {
  Carat: ['Weight (ct)', 'ct'],
  Gram: ['Weight (g)', 'g'],
  Nos: ['Qty', 'piece'],
};

/**
 * New-lot details: variety (grouped by family), optional code, the
 * essential attributes, and the rest behind "+ More details".
 */
export function NewLotFields({ value, schemas, varieties, onChange }) {
  const [more, setMore] = useState(false);
  const chosen = varieties.find((v) => v.variety === value.variety);
  const schema = (chosen && schemas[chosen.category_id]) || [];
  const essential = schema.filter((f) => f.ui === 'essential');
  const extra = schema.filter((f) => f.ui === 'more');
  const set = (patch) => onChange({ ...value, ...patch });
  const setAttr = (k, v) => onChange({ ...value, attributes: { ...value.attributes, [k]: v } });
  // Option groups "Category › Family" (category omitted when there's one).
  const groups = useMemo(() => {
    const multi = new Set(varieties.map((v) => v.category)).size > 1;
    const m = new Map();
    for (const v of varieties) {
      const key = multi ? `${v.category} › ${v.family}` : v.family;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(v);
    }
    // A–Z: groups, then varieties within each group.
    const az = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
    return [...m.entries()]
      .sort(([a], [b]) => az(a, b))
      .map(([k, list]) => [k, [...list].sort((a, b) => az(a.variety, b.variety))]);
  }, [varieties]);
  const prefix = chosen?.code_prefix;

  if (varieties.length === 0) {
    return (
      <p className="mt-3 pt-3 border-t border-slate-200 text-sm text-slate-600">
        No product categories are active.{' '}
        <a href="/inventory/settings" className="text-[var(--color-brand-accent)] hover:underline">Turn one on</a>, then come back.
      </p>
    );
  }

  return (
    <div className="mt-3 pt-3 border-t border-slate-200">
      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-12 sm:col-span-8">
          <label className={label}>Category</label>
          <select value={value.variety} onChange={(e) => set({ variety: e.target.value })} className={`${input} select-arrow`} required>
            <option value="">Select…</option>
            {groups.map(([family, list]) => (
              <optgroup key={family} label={family}>
                {list.map((v) => <option key={v.variety} value={v.variety}>{v.variety}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="col-span-12 sm:col-span-4">
          <label className={label}>Lot code <span className="font-normal text-slate-400">(optional)</span></label>
          <input
            value={value.code}
            onChange={(e) => set({ code: e.target.value.toUpperCase() })}
            placeholder={prefix ? `Auto: ${prefix}0001…` : 'Auto'}
            className={`${input} uppercase`}
          />
        </div>
        {essential.map((f) => (
          <AttrField key={f.field_key} def={f} value={value.attributes[f.field_key]} onChange={(v) => setAttr(f.field_key, v)} />
        ))}
        {more && extra.map((f) => (
          <AttrField key={f.field_key} def={f} value={value.attributes[f.field_key]} onChange={(v) => setAttr(f.field_key, v)} />
        ))}
      </div>
      {extra.length > 0 && (
        <button
          type="button"
          onClick={() => setMore((m) => !m)}
          className="mt-3 inline-flex items-center gap-1 text-xs text-[var(--color-brand-accent)] hover:underline"
        >
          {more ? '− Fewer details' : <><Plus size={12} weight="bold" /> More details</>}
        </button>
      )}
    </div>
  );
}

export function AttrField({ def, value, onChange }) {
  const id = useId();
  const numeric = def.field_type === 'float' || def.field_type === 'int';
  if (def.field_type === 'check') {
    return (
      <label htmlFor={id} className="col-span-6 sm:col-span-3 flex items-center gap-2 text-sm text-slate-700 self-end pb-2.5">
        <input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} className="w-4 h-4" />
        {def.field_label}
      </label>
    );
  }
  return (
    <div className="col-span-6 sm:col-span-3">
      <label className={label} htmlFor={id}>
        {def.field_label}
        {!def.required && def.ui !== 'essential' && <span className="font-normal text-slate-400"> (optional)</span>}
      </label>
      {def.field_type === 'select' && Array.isArray(def.options) ? (
        <select id={id} value={value || ''} onChange={(e) => onChange(e.target.value)} className={`${input} select-arrow`} required={def.required}>
          <option value="">Select…</option>
          {def.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input
          id={id}
          type={numeric ? 'number' : 'text'}
          step={def.field_type === 'float' ? 'any' : def.field_type === 'int' ? '1' : undefined}
          min={numeric ? (def.field_type === 'int' ? '1' : '0') : undefined}
          inputMode={numeric ? 'decimal' : undefined}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className={`${input} ${numeric ? 'tabular' : ''}`}
          required={def.required}
        />
      )}
    </div>
  );
}
