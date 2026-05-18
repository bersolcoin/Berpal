'use client';

/**
 * Currency picker — small popover, type-to-filter. Uses our format.js's
 * currencyToCountry mapping so each option shows a real flag.
 *
 * Keep the list opinionated: the 40 most-likely currencies for our user
 * base. Users can still type a code we don't list, but the dropdown only
 * surfaces the ones we visually support.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { CaretDown } from '@phosphor-icons/react';

const CURRENCIES = [
  { code: 'USD', name: 'US Dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British Pound' },
  { code: 'JPY', name: 'Japanese Yen' },
  { code: 'CNY', name: 'Chinese Yuan' },
  { code: 'HKD', name: 'Hong Kong Dollar' },
  { code: 'THB', name: 'Thai Baht' },
  { code: 'SGD', name: 'Singapore Dollar' },
  { code: 'INR', name: 'Indian Rupee' },
  { code: 'AUD', name: 'Australian Dollar' },
  { code: 'CAD', name: 'Canadian Dollar' },
  { code: 'KRW', name: 'South Korean Won' },
  { code: 'IDR', name: 'Indonesian Rupiah' },
  { code: 'MYR', name: 'Malaysian Ringgit' },
  { code: 'VND', name: 'Vietnamese Dong' },
  { code: 'PHP', name: 'Philippine Peso' },
  { code: 'AED', name: 'UAE Dirham' },
  { code: 'CHF', name: 'Swiss Franc' },
  { code: 'NZD', name: 'New Zealand Dollar' },
  { code: 'ZAR', name: 'South African Rand' },
  { code: 'BRL', name: 'Brazilian Real' },
  { code: 'MXN', name: 'Mexican Peso' },
  { code: 'RUB', name: 'Russian Ruble' },
  { code: 'TRY', name: 'Turkish Lira' },
  { code: 'SAR', name: 'Saudi Riyal' },
  { code: 'PKR', name: 'Pakistani Rupee' },
  { code: 'BDT', name: 'Bangladeshi Taka' },
  { code: 'LKR', name: 'Sri Lankan Rupee' },
  { code: 'NPR', name: 'Nepalese Rupee' },
  { code: 'TWD', name: 'Taiwan Dollar' },
  { code: 'NOK', name: 'Norwegian Krone' },
  { code: 'SEK', name: 'Swedish Krona' },
  { code: 'DKK', name: 'Danish Krone' },
  { code: 'PLN', name: 'Polish Złoty' },
  { code: 'CZK', name: 'Czech Koruna' },
  { code: 'HUF', name: 'Hungarian Forint' },
  { code: 'ILS', name: 'Israeli Shekel' },
  { code: 'EGP', name: 'Egyptian Pound' },
  { code: 'NGN', name: 'Nigerian Naira' },
  { code: 'KES', name: 'Kenyan Shilling' },
];

const CURRENCY_TO_COUNTRY = {
  USD: 'us', EUR: 'eu', GBP: 'gb', JPY: 'jp', CNY: 'cn',
  HKD: 'hk', THB: 'th', SGD: 'sg', INR: 'in', AUD: 'au',
  CAD: 'ca', KRW: 'kr', IDR: 'id', MYR: 'my', VND: 'vn',
  PHP: 'ph', AED: 'ae', CHF: 'ch', NZD: 'nz', ZAR: 'za',
  BRL: 'br', MXN: 'mx', RUB: 'ru', TRY: 'tr', SAR: 'sa',
  PKR: 'pk', BDT: 'bd', LKR: 'lk', NPR: 'np', TWD: 'tw',
  NOK: 'no', SEK: 'se', DKK: 'dk', PLN: 'pl', CZK: 'cz',
  HUF: 'hu', ILS: 'il', EGP: 'eg', NGN: 'ng', KES: 'ke',
};

function flagClass(code) {
  const cc = CURRENCY_TO_COUNTRY[code];
  return cc ? `fi fi-${cc} fis` : 'inline-block w-5 h-5 bg-slate-200 rounded-sm';
}

export default function CurrencyPicker({ value, onChange, placeholder = 'Currency' }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const ref = useRef(null);
  const inputRef = useRef(null);

  const selected = CURRENCIES.find((c) => c.code === value);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
    else setFilter('');
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return CURRENCIES;
    return CURRENCIES.filter(
      (c) => c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
    );
  }, [filter]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-3 border border-slate-300 rounded-lg bg-white hover:bg-slate-50 transition text-left"
      >
        {selected ? (
          <>
            <span className={`${flagClass(selected.code)} rounded-sm shrink-0 w-5 h-5`} aria-hidden="true" />
            <span className="text-sm text-slate-900 font-medium">{selected.code}</span>
            <span className="text-sm text-slate-500 flex-1 truncate">{selected.name}</span>
          </>
        ) : (
          <span className="text-sm text-slate-400 flex-1">{placeholder}</span>
        )}
        <CaretDown size={12} weight="regular" className="text-slate-400 shrink-0" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-72 overflow-hidden bg-white border border-slate-200 rounded-lg shadow-lg flex flex-col">
          <div className="p-2 border-b border-slate-200 bg-slate-50">
            <input
              ref={inputRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search currency…"
              className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded outline-none focus:border-slate-400"
            />
          </div>
          <ul className="flex-1 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-slate-400">No matches</li>
            ) : (
              filtered.map((c) => (
                <li key={c.code}>
                  <button
                    type="button"
                    onClick={() => { onChange(c.code); setOpen(false); }}
                    className={`w-full flex items-center gap-3 px-3 py-2 text-sm text-left hover:bg-slate-100 transition ${
                      c.code === value ? 'bg-slate-100' : ''
                    }`}
                  >
                    <span className={`${flagClass(c.code)} rounded-sm shrink-0 w-5 h-5`} aria-hidden="true" />
                    <span className="font-medium text-slate-900 w-12">{c.code}</span>
                    <span className="flex-1 truncate text-slate-600">{c.name}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

export { CURRENCIES };
