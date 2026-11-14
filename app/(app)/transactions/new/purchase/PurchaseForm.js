'use client';

/**
 * New purchase form. Supplier (pick or type a new one) → line items (search
 * an existing item or add a new one with its essential details) → paid now
 * from a wallet, or on credit → save. Posts to /api/purchases.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash, MagnifyingGlass } from '@phosphor-icons/react';
import Card from '../../../_components/Card';
import { NewLotFields, UNIT_LABELS } from '../../../_components/LotFields';
import { money } from '../../../_components/format';

const CURRENCIES = ['USD', 'THB', 'EUR', 'GBP', 'HKD', 'SGD', 'CNY', 'JPY', 'AUD', 'INR', 'LKR', 'AED', 'CHF'];
const TERMS = [
  { value: 'net_0', label: 'Due today' },
  { value: 'net_7', label: 'Net 7 days' },
  { value: 'net_15', label: 'Net 15 days' },
  { value: 'net_30', label: 'Net 30 days' },
  { value: 'net_60', label: 'Net 60 days' },
];

const input =
  'w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-500 bg-white';
const label = 'block text-xs font-medium text-slate-600 mb-1.5';

let lineSeq = 0;
function emptyLine() {
  return { id: ++lineSeq, item: null, newItem: null, qty: '', rate: '' };
}

function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export default function PurchaseForm({ suppliers, wallets, schemas, varieties, defaultCurrency }) {
  const router = useRouter();
  const [supplier, setSupplier] = useState('');
  const [date, setDate] = useState(today());
  const [currency, setCurrency] = useState(defaultCurrency || 'USD');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([emptyLine()]);
  const [payMode, setPayMode] = useState('paid');
  const [walletAccount, setWalletAccount] = useState('');
  const [terms, setTerms] = useState('net_30');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const currencies = useMemo(
    () => [...new Set([defaultCurrency, ...wallets.map((w) => w.currency), ...CURRENCIES].filter(Boolean))],
    [defaultCurrency, wallets]
  );
  const walletsInCcy = wallets.filter((w) => w.currency === currency);

  // Keep the wallet choice valid for the bill's currency.
  useEffect(() => {
    if (!walletsInCcy.some((w) => w.account === walletAccount)) {
      setWalletAccount(walletsInCcy[0]?.account || '');
    }
  }, [currency]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = lines.reduce((s, l) => s + lineQty(l, varieties) * (Number(l.rate) || 0), 0);
  const isNewSupplier =
    supplier.trim() && !suppliers.some((s) => s.toLowerCase() === supplier.trim().toLowerCase());

  function updateLine(id, patch) {
    setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await fetch('/api/purchases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplier,
          date,
          currency,
          reference,
          notes,
          lines: lines.map((l) => ({
            item: l.item
              ? { erpnext_name: l.item.name }
              : l.newItem
                ? { new: { variety: l.newItem.variety, code: l.newItem.code, attributes: l.newItem.attributes } }
                : null,
            qty: lineQty(l, varieties),
            rate: l.rate,
          })),
          payment: payMode === 'paid' ? { mode: 'paid', wallet_account: walletAccount } : { mode: 'credit', terms },
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        setError(data.error || 'Could not save the purchase.');
        setBusy(false);
        return;
      }
      if (data.payment_entry_error) {
        // Bill saved but the payment didn't — say so before moving on.
        alert(`Purchase saved, but recording the payment failed: ${data.payment_entry_error}`);
      }
      router.push(`/transactions/${encodeURIComponent(data.doctype)}/${encodeURIComponent(data.erpnext_name)}`);
    } catch (err) {
      setError(err.message || 'Network error.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-5 max-w-4xl">
      <Card title="Details">
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className={label} htmlFor="supplier">Supplier</label>
            <input
              id="supplier"
              list="supplier-list"
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
              placeholder="Search or type a new supplier name"
              className={input}
              autoComplete="off"
              required
            />
            <datalist id="supplier-list">
              {suppliers.map((s) => <option key={s} value={s} />)}
            </datalist>
            {isNewSupplier && (
              <p className="mt-1.5 text-xs text-slate-500">New supplier — it will be created when you save.</p>
            )}
          </div>
          <div>
            <label className={label} htmlFor="date">Date</label>
            <input id="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} required />
          </div>
          <div>
            <label className={label} htmlFor="currency">Currency</label>
            <select id="currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className={`${input} select-arrow`}>
              {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className={label} htmlFor="reference">Supplier’s bill number <span className="font-normal text-slate-400">(optional)</span></label>
            <input id="reference" value={reference} onChange={(e) => setReference(e.target.value)} className={input} />
          </div>
        </div>
      </Card>

      <Card title="Lots">
        <div className="space-y-4">
          {lines.map((l, i) => (
            <LineRow
              key={l.id}
              index={i}
              line={l}
              currency={currency}
              schemas={schemas}
              varieties={varieties}
              canRemove={lines.length > 1}
              onChange={(patch) => updateLine(l.id, patch)}
              onRemove={() => setLines((ls) => ls.filter((x) => x.id !== l.id))}
            />
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => setLines((ls) => [...ls, emptyLine()])}
            className="inline-flex items-center gap-1.5 text-sm text-[var(--color-brand-accent)] hover:underline"
          >
            <Plus size={14} weight="bold" /> Add lot
          </button>
          <div className="text-sm">
            <span className="text-slate-500 mr-2">Total</span>
            <span className="font-semibold tabular">{money(total, currency)}</span>
          </div>
        </div>
      </Card>

      <Card title="Payment">
        <div className="flex flex-wrap gap-2 mb-4" role="radiogroup">
          {[
            { v: 'paid', l: 'Paid now' },
            { v: 'credit', l: 'On credit' },
          ].map((o) => (
            <button
              key={o.v}
              type="button"
              role="radio"
              aria-checked={payMode === o.v}
              onClick={() => setPayMode(o.v)}
              className={`px-4 py-2 text-sm rounded-lg border transition ${
                payMode === o.v
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-300 hover:border-slate-500'
              }`}
            >
              {o.l}
            </button>
          ))}
        </div>

        {payMode === 'paid' ? (
          walletsInCcy.length > 0 ? (
            <div className="max-w-sm">
              <label className={label} htmlFor="wallet">Paid from</label>
              <select id="wallet" value={walletAccount} onChange={(e) => setWalletAccount(e.target.value)} className={`${input} select-arrow`}>
                {walletsInCcy.map((w) => (
                  <option key={w.account} value={w.account}>
                    {w.name} — {money(w.balance, w.currency)}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              You have no {currency} wallet. Pick another currency, record it on credit, or add a {currency} wallet first.
            </p>
          )
        ) : (
          <div className="max-w-sm">
            <label className={label} htmlFor="terms">Payment terms</label>
            <select id="terms" value={terms} onChange={(e) => setTerms(e.target.value)} className={`${input} select-arrow`}>
              {TERMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
        )}

        <div className="mt-4">
          <label className={label} htmlFor="notes">Notes <span className="font-normal text-slate-400">(optional)</span></label>
          <textarea id="notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className={input} />
        </div>
      </Card>

      {error && <p className="text-sm text-red-700">{error}</p>}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => router.back()}
          disabled={busy}
          className="px-4 py-2.5 text-sm text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || (payMode === 'paid' && !walletAccount)}
          className="px-5 py-2.5 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition disabled:opacity-50 font-medium"
        >
          {busy ? 'Saving…' : `Save purchase · ${money(total, currency)}`}
        </button>
      </div>
    </form>
  );
}

/** The line's stock unit: the new lot's category unit, else the lot's own. */
function lineUom(l, varieties) {
  if (l.newItem) return varieties.find((v) => v.variety === l.newItem.variety)?.uom || 'Nos';
  return l.item?.stock_uom || 'Nos';
}

/** Quantity on a line: a new carat lot's weight, else the typed qty. */
function lineQty(l, varieties) {
  if (l.newItem && lineUom(l, varieties) === 'Carat') return Number(l.newItem.attributes.weight_ct) || 0;
  return Number(l.qty) || 0;
}

/** One line: pick an existing lot or add a new one, quantity + price per unit. */
function LineRow({ index, line, currency, schemas, varieties, canRemove, onChange, onRemove }) {
  const uom = lineUom(line, varieties);
  const [qtyLabel, unitLabel] = UNIT_LABELS[uom] || UNIT_LABELS.Nos;
  // A new carat lot's weight comes from its details; everything else types qty.
  const showQty = !(line.newItem && uom === 'Carat');
  const qty = lineQty(line, varieties);
  const lineTotal = qty * (Number(line.rate) || 0);
  return (
    <div className="p-4 border border-slate-200 rounded-lg bg-slate-50/40">
      <div className="grid grid-cols-12 gap-3 items-end">
        <div className={`col-span-12 ${showQty ? 'md:col-span-6' : 'md:col-span-8'}`}>
          <span className={label}>Lot {index + 1}</span>
          <ItemPicker line={line} onChange={onChange} />
        </div>
        {showQty && (
          <div className="col-span-5 md:col-span-2">
            <label className={label} htmlFor={`qty-${line.id}`}>{qtyLabel}</label>
            <input
              id={`qty-${line.id}`}
              type="number" min="0" step="any" inputMode="decimal"
              value={line.qty}
              onChange={(e) => onChange({ qty: e.target.value })}
              className={`${input} tabular`}
              required
            />
          </div>
        )}
        <div className={`${showQty ? 'col-span-7' : 'col-span-12'} md:col-span-4`}>
          <label className={label} htmlFor={`rate-${line.id}`}>Price per {unitLabel} ({currency})</label>
          <input
            id={`rate-${line.id}`}
            type="number" min="0" step="any" inputMode="decimal"
            value={line.rate}
            onChange={(e) => onChange({ rate: e.target.value })}
            className={`${input} tabular`}
            placeholder="0.00"
            required
          />
        </div>
      </div>

      {line.newItem && (
        <NewLotFields
          value={line.newItem}
          schemas={schemas}
          varieties={varieties}
          onChange={(newItem) => onChange({ newItem })}
        />
      )}

      <div className="mt-3 flex items-center justify-between text-xs">
        <span className="text-slate-500 tabular">
          {qty || 0} {unitLabel === 'piece' ? (qty === 1 ? 'piece' : 'pieces') : unitLabel} × {money(Number(line.rate) || 0, currency)} = <strong className="text-slate-700">{money(lineTotal, currency)}</strong>
        </span>
        {canRemove && (
          <button type="button" onClick={onRemove} className="inline-flex items-center gap-1 text-slate-400 hover:text-red-600 transition">
            <Trash size={13} /> Remove
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Search the tenant's lots (/api/items/search). Picking a result sets
 * line.item (weight defaults to the lot's); "+ New lot" starts line.newItem.
 */
function ItemPicker({ line, onChange }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/items/search?q=${encodeURIComponent(q.trim())}`);
        const data = await r.json();
        setResults(data.ok ? data.items : []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, open]);

  // Close the dropdown on outside click.
  useEffect(() => {
    function onDoc(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  if (line.item || line.newItem) {
    const title = line.item
      ? line.item.item_name || line.item.item_code
      : `New lot${line.newItem.variety ? `: ${line.newItem.variety}` : ''}`;
    const sub = line.item ? itemSubtitle(line.item) : 'Code assigned automatically unless you enter one';
    return (
      <div className="flex items-center justify-between gap-2 px-3 py-2 border border-slate-300 rounded-lg bg-white min-h-[42px]">
        <div className="min-w-0">
          <div className="text-sm text-slate-900 truncate">{title}</div>
          {sub && <div className="text-xs text-slate-500 truncate">{sub}</div>}
        </div>
        <button
          type="button"
          onClick={() => onChange({ item: null, newItem: null, qty: '' })}
          className="shrink-0 text-xs text-[var(--color-brand-accent)] hover:underline"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div ref={boxRef} className="relative">
      <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Search lots by code or name"
        className={`${input} pl-8`}
        autoComplete="off"
      />
      {open && (
        <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-72 overflow-auto">
          {loading && results.length === 0 && <div className="px-3 py-2 text-xs text-slate-400">Searching…</div>}
          {results.map((it) => (
            <button
              key={it.name}
              type="button"
              onClick={() => {
                onChange({ item: it, newItem: null, qty: it.weight_ct ? String(it.weight_ct) : '' });
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 hover:bg-slate-50"
            >
              <div className="text-sm text-slate-900">{it.item_name || it.item_code}</div>
              <div className="text-xs text-slate-500">{itemSubtitle(it)}</div>
            </button>
          ))}
          {!loading && results.length === 0 && q.trim() && (
            <div className="px-3 py-2 text-xs text-slate-400">No lots match “{q.trim()}”.</div>
          )}
          <button
            type="button"
            onClick={() => {
              onChange({ item: null, newItem: { variety: '', code: '', attributes: { pieces: '1' } } });
              setOpen(false);
            }}
            className="w-full text-left px-3 py-2 border-t border-slate-100 text-sm text-[var(--color-brand-accent)] hover:bg-slate-50 inline-flex items-center gap-1.5"
          >
            <Plus size={13} weight="bold" /> New lot
          </button>
        </div>
      )}
    </div>
  );
}

function itemSubtitle(it) {
  const code = it.item_code ? it.item_code.replace(/-[A-Z0-9&]+$/, '') : null;
  const bits = [code, it.gem_type];
  if (it.weight_ct) bits.push(`${it.weight_ct} ct`);
  if (it.pieces > 1) bits.push(`${it.pieces} pcs`);
  return bits.filter(Boolean).join(' · ');
}
