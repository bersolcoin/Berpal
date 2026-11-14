'use client';

/**
 * Opening stock form: "as of" date + one or more new lots, each with its
 * cost per unit (per carat for gems) in the company currency.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash } from '@phosphor-icons/react';
import Card from '../../_components/Card';
import { money } from '../../_components/format';
import { NewLotFields, UNIT_LABELS } from '../../_components/LotFields';

const input =
  'w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-500 bg-white';
const label = 'block text-xs font-medium text-slate-600 mb-1.5';

let seq = 0;
const emptyLot = () => ({ id: ++seq, lot: { variety: '', code: '', attributes: { pieces: '1' } }, qty: '', rate: '' });

function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export default function OpeningStockForm({ varieties, schemas, currency }) {
  const router = useRouter();
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState([emptyLot()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const uomOf = (r) => varieties.find((v) => v.variety === r.lot.variety)?.uom || 'Carat';
  const qtyOf = (r) => (uomOf(r) === 'Carat' ? Number(r.lot.attributes.weight_ct) : Number(r.qty)) || 0;
  const total = rows.reduce((s, r) => s + qtyOf(r) * (Number(r.rate) || 0), 0);
  const update = (id, patch) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  async function save(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/inventory/opening', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date,
          lots: rows.map((r) => ({
            variety: r.lot.variety,
            code: r.lot.code,
            attributes: r.lot.attributes,
            qty: r.qty,
            rate: r.rate,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setError(data.error || 'Could not save the opening stock.');
        setBusy(false);
        return;
      }
      router.push('/inventory');
      router.refresh();
    } catch (err) {
      setError(err.message || 'Network error.');
      setBusy(false);
    }
  }

  if (varieties.length === 0) {
    return (
      <Card>
        <p className="text-sm text-slate-600">
          No product categories are active.{' '}
          <a href="/inventory/settings" className="text-[var(--color-brand-accent)] hover:underline">Turn one on</a> first.
        </p>
      </Card>
    );
  }

  return (
    <form onSubmit={save} className="space-y-5 max-w-4xl">
      <Card title="As of">
        <div className="max-w-xs">
          <label className={label} htmlFor="as-of">Date you held this stock</label>
          <input id="as-of" type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} required />
        </div>
      </Card>

      <Card title="Lots">
        <div className="space-y-4">
          {rows.map((r, i) => {
            const uom = uomOf(r);
            const [qtyLabel, unitLabel] = UNIT_LABELS[uom] || UNIT_LABELS.Nos;
            const qty = qtyOf(r);
            return (
              <div key={r.id} className="p-4 border border-slate-200 rounded-lg bg-slate-50/40">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-slate-600">Lot {i + 1}</span>
                  {rows.length > 1 && (
                    <button type="button" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-red-600 transition">
                      <Trash size={13} /> Remove
                    </button>
                  )}
                </div>
                <NewLotFields value={r.lot} schemas={schemas} varieties={varieties} onChange={(lot) => update(r.id, { lot })} />
                <div className="grid grid-cols-12 gap-3 mt-3">
                  {uom !== 'Carat' && (
                    <div className="col-span-6 sm:col-span-3">
                      <label className={label} htmlFor={`qty-${r.id}`}>{qtyLabel}</label>
                      <input id={`qty-${r.id}`} type="number" min="0" step="any" inputMode="decimal" value={r.qty} onChange={(e) => update(r.id, { qty: e.target.value })} className={`${input} tabular`} required />
                    </div>
                  )}
                  <div className="col-span-6 sm:col-span-4">
                    <label className={label} htmlFor={`rate-${r.id}`}>Cost per {unitLabel} ({currency})</label>
                    <input id={`rate-${r.id}`} type="number" min="0" step="any" inputMode="decimal" value={r.rate} onChange={(e) => update(r.id, { rate: e.target.value })} placeholder="0.00" className={`${input} tabular`} required />
                  </div>
                  <div className="col-span-12 sm:col-span-5 flex items-end">
                    <p className="text-xs text-slate-500 tabular pb-2.5">
                      {qty || 0} {unitLabel === 'piece' ? (qty === 1 ? 'piece' : 'pieces') : unitLabel} × {money(Number(r.rate) || 0, currency)} ={' '}
                      <strong className="text-slate-700">{money(qty * (Number(r.rate) || 0), currency)}</strong>
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex items-center justify-between gap-4">
          <button type="button" onClick={() => setRows((rs) => [...rs, emptyLot()])} className="inline-flex items-center gap-1.5 text-sm text-[var(--color-brand-accent)] hover:underline">
            <Plus size={14} weight="bold" /> Add lot
          </button>
          <div className="text-sm">
            <span className="text-slate-500 mr-2">Total value</span>
            <span className="font-semibold tabular">{money(total, currency)}</span>
          </div>
        </div>
      </Card>

      {error && <p className="text-sm text-red-700">{error}</p>}

      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={() => router.back()} disabled={busy} className="px-4 py-2.5 text-sm text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition disabled:opacity-50">
          Cancel
        </button>
        <button type="submit" disabled={busy} className="px-5 py-2.5 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition disabled:opacity-50 font-medium">
          {busy ? 'Saving…' : `Add to stock · ${money(total, currency)}`}
        </button>
      </div>
    </form>
  );
}
