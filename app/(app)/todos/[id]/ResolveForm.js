'use client';

/**
 * Resolution form for the unknown_item_purchase todo. Two top-level
 * choices (Open stock / Bought from vendor); fields appear inline once
 * a choice is made. No wizard.
 *
 * Payments are an array of legs (wallet + amount). Zero legs = fully on
 * credit. Sum < total = partially paid. Sum = total = fully paid. The
 * backend creates one Purchase Invoice + one Payment Entry per leg.
 *
 * On submit, POSTs to /api/todos/[id]/resolve. On ok the user is sent
 * back to /todos (the row will be gone from the list).
 */

import { friendlyItemCode } from '../../_components/format';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash } from '@phosphor-icons/react';

const BRANCH = {
  OPEN_STOCK: 'open_stock',
  PURCHASED: 'purchased',
  SKIP: 'skip',
};

const PAYMENT_CODE = {
  Cash: '1000',
  Bank: '1100',
  'Credit Card': '2100',
};

const NEW_SUPPLIER_SENTINEL = '__new__';

// Keep in sync with app/onboarding/OnboardingFlow.js's COMMON_CURRENCIES.
const CURRENCIES = [
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'HKD', 'THB', 'SGD', 'INR', 'AUD',
  'CAD', 'KRW', 'IDR', 'MYR', 'VND', 'PHP', 'AED', 'CHF', 'NZD', 'ZAR',
  'BRL', 'MXN', 'RUB', 'TRY', 'SAR', 'PKR', 'BDT', 'LKR', 'NPR', 'TWD',
  'NOK', 'SEK', 'DKK', 'PLN',
];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function fmt(n) {
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export default function ResolveForm({ todoId, kind, payload, wallets, suppliers = [], defaultCurrency, reportingCurrency, abbr = null }) {
  const router = useRouter();

  const [branch, setBranch] = useState('');

  const [qty, setQty] = useState(payload?.qty_sold || 1);
  const [unitCost, setUnitCost] = useState('');
  const [currency, setCurrency] = useState(payload?.currency || defaultCurrency || reportingCurrency);

  const [supplierPick, setSupplierPick] = useState('');
  const [newSupplierName, setNewSupplierName] = useState('');
  const [supplierPhone, setSupplierPhone] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(todayISO());
  const [dueDate, setDueDate] = useState('');

  // Payment legs: [{ wallet_erpnext_name, amount }]. Empty = on credit.
  const [legs, setLegs] = useState([]);

  const [openingDate, setOpeningDate] = useState(todayISO());

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);

  const totalCost = useMemo(() => {
    const n = Number(unitCost) * Number(qty || 1);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [unitCost, qty]);

  const totalPaid = useMemo(
    () => legs.reduce((s, l) => s + (Number(l.amount) || 0), 0),
    [legs]
  );
  const outstanding = Math.max(0, totalCost - totalPaid);
  const overpaid = totalPaid > totalCost + 0.001;

  function addLeg() {
    // Default the new leg's amount to whatever's outstanding so far.
    const remaining = Math.max(0, totalCost - totalPaid);
    setLegs([...legs, { wallet_erpnext_name: '', amount: remaining > 0 ? String(remaining) : '' }]);
  }
  function removeLeg(idx) {
    setLegs(legs.filter((_, i) => i !== idx));
  }
  function updateLeg(idx, patch) {
    setLegs(legs.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  async function submit(payloadBody) {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`/api/todos/${todoId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadBody),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        setError(data.error || 'Could not resolve.');
        return;
      }
      setDone(data);
      // Bust the layout cache so the sidebar Todos badge re-fetches its
      // count on the way back to /todos. server-side revalidatePath in
      // the API route is the canonical signal; this is the belt-and-
      // suspenders pair that ensures the navigation actually picks it up.
      router.refresh();
      setTimeout(() => router.push('/todos'), 1200);
    } catch (err) {
      setError(err.message || 'Network error.');
    } finally {
      setBusy(false);
    }
  }

  function onSkip() {
    if (!confirm('Skip this todo? No accounting entry will be created.')) return;
    submit({ branch: BRANCH.SKIP });
  }

  function onSubmit(e) {
    e.preventDefault();
    if (!branch) {
      setError('Pick where the item came from.');
      return;
    }
    if (!unitCost || Number(unitCost) <= 0) {
      setError('Enter the unit cost.');
      return;
    }
    if (branch === BRANCH.OPEN_STOCK) {
      submit({
        branch: BRANCH.OPEN_STOCK,
        qty: Number(qty) || 1,
        unit_cost: Number(unitCost),
        currency,
        opening_date: openingDate,
      });
      return;
    }

    // purchased branch
    let resolvedSupplierName = '';
    if (supplierPick === NEW_SUPPLIER_SENTINEL) {
      resolvedSupplierName = newSupplierName.trim();
      if (!resolvedSupplierName) { setError('Enter the new vendor name.'); return; }
    } else if (supplierPick) {
      const existing = suppliers.find((s) => s.erpnext_name === supplierPick);
      resolvedSupplierName = existing?.supplier_name || existing?.erpnext_name || '';
      if (!resolvedSupplierName) { setError('Pick a vendor or add a new one.'); return; }
    } else {
      setError('Pick a vendor or add a new one.');
      return;
    }
    if (!purchaseDate) { setError('Pick the purchase date.'); return; }
    if (overpaid) { setError('Total paid is more than the cost.'); return; }

    // Validate legs: must have wallet + positive amount, no duplicates
    const seenWallets = new Set();
    const payment_legs = [];
    for (const l of legs) {
      if (!l.wallet_erpnext_name) { setError('Each payment needs a wallet.'); return; }
      const amt = Number(l.amount);
      if (!Number.isFinite(amt) || amt <= 0) { setError('Each payment needs a positive amount.'); return; }
      if (seenWallets.has(l.wallet_erpnext_name)) {
        setError('Two payments use the same wallet — combine them into one.'); return;
      }
      seenWallets.add(l.wallet_erpnext_name);
      const w = wallets.find((x) => x.erpnext_name === l.wallet_erpnext_name);
      if (!w) { setError('Wallet not found.'); return; }
      payment_legs.push({
        payment_account_code: PAYMENT_CODE[w.account_type],
        wallet_name: w.account_name,
        amount: amt,
      });
    }

    submit({
      branch: BRANCH.PURCHASED,
      supplier_name: resolvedSupplierName,
      supplier_phone: supplierPhone.trim() || undefined,
      qty: Number(qty) || 1,
      unit_cost: Number(unitCost),
      currency,
      purchase_date: purchaseDate,
      due_date: payment_legs.length === 0 && dueDate ? dueDate : undefined,
      payment_legs,
    });
  }

  if (done) {
    return (
      <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50">
        <p className="text-sm text-emerald-900">
          ✅ Done.{' '}
          {done.action === 'open_stock_booked' && `Booked ${done.journal_entry_name}.`}
          {done.action === 'purchased' && (
            <>
              Booked {done.purchase_invoice_name}
              {Array.isArray(done.payment_entry_names) && done.payment_entry_names.length > 0 &&
                ` + ${done.payment_entry_names.join(', ')}`}
              .
            </>
          )}
          {done.action === 'skipped' && 'Todo skipped — no document created.'}
          {' '}Returning to /todos…
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="bg-white border border-[var(--color-border)] rounded-xl p-5 space-y-5">
      {/* Item summary — read-only, prefilled from the source SI */}
      {payload && (
        <div className="text-xs text-slate-500 grid grid-cols-2 sm:grid-cols-4 gap-3 pb-3 border-b border-slate-100">
          <div>
            <div className="uppercase tracking-wide text-[10px]">Item</div>
            <div className="text-sm text-slate-800 truncate">{payload.item_name || friendlyItemCode(payload.item_code, abbr) || '—'}</div>
          </div>
          <div>
            <div className="uppercase tracking-wide text-[10px]">Sold to</div>
            <div className="text-sm text-slate-800 truncate">{payload.customer_name || '—'}</div>
          </div>
          <div>
            <div className="uppercase tracking-wide text-[10px]">Sale amount</div>
            <div className="text-sm text-slate-800 tabular">{payload.amount_sold} {payload.currency}</div>
          </div>
          <div>
            <div className="uppercase tracking-wide text-[10px]">Source</div>
            <div className="text-sm text-slate-800 truncate font-mono">{payload.invoice_ref || '—'}</div>
          </div>
        </div>
      )}

      {/* Branch selector */}
      <fieldset className="space-y-2">
        <legend className="block text-sm font-medium text-slate-700 mb-2">Where did this item come from?</legend>
        <div className="grid sm:grid-cols-2 gap-3">
          <BranchOption
            value={BRANCH.OPEN_STOCK}
            checked={branch === BRANCH.OPEN_STOCK}
            onChange={setBranch}
            title="Open stock"
            blurb="I had it before I started using Berpal. Just record the cost; no supplier or payment touched."
          />
          <BranchOption
            value={BRANCH.PURCHASED}
            checked={branch === BRANCH.PURCHASED}
            onChange={setBranch}
            title="Bought from vendor"
            blurb="Records a Purchase Invoice. Add 0..N payments below — empty = on credit, multiple = split payment."
          />
        </div>
      </fieldset>

      {/* Cost block — shared across both non-skip branches */}
      {(branch === BRANCH.OPEN_STOCK || branch === BRANCH.PURCHASED) && (
        <div className="grid sm:grid-cols-3 gap-3">
          <label className="block text-sm">
            <span className="text-slate-700">Qty</span>
            <input
              type="number" min="0" step="any" value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="mt-1 w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white tabular"
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-700">Unit cost</span>
            <input
              type="number" min="0" step="any" value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              placeholder="0.00"
              className="mt-1 w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white tabular"
              autoFocus
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-700">Currency</span>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="mt-1 w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white tabular"
            >
              {!CURRENCIES.includes(currency) && currency && (
                <option value={currency}>{currency}</option>
              )}
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <div className="sm:col-span-3 text-xs text-slate-500 -mt-1 tabular">
            Total: {totalCost ? `${fmt(totalCost)} ${currency}` : '—'}
          </div>
        </div>
      )}

      {/* Open stock branch — only opening date */}
      {branch === BRANCH.OPEN_STOCK && (
        <label className="block text-sm">
          <span className="text-slate-700">Opening date</span>
          <input
            type="date" value={openingDate}
            onChange={(e) => setOpeningDate(e.target.value)}
            className="mt-1 w-full sm:max-w-[240px] px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white tabular"
          />
          <span className="block text-[11px] text-slate-500 mt-1">
            Posts DR Cost of Goods Sold, CR Opening Balance Equity on this date.
          </span>
        </label>
      )}

      {/* Purchased branch */}
      {branch === BRANCH.PURCHASED && (
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="text-slate-700">Vendor</span>
            <select
              value={supplierPick}
              onChange={(e) => setSupplierPick(e.target.value)}
              className="mt-1 w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              <option value="">Pick a vendor…</option>
              <option value={NEW_SUPPLIER_SENTINEL}>+ Add new vendor…</option>
              {suppliers.length > 0 && <option disabled>──────────</option>}
              {suppliers.map((s) => (
                <option key={s.erpnext_name} value={s.erpnext_name}>
                  {s.supplier_name}{s.default_currency ? ` (${s.default_currency})` : ''}
                </option>
              ))}
            </select>
          </label>

          {supplierPick === NEW_SUPPLIER_SENTINEL && (
            <div className="grid sm:grid-cols-2 gap-3 -mt-2 pl-3 border-l-2 border-slate-200">
              <label className="block text-sm">
                <span className="text-slate-700">New vendor name</span>
                <input
                  type="text" value={newSupplierName}
                  onChange={(e) => setNewSupplierName(e.target.value)}
                  placeholder="e.g. Acme Supplies"
                  className="mt-1 w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  autoFocus
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-700">Phone (optional)</span>
                <input
                  type="tel" value={supplierPhone}
                  onChange={(e) => setSupplierPhone(e.target.value)}
                  placeholder="+1234555..."
                  className="mt-1 w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white tabular"
                />
              </label>
            </div>
          )}

          <label className="block text-sm">
            <span className="text-slate-700">Purchase date</span>
            <input
              type="date" value={purchaseDate}
              onChange={(e) => setPurchaseDate(e.target.value)}
              className="mt-1 w-full sm:max-w-[240px] px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white tabular"
            />
          </label>

          {/* Payments section */}
          <div className="space-y-2 pt-2 border-t border-slate-100">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-slate-700">Payments</div>
                <div className="text-[11px] text-slate-500">
                  Leave empty for on-credit. Add one for fully paid. Add multiple to split across wallets.
                </div>
              </div>
              <button
                type="button"
                onClick={addLeg}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-md hover:bg-slate-50"
              >
                <Plus size={12} weight="bold" /> Add payment
              </button>
            </div>

            {wallets.length === 0 && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
                No wallets found for this tenant. Check the dev-server console for the wallet-list error
                (look for <span className="font-mono">[todos/[id]] wallet list failed</span>).
              </p>
            )}

            {legs.map((leg, idx) => {
              const w = wallets.find((x) => x.erpnext_name === leg.wallet_erpnext_name);
              return (
                <div key={idx} className="flex flex-wrap items-end gap-2">
                  <label className="block text-xs flex-1 min-w-[180px]">
                    <span className="text-slate-600">Wallet</span>
                    <select
                      value={leg.wallet_erpnext_name}
                      onChange={(e) => updateLeg(idx, { wallet_erpnext_name: e.target.value })}
                      className="mt-1 w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="">Pick a wallet…</option>
                      {wallets.map((wallet) => (
                        <option key={wallet.erpnext_name} value={wallet.erpnext_name}>
                          {wallet.account_name} ({wallet.account_type}, {wallet.currency})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs w-32">
                    <span className="text-slate-600">Amount</span>
                    <input
                      type="number" min="0" step="any" value={leg.amount}
                      onChange={(e) => updateLeg(idx, { amount: e.target.value })}
                      placeholder="0.00"
                      className="mt-1 w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white tabular"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => removeLeg(idx)}
                    aria-label="Remove payment"
                    className="px-2 py-2 text-slate-400 hover:text-red-600"
                  >
                    <Trash size={16} weight="regular" />
                  </button>
                  {w && w.currency !== currency && (
                    <span className="basis-full text-[11px] text-amber-700">
                      Wallet is {w.currency} but cost is {currency} — we'll convert at today's exchange rate.
                    </span>
                  )}
                </div>
              );
            })}

            {/* Summary */}
            <div className="text-xs text-slate-600 tabular pt-2 grid grid-cols-3 gap-2">
              <div>Total: <span className="font-medium">{fmt(totalCost)} {currency}</span></div>
              <div>Paid: <span className="font-medium">{fmt(totalPaid)} {currency}</span></div>
              <div className={outstanding > 0 ? 'text-amber-700' : 'text-emerald-700'}>
                {legs.length === 0
                  ? 'On credit (no payments yet)'
                  : outstanding > 0
                  ? `Outstanding: ${fmt(outstanding)} ${currency}`
                  : 'Fully paid'}
              </div>
            </div>

            {legs.length === 0 && (
              <label className="block text-sm pt-2">
                <span className="text-slate-700">Due date (optional)</span>
                <input
                  type="date" value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="mt-1 w-full sm:max-w-[240px] px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white tabular"
                />
              </label>
            )}
          </div>
        </div>
      )}

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
      )}

      <div className="flex items-center justify-between pt-2 border-t border-slate-100">
        <button
          type="button"
          onClick={onSkip}
          disabled={busy}
          className="text-sm text-slate-500 hover:text-slate-700 disabled:opacity-50"
        >
          Skip this todo
        </button>
        <button
          type="submit"
          disabled={busy || !branch}
          className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition disabled:opacity-50 font-medium"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function BranchOption({ value, checked, onChange, title, blurb }) {
  return (
    <label
      className={`block cursor-pointer rounded-lg border p-3 transition ${
        checked
          ? 'border-slate-900 bg-slate-50 ring-1 ring-slate-900'
          : 'border-slate-200 bg-white hover:border-slate-300'
      }`}
    >
      <input
        type="radio" name="branch" value={value} checked={checked}
        onChange={() => onChange(value)}
        className="sr-only"
      />
      <div className="text-sm font-medium text-slate-900">{title}</div>
      <div className="text-xs text-slate-500 mt-1 leading-relaxed">{blurb}</div>
    </label>
  );
}
