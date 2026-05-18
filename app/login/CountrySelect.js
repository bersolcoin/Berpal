'use client';

/**
 * Country picker for phone-number entry — flag + country name + dial code.
 * Native <select> can't render flag SVGs, so this is a small custom popover
 * with type-to-filter. Closes on outside click or item select.
 *
 * Props:
 *   value:    ISO 3166-1 alpha-2 country code (e.g. 'TH')
 *   onChange: (country) => void
 *   countries (optional): override the country list (defaults to all of
 *                         libphonenumber-js's known countries)
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { getCountries, getCountryCallingCode } from 'libphonenumber-js';
import { CaretDown } from '@phosphor-icons/react';

const DISPLAY_NAMES = typeof Intl !== 'undefined' && Intl.DisplayNames
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null;

function countryName(code) {
  if (DISPLAY_NAMES) {
    try {
      return DISPLAY_NAMES.of(code) || code;
    } catch {
      return code;
    }
  }
  return code;
}

function buildCountries() {
  return getCountries()
    .map((code) => {
      let dialCode;
      try {
        dialCode = `+${getCountryCallingCode(code)}`;
      } catch {
        dialCode = '';
      }
      return { code, name: countryName(code), dialCode };
    })
    .filter((c) => c.dialCode)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export default function CountrySelect({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const ref = useRef(null);
  const inputRef = useRef(null);

  const countries = useMemo(() => buildCountries(), []);
  const selected = countries.find((c) => c.code === value);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    } else {
      setFilter('');
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return countries;
    return countries.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.code.toLowerCase().includes(q) ||
        c.dialCode.includes(q)
    );
  }, [filter, countries]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-3 border border-slate-300 rounded-l-lg bg-white hover:bg-slate-50 transition min-w-[110px]"
      >
        {selected ? (
          <>
            <span className={`fi fi-${selected.code.toLowerCase()} fis rounded-sm shrink-0 w-5 h-5`} aria-hidden="true" />
            <span className="text-sm font-medium text-slate-700">{selected.dialCode}</span>
          </>
        ) : (
          <span className="text-sm text-slate-400">Country</span>
        )}
        <CaretDown size={12} weight="regular" className="ml-auto text-slate-400" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-72 max-h-80 overflow-hidden bg-white border border-slate-200 rounded-lg shadow-lg flex flex-col">
          <div className="p-2 border-b border-slate-200 bg-slate-50">
            <input
              ref={inputRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search country or code…"
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
                    onClick={() => {
                      onChange(c.code);
                      setOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2 text-sm text-left hover:bg-slate-100 transition ${
                      c.code === value ? 'bg-slate-100' : ''
                    }`}
                  >
                    <span className={`fi fi-${c.code.toLowerCase()} fis rounded-sm shrink-0 w-5 h-5`} aria-hidden="true" />
                    <span className="flex-1 truncate text-slate-800">{c.name}</span>
                    <span className="text-slate-500 tabular text-xs">{c.dialCode}</span>
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
