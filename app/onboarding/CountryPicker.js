'use client';

/**
 * Country picker for non-phone contexts (onboarding, address forms).
 * Same UX as login/CountrySelect but shows the country NAME on the trigger
 * instead of the dial code. Reuses libphonenumber-js for the canonical
 * country list (every shipping country has a dial code so coverage is full).
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { getCountries } from 'libphonenumber-js';
import { CaretDown } from '@phosphor-icons/react';

const DISPLAY_NAMES = typeof Intl !== 'undefined' && Intl.DisplayNames
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null;

function countryName(code) {
  if (DISPLAY_NAMES) {
    try { return DISPLAY_NAMES.of(code) || code; } catch { return code; }
  }
  return code;
}

function buildCountries() {
  return getCountries()
    .map((code) => ({ code, name: countryName(code) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export default function CountryPicker({ value, onChange, placeholder = 'Choose country…' }) {
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
    if (open && inputRef.current) inputRef.current.focus();
    else setFilter('');
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return countries;
    return countries.filter(
      (c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)
    );
  }, [filter, countries]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-3 py-3 border border-slate-300 rounded-lg bg-white hover:bg-slate-50 transition text-left"
      >
        {selected ? (
          <>
            <span className={`fi fi-${selected.code.toLowerCase()} fis rounded-sm shrink-0 w-5 h-5`} aria-hidden="true" />
            <span className="text-sm text-slate-900 flex-1 truncate">{selected.name}</span>
          </>
        ) : (
          <span className="text-sm text-slate-400 flex-1">{placeholder}</span>
        )}
        <CaretDown size={12} weight="regular" className="text-slate-400 shrink-0" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-80 overflow-hidden bg-white border border-slate-200 rounded-lg shadow-lg flex flex-col">
          <div className="p-2 border-b border-slate-200 bg-slate-50">
            <input
              ref={inputRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search…"
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
                    <span className={`fi fi-${c.code.toLowerCase()} fis rounded-sm shrink-0 w-5 h-5`} aria-hidden="true" />
                    <span className="flex-1 truncate text-slate-800">{c.name}</span>
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
