'use client';

/**
 * Resolution form for unrecorded_link_payment todos.
 *
 * The Purchase Invoice already exists (created when the link was
 * confirmed). All that's needed is to post the matching Payment
 * Entry(s) so the buyer's AP clears and their cash balance reflects
 * the real outflow.
 *
 * Reuses the multi-leg payment UI from ResolveForm.js, minus the
 * vendor / cost / open-stock fields (already known from the PI).
 *
 * On submit, POSTs to /api/todos/[id]/resolve with { payment_legs: [...] }.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash } from '@phosphor-icons/react';

const PAYMENT_CODE = {
  Cash: '1000',
  Bank: '1100',
  'Credit Card': '2100',
};

function fmt(n) {
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export default function ResolveLinkPaymentForm({ todoId, payload, wallets }) {
  const router = useRouter();

  const totalCost = Number(payload?.amount) || 0;
  const currency = payload?.currency || 'USD';

  // Default to a single leg pre-filled with the full bill amount.
  const [legs, setLegs] = useState([{ wallet_erpnext_name: '', amount: totalCost ? String(totalCost) : '' }]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);

  const totalPaid = useMemo(
    () => legs.reduce((s, l) => s + (Number(l.amount) || 0), 0),
    [legs]
  );
  const outstanding = Math.max(0, totalCost - totalPaid);
  const overpaid = totalCost > 0 && totalPaid > totalCost + 0.001;

  function addLeg() {
    const remaining = Math.max(0, totalCost - totalPaid);
    setLegs([...legs, { wallet_erpnext_name: '', amount: remaining > 0 ? String(remaining) : '' }]);
  }
  function removeLeg(idx) {
    setLegs(legs.filter((_, i) => i !== idx));
  }
  function updateLeg(idx, patch) {
    setLegs(legs.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  async function submit(body) {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`/api/todos/${todoId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        setError(data.error || 'Could not resolve.');
        return;
      }
      setDone(data);
      // Bust the layout cache so the sidebar Todos badge re-fetches its
      // count on the way back to /todos. Pairs with the revalidatePath
      // call on the server.
      router.refresh();
      setTimeout(() => router.push('/todos'), 1200);
    } catch (err) {
      setError(err.message || 'Network error.');
    } finally {
      setBusy(false);
    }
  }

  function onSkip() {
    if (!confirm('Skip this todo? The bill stays on AP without a matching payment entry.')) return;
    submit({ skip: true });
  }

  function onSubmit(e) {
    e.preventDefault();
    if (legs.length === 0) {
      setError('Add at least one payment, or skip.');
      return;
    }
    if (overpaid) {
      setError('Total paid is more than the bill amount.');
      return;
    }
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
    submit({ payment_legs });
  }

  if (done) {
    return (
      <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50">
        <p className="text-sm text-emerald-900">
          ✅ Done.{' '}
          {done.action === 'link_payment_recorded' && Array.isArray(done.payment_entry_names) && (
            <>Posted {done.payment_entry_names.join(', ')} against {done.purchase_invoice_ref}.</>
          )}
          {done.action === 'skipped' && 'Todo skipped — no payment entry created.'}
          {' '}Returning to /todos…
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="bg-white border border-[var(--color-border)] rounded-xl p-5 space-y-5">
      {/* Context — bill summary from the payload */}
      {payload && (
        <div className="text-xs text-slate-500 grid grid-cols-2 sm:grid-cols-4 gap-3 pb-3 border-b border-slate-100">
          <div>
            <div className="uppercase tracking-wide text-[10px]">Supplier</div>
            <div className="text-sm text-slate-800 truncate">{payload.seller_label || '—'}</div>
          </div>
          <div>
            <div className="uppercase tracking-wide text-[10px]">Amount</div>
            <div className="text-sm text-slate-800 tabular">{fmt(totalCost)} {currency}</div>
          </div>
          <div>
            <div className="uppercase tracking-wide text-[10px]">Bill ref</div>
            <div className="text-sm text-slate-800 truncate font-mono">{payload.purchase_invoice_ref || '—'}</div>
          </div>
          <div>
            <div className="uppercase tracking-wide text-[10px]">Link</div>
            <div className="text-sm text-slate-800 tabular">LINK-{payload.link_id ?? '—'}</div>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-slate-700">Payments</div>
            <div className="text-[11px] text-slate-500">
              One leg = a single wallet. Add multiple to split across wallets. Partial OK — remainder stays as AP.
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
            No wallets found. Make sure you have at least one Cash or Bank account in your books.
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
                  Wallet is {w.currency} but bill is {currency} — we'll convert at today's exchange rate.
                </span>
              )}
            </div>
          );
        })}

        <div className="text-xs text-slate-600 tabular pt-2 grid grid-cols-3 gap-2">
          <div>Bill: <span className="font-medium">{fmt(totalCost)} {currency}</span></div>
          <div>Paid: <span className="font-medium">{fmt(totalPaid)} {currency}</span></div>
          <div className={outstanding > 0 ? 'text-amber-700' : 'text-emerald-700'}>
            {outstanding > 0
              ? `Outstanding: ${fmt(outstanding)} ${currency}`
              : 'Fully paid'}
          </div>
        </div>
      </div>

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
          disabled={busy || legs.length === 0}
          className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition disabled:opacity-50 font-medium"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
