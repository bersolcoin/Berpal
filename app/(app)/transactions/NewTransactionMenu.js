'use client';

/**
 * "+ New" dropdown on /transactions. Purchase is live; the other types are
 * listed (disabled) so the menu's shape is settled as each form lands.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Plus, ShoppingCart, Tag, Receipt, ArrowsLeftRight } from '@phosphor-icons/react';

const TYPES = [
  { key: 'purchase', label: 'Purchase', hint: 'Goods bought from a supplier', href: '/transactions/new/purchase', Icon: ShoppingCart },
  { key: 'sale', label: 'Sale', hint: 'Goods sold to a customer', Icon: Tag },
  { key: 'expense', label: 'Expense', hint: 'Rent, travel, fees…', Icon: Receipt },
  { key: 'transfer', label: 'Transfer', hint: 'Between your wallets', Icon: ArrowsLeftRight },
];

export default function NewTransactionMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="New transaction"
        title="New transaction"
        className="inline-flex items-center justify-center w-10 h-10 bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition"
      >
        <Plus size={18} weight="bold" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-2 w-64 bg-white border border-slate-200 rounded-xl shadow-lg py-1.5">
          {TYPES.map(({ key, label, hint, href, Icon }) =>
            href ? (
              <Link
                key={key}
                href={href}
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex items-start gap-3 px-3.5 py-2.5 hover:bg-slate-50"
              >
                <Icon size={18} className="mt-0.5 text-slate-700" />
                <span>
                  <span className="block text-sm text-slate-900">{label}</span>
                  <span className="block text-xs text-slate-500">{hint}</span>
                </span>
              </Link>
            ) : (
              <div key={key} role="menuitem" aria-disabled="true" className="flex items-start gap-3 px-3.5 py-2.5 opacity-50 cursor-not-allowed">
                <Icon size={18} className="mt-0.5 text-slate-500" />
                <span className="flex-1">
                  <span className="flex items-center justify-between text-sm text-slate-700">
                    {label}
                    <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">Soon</span>
                  </span>
                  <span className="block text-xs text-slate-500">{hint}</span>
                </span>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
