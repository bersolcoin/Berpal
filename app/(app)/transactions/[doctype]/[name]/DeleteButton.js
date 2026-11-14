'use client';

/**
 * Delete-transaction button for the detail page. Confirm-on-click;
 * sends a DELETE to /api/transactions/[doctype]/[name]. On success,
 * redirects back to the transactions list.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash } from '@phosphor-icons/react';

export default function DeleteButton({ doctype, name }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function doDelete() {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(
        `/api/transactions/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
        { method: 'DELETE' }
      );
      const data = await r.json();
      if (!r.ok || !data.ok) {
        setError(data.error || 'Could not delete.');
        return;
      }
      router.push('/transactions');
      router.refresh();
    } catch (err) {
      setError(err.message || 'Network error.');
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="inline-flex items-center gap-1.5 h-10 px-3 text-sm text-red-700 hover:text-red-900 hover:bg-red-50 rounded-lg border border-red-200 bg-white transition"
      >
        <Trash size={14} weight="regular" />
        Delete
      </button>
    );
  }

  return (
    <div className="inline-flex items-center gap-2">
      <span className="text-sm text-slate-700">Delete this {doctype.toLowerCase()}?</span>
      <button
        type="button"
        onClick={doDelete}
        disabled={busy}
        className="text-sm text-white bg-red-600 hover:bg-red-700 px-3 py-1.5 rounded-md disabled:opacity-50 transition"
      >
        {busy ? 'Deleting…' : 'Yes, delete'}
      </button>
      <button
        type="button"
        onClick={() => { setConfirming(false); setError(''); }}
        disabled={busy}
        className="text-sm text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-md transition"
      >
        Cancel
      </button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}
