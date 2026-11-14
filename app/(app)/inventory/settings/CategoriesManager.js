'use client';

/**
 * Category cards for /inventory/settings. Clicking a live card opens
 * /inventory/settings/category/<key> (varieties + attributes); its Active
 * toggle sits bottom-right (at least one stays active — refusing shows a
 * message). Coming-soon categories are greyed out. Category requests below.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CategoryToggle, RequestForm, RequestsList, categoryIcon, unitWord, ghostBtn } from './CatalogViews';

export default function CategoriesManager({ initialCategories, counts, initialRequests, units }) {
  const [active, setActive] = useState(() => new Set(initialCategories.filter((c) => c.enabled).map((c) => c.key)));
  const [requests, setRequests] = useState(initialRequests);
  const [requestingCategory, setRequestingCategory] = useState(false);

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {initialCategories.map((c) =>
          c.comingSoon ? (
            <ComingSoonCard key={c.key} category={c} units={units} />
          ) : (
            <CategoryCard
              key={c.key}
              category={c}
              units={units}
              counts={counts[c.key] || { varieties: 0, fields: 0 }}
              active={active.has(c.key)}
              othersActive={[...active].filter((k) => k !== c.key).length}
              onChange={(on) =>
                setActive((s) => {
                  const n = new Set(s);
                  on ? n.add(c.key) : n.delete(c.key);
                  return n;
                })
              }
            />
          )
        )}
      </div>

      <div>
        {requestingCategory ? (
          <RequestForm
            body={{ kind: 'category' }}
            title="Category you need"
            placeholder="e.g. Pearls"
            onSent={(r) => { setRequests((rs) => [r, ...rs]); setRequestingCategory(false); }}
            onCancel={() => setRequestingCategory(false)}
          />
        ) : (
          <button type="button" onClick={() => setRequestingCategory(true)} className={`${ghostBtn} border-slate-300 text-slate-700 hover:border-slate-500`}>
            Request a new category
          </button>
        )}
      </div>

      <RequestsList requests={requests} />
    </div>
  );
}

function CategoryCard({ category: c, units, counts, active, othersActive, onChange }) {
  const router = useRouter();
  const Icon = categoryIcon(c.key);
  const href = `/inventory/settings/category/${c.key}`;
  const open = () => router.push(href);

  // The whole card opens the category; the toggle stops the click so it
  // only switches the category on/off.
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open();
      }}
      aria-label={`${c.name} — open details`}
      className={`flex flex-col rounded-xl border bg-white cursor-pointer transition hover:shadow-md hover:-translate-y-0.5
        focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
          active ? 'border-emerald-300 ring-1 ring-emerald-100' : 'border-[var(--color-border)]'
        }`}
    >
      <CardHeader Icon={Icon} name={c.name} unit={unitWord(units, c.uom)} active={active} />
      <div className="mt-auto flex items-center justify-between gap-3 px-5 py-3 border-t border-[var(--color-border)]">
        <Counts varieties={counts.varieties} attributes={counts.fields} />
        <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <CategoryToggle category={c} othersActive={othersActive} onChange={onChange} />
        </div>
      </div>
    </div>
  );
}

function ComingSoonCard({ category: c, units }) {
  const Icon = categoryIcon(c.key);
  return (
    <div className="flex flex-col rounded-xl border border-dashed border-slate-300 bg-slate-50 opacity-70" aria-disabled="true">
      <CardHeader Icon={Icon} name={c.name} unit={unitWord(units, c.uom)} muted />
      <div className="mt-auto flex items-center justify-between gap-3 px-5 py-3 border-t border-dashed border-slate-300">
        <span className="text-xs text-slate-400">We’re preparing this category</span>
        <span className="text-[10px] uppercase tracking-wide font-medium px-2 py-1 rounded-full bg-slate-200 text-slate-600">
          Coming soon
        </span>
      </div>
    </div>
  );
}

function CardHeader({ Icon, name, unit, active = false, muted = false }) {
  return (
    <div className="flex items-center gap-3.5 p-5">
      <div
        className={`w-11 h-11 rounded-lg flex items-center justify-center shrink-0 ${
          muted ? 'bg-slate-200 text-slate-500' : active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
        }`}
      >
        <Icon size={22} />
      </div>
      <div className="min-w-0">
        <h2 className={`text-base font-semibold truncate ${muted ? 'text-slate-500' : 'text-slate-900'}`}>{name}</h2>
        <p className={`text-xs mt-0.5 ${muted ? 'text-slate-400' : 'text-slate-500'}`}>Priced per {unit}</p>
      </div>
    </div>
  );
}

function Counts({ varieties, attributes }) {
  return (
    <p className="text-xs text-slate-500 tabular">
      <span className="text-slate-900 font-medium">{varieties}</span> varieties
      <span className="mx-1.5 text-slate-300">·</span>
      <span className="text-slate-900 font-medium">{attributes}</span> attributes
    </p>
  );
}
