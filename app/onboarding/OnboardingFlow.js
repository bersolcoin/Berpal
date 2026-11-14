'use client';

/**
 * 3-step onboarding flow. Single client component — local state drives
 * which step renders. Step progress indicator at the top, Back/Next at
 * the bottom (with submit on step 3).
 *
 * Step 1: business type + entity type + business name + nature
 * Step 2: country + currency + tax id + address
 * Step 3: your name + email + cash wallet (with opening balance) + 0..N banks
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check } from '@phosphor-icons/react';
import CountryPicker from './CountryPicker';
import CurrencyPicker from './CurrencyPicker';

const TOTAL_STEPS = 3;

// Country → suggested default currency. User can always change in step 2.
const COUNTRY_DEFAULT_CURRENCY = {
  US: 'USD', GB: 'GBP', TH: 'THB', HK: 'HKD', SG: 'SGD',
  IN: 'INR', AU: 'AUD', CA: 'CAD', JP: 'JPY', CN: 'CNY',
  AE: 'AED', PH: 'PHP', MY: 'MYR', ID: 'IDR', VN: 'VND',
  KR: 'KRW', NZ: 'NZD', CH: 'CHF', NO: 'NOK', SE: 'SEK',
  DK: 'DKK', PL: 'PLN', BR: 'BRL', MX: 'MXN', ZA: 'ZAR',
  TR: 'TRY', SA: 'SAR', PK: 'PKR', BD: 'BDT', LK: 'LKR',
  NP: 'NPR', TW: 'TWD', EG: 'EGP', NG: 'NGN', KE: 'KES',
  RU: 'RUB', IL: 'ILS',
  // Eurozone
  DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR',
  AT: 'EUR', BE: 'EUR', IE: 'EUR', PT: 'EUR', FI: 'EUR',
  GR: 'EUR', LU: 'EUR', LT: 'EUR', LV: 'EUR', EE: 'EUR',
  SI: 'EUR', SK: 'EUR', MT: 'EUR', CY: 'EUR', HR: 'EUR',
};

const initialForm = {
  business_type: '',
  catalog_template: 'gemstones', // the only live catalog category for now
  entity_type: '',
  business_name: '',
  nature_of_business: '',
  country: '',
  default_currency: '',
  tax_id: '',
  address_line1: '',
  address_line2: '',
  city: '',
  state_province: '',
  postal_code: '',
  display_name: '',
  email: '',
  // Unified list — each wallet has its own type. First row pre-filled
  // with a cash wallet; user can change type, add more (cash OR bank),
  // or have multi-currency cash buckets.
  wallets: [{ type: 'cash', name: 'Cash', currency: '', opening_balance: '' }],
};

// `cancelHref`: set when adding another business — "Cancel" goes back
// there instead of the Logout button.
export default function OnboardingFlow({ defaultDisplayName = '', onBackToStart = null, cancelHref = null }) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  // Live provisioning progress for the overlay: { step, detail }.
  const [progress, setProgress] = useState({ step: null, detail: null });
  const [form, setForm] = useState({ ...initialForm, display_name: defaultDisplayName });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [countryAutoFilled, setCountryAutoFilled] = useState(false);

  // Best-effort IP geolocation for country + currency. Doesn't override if
  // user has already touched the country field.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('https://ipapi.co/json/', { cache: 'no-store' });
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled) return;
        setForm((prev) => {
          if (prev.country) return prev; // user already picked
          const cc = data.country_code;
          if (!cc) return prev;
          setCountryAutoFilled(true);
          const suggested = COUNTRY_DEFAULT_CURRENCY[cc] || 'USD';
          return {
            ...prev,
            country: cc,
            default_currency: prev.default_currency || suggested,
            // First wallet currency follows the default unless user already set it.
            wallets: prev.wallets.map((w, i) =>
              i === 0 && !w.currency ? { ...w, currency: suggested } : w
            ),
          };
        });
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // When country changes manually, suggest currency.
  function onCountryChange(cc) {
    setForm((prev) => {
      const suggested = COUNTRY_DEFAULT_CURRENCY[cc] || prev.default_currency || 'USD';
      const newDefault = prev.default_currency || suggested;
      return {
        ...prev,
        country: cc,
        default_currency: newDefault,
        // First wallet always tracks the active default currency. User-added
        // wallets keep whatever they had.
        wallets: prev.wallets.map((w, i) => (i === 0 ? { ...w, currency: newDefault } : w)),
      };
    });
  }

  function onCurrencyChange(ccy) {
    setForm((prev) => ({
      ...prev,
      default_currency: ccy,
      // First wallet always tracks the default currency.
      wallets: prev.wallets.map((w, i) => (i === 0 ? { ...w, currency: ccy } : w)),
    }));
  }

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function addWallet() {
    setForm((prev) => ({
      ...prev,
      wallets: [
        ...prev.wallets,
        { type: 'bank', name: '', currency: prev.default_currency || '', opening_balance: '' },
      ],
    }));
  }

  function updateWallet(idx, key, value) {
    setForm((prev) => {
      const wallets = prev.wallets.map((w, i) => (i === idx ? { ...w, [key]: value } : w));
      // Switching a row to cash: if its currency is already taken by another
      // cash wallet, move it to the first free currency.
      const w = wallets[idx];
      if (key === 'type' && value === 'cash') {
        const used = new Set(
          wallets
            .filter((x, j) => j !== idx && (j === 0 || x.type === 'cash'))
            .map((x) => (x.currency || prev.default_currency || '').toUpperCase())
        );
        const cur = (w.currency || prev.default_currency || '').toUpperCase();
        if (used.has(cur)) {
          const free = COMMON_CURRENCIES.find((c) => !used.has(c));
          if (free) wallets[idx] = { ...w, currency: free };
        }
      }
      return { ...prev, wallets };
    });
  }

  function removeWallet(idx) {
    setForm((prev) => ({
      ...prev,
      wallets: prev.wallets.filter((_, i) => i !== idx),
    }));
  }

  // Cash wallets aren't user-named: the default (row 0) is "Cash", extra
  // cash wallets are "Cash (<CCY>)". Only bank wallets take a typed name.
  function walletName(w, i) {
    if (i === 0) return 'Cash';
    if (w.type === 'cash') return `Cash (${(w.currency || form.default_currency || '').toUpperCase()})`;
    return w.name.trim();
  }
  // Wallet names must be unique (case-insensitive) — this also blocks a
  // second cash wallet in the same currency, since cash names derive from it.
  function isDuplicateName(w, i) {
    const name = walletName(w, i).toLowerCase();
    if (!name) return false;
    return form.wallets.some((x, j) => j < i && walletName(x, j).toLowerCase() === name) ||
      // "Cash (THB)" when THB is home currency duplicates the default "Cash".
      (i > 0 && w.type === 'cash' && cashCurrency(w) === cashCurrency(form.wallets[0]));
  }
  function cashCurrency(w) {
    return (w.currency || form.default_currency || '').toUpperCase();
  }
  // Currencies already taken by cash wallets other than row `idx`.
  function usedCashCurrencies(idx) {
    return new Set(
      form.wallets
        .filter((w, j) => j !== idx && (j === 0 || w.type === 'cash'))
        .map((w) => (w.currency || form.default_currency || '').toUpperCase())
    );
  }

  function step1Valid() {
    if (form.business_type !== 'service' && !form.catalog_template) return false;
    return form.business_type && form.entity_type && form.business_name.trim().length >= 2;
  }
  function step2Valid() {
    return form.country && /^[A-Z]{3}$/.test(form.default_currency);
  }
  function step3Valid() {
    if (!form.display_name.trim()) return false;
    // Every named wallet must have a name (we filter unnamed rows on submit
    // but require at least one named row so the new account has somewhere
    // to land its first transaction).
    const named = form.wallets.filter((w, i) => walletName(w, i));
    if (named.length === 0) return false;
    if (form.wallets.some(isDuplicateName)) return false;
    return true;
  }

  async function submit() {
    setError('');
    setProgress({ step: null, detail: null });
    if (!step1Valid() || !step2Valid() || !step3Valid()) {
      setError('Some required fields are missing.');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_type: form.business_type,
          catalog_template: form.business_type === 'service' ? null : form.catalog_template,
          entity_type: form.entity_type,
          business_name: form.business_name.trim(),
          nature_of_business: form.nature_of_business.trim() || null,
          country: form.country,
          default_currency: form.default_currency,
          tax_id: form.tax_id.trim() || null,
          address_line1: form.address_line1.trim() || null,
          address_line2: form.address_line2.trim() || null,
          city: form.city.trim() || null,
          state_province: form.state_province.trim() || null,
          postal_code: form.postal_code.trim() || null,
          display_name: form.display_name.trim(),
          email: form.email.trim() || null,
          wallets: form.wallets
            .map((w, i) => ({ ...w, name: walletName(w, i) }))
            .filter((w) => w.name)
            .map((w) => ({
              type: w.type === 'bank' ? 'bank' : 'cash',
              name: w.name,
              currency: (w.currency || form.default_currency).toUpperCase(),
              opening_balance: Number(w.opening_balance) || 0,
            })),
        }),
      });
      // Validation errors come back as plain JSON; provisioning streams
      // NDJSON progress lines (see app/api/onboarding/route.js).
      if (!r.ok || !(r.headers.get('content-type') || '').includes('ndjson')) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || 'Could not create your workspace.');
      }
      const done = await readProgressStream(r, (step, detail) =>
        setProgress((p) => ({ step, detail: detail || (p.step === step ? p.detail : null) }))
      );

      const fin = await fetch('/api/onboarding/finalize', { method: 'POST' });
      const finData = await fin.json().catch(() => ({}));
      if (!fin.ok || !finData.ok) throw new Error(finData.error || 'Could not open your workspace.');

      // Keep the overlay up (busy stays true) through navigation so the
      // form doesn't flash back before the dashboard renders.
      setProgress({ step: 'open', detail: null });
      router.replace(done.next || '/dashboard');
    } catch (err) {
      setError(err.message || 'Network error.');
      setProgress({ step: null, detail: null });
      setBusy(false);
    }
  }

  function next() {
    setError('');
    if (step === 1 && !step1Valid()) { setError('Please fill in the required fields.'); return; }
    if (step === 2 && !step2Valid()) { setError('Country and currency are required.'); return; }
    setStep((s) => Math.min(s + 1, TOTAL_STEPS));
  }

  function back() {
    setError('');
    setStep((s) => Math.max(s - 1, 1));
  }

  async function exit() {
    if (busy) return;
    if (!confirm('Log out? Anything you typed will be lost.')) return;
    setBusy(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* ignore — proceed to /login either way */
    }
    router.push('/login');
  }

  return (
    <div>
      {busy && step === TOTAL_STEPS && <CreatingOverlay progress={progress} />}
      <Stepper current={step} />

      {step === 1 && (
        <Step1
          form={form}
          setField={setField}
        />
      )}

      {step === 2 && (
        <Step2
          form={form}
          setField={setField}
          onCountryChange={onCountryChange}
          onCurrencyChange={onCurrencyChange}
          countryAutoFilled={countryAutoFilled}
        />
      )}

      {step === 3 && (
        <Step3
          form={form}
          // A person has one name across all their businesses — shown, not editable.
          lockName={!!defaultDisplayName}
          setField={setField}
          addWallet={addWallet}
          updateWallet={updateWallet}
          removeWallet={removeWallet}
          walletName={walletName}
          isDuplicateName={isDuplicateName}
          usedCashCurrencies={usedCashCurrencies}
        />
      )}

      <div className="mt-8 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={cancelHref ? () => router.push(cancelHref) : exit}
            disabled={busy}
            className="px-4 py-2.5 text-sm text-slate-500 hover:text-slate-900 hover:bg-slate-50 border border-slate-200 rounded-lg transition disabled:opacity-50"
          >
            {cancelHref ? 'Cancel' : 'Logout'}
          </button>
          {(step > 1 || onBackToStart) && (
            <button
              type="button"
              // Step 1 → back to the "new vs join" chooser.
              onClick={step > 1 ? back : onBackToStart}
              disabled={busy}
              className="px-4 py-2.5 text-sm text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition disabled:opacity-50"
            >
              ← Back
            </button>
          )}
        </div>

        {step < TOTAL_STEPS ? (
          <button
            type="button"
            onClick={next}
            disabled={busy}
            className="px-5 py-2.5 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition disabled:opacity-50 font-medium"
          >
            Continue →
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="px-5 py-2.5 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition disabled:opacity-50 font-medium"
          >
            {busy ? '…' : 'Create my workspace'}
          </button>
        )}
      </div>

      {error && (
        <p className="mt-3 text-sm text-red-700 text-right">{error}</p>
      )}
    </div>
  );
}

/**
 * Full-screen overlay shown while the workspace is being provisioned
 * (5–10s usually). Locks the UI so the user can't double-submit or
 * wander to a different step mid-flight.
 */
// Provisioning stages, in order — keys match onProgress() in
// src/erp-sync/provision.js, plus 'open' for the final navigation.
const PROGRESS_STEPS = [
  { key: 'company', label: 'Creating your company' },
  { key: 'access', label: 'Setting up secure access' },
  { key: 'workspace', label: 'Preparing your accounts' },
  { key: 'wallets', label: 'Adding your wallets' },
  { key: 'finish', label: 'Finishing up' },
  { key: 'open', label: 'Opening your dashboard' },
];

/**
 * Read the NDJSON progress stream from POST /api/onboarding. Calls
 * onStep(step, detail) per progress line; resolves with the 'done' event,
 * throws on an 'error' event or a stream that ends without one.
 */
async function readProgressStream(response, onStep) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const evt = JSON.parse(line);
      if (evt.type === 'progress') onStep(evt.step, evt.detail);
      else if (evt.type === 'error') throw new Error(evt.error || 'Could not create your workspace.');
      else if (evt.type === 'done') return evt;
    }
    if (done) throw new Error('Connection lost while creating your workspace. Please try again.');
  }
}

/**
 * Full-screen overlay shown while the workspace is being provisioned.
 * Shows a live checklist driven by the server's progress stream. Locks the
 * UI so the user can't double-submit or wander mid-flight.
 */
function CreatingOverlay({ progress }) {
  const current = PROGRESS_STEPS.findIndex((s) => s.key === progress.step);
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-100/95 backdrop-blur-sm px-6">
      <img src="/logo.svg" alt="Berpal" className="w-12 h-12 mb-6" />
      <p className="text-sm font-medium text-slate-900 mb-5">Creating your workspace…</p>
      <ol className="w-full max-w-xs space-y-3" aria-live="polite">
        {PROGRESS_STEPS.map((s, i) => {
          const state = i < current ? 'done' : i === current ? 'active' : 'pending';
          return (
            <li key={s.key} className="flex items-start gap-3">
              <span className="mt-0.5 w-5 h-5 shrink-0 flex items-center justify-center">
                {state === 'done' && (
                  <span className="w-5 h-5 rounded-full bg-emerald-600 text-white flex items-center justify-center">
                    <Check size={12} weight="bold" />
                  </span>
                )}
                {state === 'active' && (
                  <span
                    className="w-4 h-4 rounded-full border-2 border-slate-300 border-t-slate-900 animate-spin"
                    role="status"
                  />
                )}
                {state === 'pending' && <span className="w-2 h-2 rounded-full bg-slate-300" />}
              </span>
              <div className="min-w-0">
                <div className={`text-sm ${state === 'pending' ? 'text-slate-400' : 'text-slate-800'}`}>
                  {s.label}
                </div>
                {state === 'active' && progress.detail && (
                  <div className="text-xs text-slate-500 truncate">{progress.detail}</div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-6 text-xs text-slate-500">This can take up to a minute — please keep this page open.</p>
    </div>
  );
}

function Stepper({ current }) {
  const steps = [
    { num: 1, label: 'Your business' },
    { num: 2, label: 'Where you operate' },
    { num: 3, label: 'You + accounts' },
  ];
  return (
    <ol className="flex items-center gap-2 mb-8">
      {steps.map((s, i) => {
        const done = s.num < current;
        const active = s.num === current;
        return (
          <li key={s.num} className="flex items-center gap-2 flex-1">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium shrink-0 ${
                done
                  ? 'bg-emerald-600 text-white'
                  : active
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-200 text-slate-500'
              }`}
            >
              {done ? <Check size={14} weight="bold" /> : s.num}
            </div>
            <span className={`text-xs ${active ? 'text-slate-900 font-medium' : 'text-slate-500'} hidden sm:inline truncate`}>
              {s.label}
            </span>
            {i < steps.length - 1 && (
              <div className={`flex-1 h-px ${done ? 'bg-emerald-600' : 'bg-slate-200'}`} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ─── STEP 1 ──────────────────────────────────────────────────────────
function Step1({ form, setField }) {
  return (
    <div className="space-y-5">
      <Field label="What kind of business is this?" required>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {[
            { value: 'product', title: 'Physical', hint: 'Goods, retail, manufacturing' },
            { value: 'service', title: 'Service', hint: 'Consulting, freelance, agency' },
            { value: 'both', title: 'Both', hint: 'Mix of services and goods' },
          ].map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setField('business_type', o.value)}
              className={`p-3 text-left border rounded-lg transition ${
                form.business_type === o.value
                  ? 'border-slate-900 bg-slate-100 shadow-sm ring-1 ring-slate-900/10'
                  : 'border-slate-200 hover:border-slate-400 hover:bg-slate-50'
              }`}
            >
              <div className="text-sm font-medium text-slate-900">{o.title}</div>
              <div className="text-xs text-slate-500 mt-0.5">{o.hint}</div>
            </button>
          ))}
        </div>
      </Field>

      {form.business_type && form.business_type !== 'service' && (
        <Field label="What do you sell?" required>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {[
              { value: 'gemstones', title: 'Gemstones', hint: '17 gem families, 61 varieties, with gem details (carat, clarity, origin…)' },
              { value: 'watches', title: 'Watches', hint: 'Coming soon', soon: true },
            ].map((o) => (
              <button
                key={o.value}
                type="button"
                disabled={o.soon}
                onClick={() => setField('catalog_template', o.value)}
                className={`relative p-3 text-left border rounded-lg transition ${
                  o.soon
                    ? 'border-slate-200 bg-slate-50 opacity-60 cursor-not-allowed'
                    : form.catalog_template === o.value
                      ? 'border-slate-900 bg-slate-100 shadow-sm ring-1 ring-slate-900/10'
                      : 'border-slate-200 hover:border-slate-400 hover:bg-slate-50'
                }`}
              >
                {o.soon && (
                  <span className="absolute top-2 right-2 text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">Soon</span>
                )}
                <div className="text-sm font-medium text-slate-900">{o.title}</div>
                <div className="text-xs text-slate-500 mt-0.5">{o.hint}</div>
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-slate-500">More categories are added over time — switch them on from Inventory → ⚙.</p>
        </Field>
      )}

      <Field label="Who's running it?" required>
        <div className="grid grid-cols-2 gap-2">
          {[
            { value: 'individual', title: 'Individual', hint: 'Just me / freelancer' },
            { value: 'company', title: 'Company', hint: 'Ltd, Inc, LLC, etc.' },
          ].map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setField('entity_type', o.value)}
              className={`p-3 text-left border rounded-lg transition ${
                form.entity_type === o.value
                  ? 'border-slate-900 bg-slate-100 shadow-sm ring-1 ring-slate-900/10'
                  : 'border-slate-200 hover:border-slate-400 hover:bg-slate-50'
              }`}
            >
              <div className="text-sm font-medium text-slate-900">{o.title}</div>
              <div className="text-xs text-slate-500 mt-0.5">{o.hint}</div>
            </button>
          ))}
        </div>
      </Field>

      <Field label="Business name" required hint="The legal name of your business — used across your invoices and reports.">
        <input
          type="text"
          autoFocus
          value={form.business_name}
          onChange={(e) => setField('business_name', e.target.value)}
          className="w-full px-3 py-3 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-400"
          placeholder="Acme Trading Co"
        />
      </Field>

    </div>
  );
}

// ─── STEP 2 ──────────────────────────────────────────────────────────
function Step2({ form, setField, onCountryChange, onCurrencyChange, countryAutoFilled }) {
  return (
    <div className="space-y-5">
      <Field
        label="Country"
        required
        hint={countryAutoFilled && form.country ? 'Detected from your location — change if needed.' : 'Used to set up your country-appropriate chart of accounts.'}
      >
        <CountryPicker value={form.country} onChange={onCountryChange} />
      </Field>

      <Field label="Default currency" required hint="Your main reporting currency. You can still transact in other currencies later.">
        <CurrencyPicker value={form.default_currency} onChange={onCurrencyChange} />
      </Field>

      <Field label="Tax ID / VAT / GSTIN" hint="The tax number that appears on your invoices. Leave blank if you don't have one yet.">
        <input
          type="text"
          value={form.tax_id}
          onChange={(e) => setField('tax_id', e.target.value)}
          className="w-full px-3 py-3 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-400"
          placeholder="Optional"
        />
      </Field>

      <Field label="Business address" hint="Optional, but printed on your invoices when set.">
        <div className="space-y-2">
          <input
            type="text"
            value={form.address_line1}
            onChange={(e) => setField('address_line1', e.target.value)}
            placeholder="Street address"
            className="w-full px-3 py-3 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-400"
          />
          <input
            type="text"
            value={form.address_line2}
            onChange={(e) => setField('address_line2', e.target.value)}
            placeholder="Suite / floor / unit (optional)"
            className="w-full px-3 py-3 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-400"
          />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input
              type="text"
              value={form.city}
              onChange={(e) => setField('city', e.target.value)}
              placeholder="City"
              className="px-3 py-3 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-400"
            />
            <input
              type="text"
              value={form.state_province}
              onChange={(e) => setField('state_province', e.target.value)}
              placeholder="State / Province"
              className="px-3 py-3 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-400"
            />
            <input
              type="text"
              value={form.postal_code}
              onChange={(e) => setField('postal_code', e.target.value)}
              placeholder="Postal / ZIP"
              className="px-3 py-3 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-400 tabular"
            />
          </div>
        </div>
      </Field>
    </div>
  );
}

// ─── STEP 3 ──────────────────────────────────────────────────────────
function Step3({ form, setField, lockName = false, addWallet, updateWallet, removeWallet, walletName, isDuplicateName, usedCashCurrencies }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Your name" required>
          <input
            type="text"
            value={form.display_name}
            onChange={(e) => setField('display_name', e.target.value)}
            readOnly={lockName}
            aria-readonly={lockName}
            placeholder="First Last"
            className={`w-full px-3 py-3 text-sm border border-slate-300 rounded-lg outline-none ${
              lockName ? 'bg-slate-50 text-slate-500 cursor-not-allowed' : 'focus:border-slate-400'
            }`}
          />
        </Field>

        <Field label="Email" hint="Optional. We&rsquo;ll generate a placeholder if blank.">
          <input
            type="email"
            value={form.email}
            onChange={(e) => setField('email', e.target.value)}
            placeholder="you@example.com"
            className="w-full px-3 py-3 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-400"
          />
        </Field>
      </div>

      <div className="pt-2">
        <div className="text-sm font-medium text-slate-900 mb-1">Wallets</div>
        <div className="text-xs text-slate-500 mb-3">
          Cash drawers and bank accounts. Add one per currency you hold — a
          THB cash wallet AND a USD cash wallet is fine. Opening balances post
          to Opening Balance Equity automatically.
        </div>

        <div className="space-y-3 mb-3">
          {form.wallets.map((w, i) => {
            const isDefault = i === 0;
            const defaultCcy = w.currency || form.default_currency || '';

            // First wallet is the auto-provisioned default cash account in
            // the home currency — locked to type=cash, name=Cash, currency=
            // default. Only the opening balance is editable. Cannot be
            // removed. Prevents a class of onboarding mistakes.
            if (isDefault) {
              return (
                <div
                  key={i}
                  className="p-3 border border-slate-200 rounded-lg bg-slate-50/40"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <div className="text-sm font-medium text-slate-900">
                        Default cash wallet
                      </div>
                      <div className="text-xs text-slate-500">
                        Cash in {defaultCcy || 'your home currency'} — auto-created. Just set the starting balance.
                      </div>
                    </div>
                    <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">
                      Default
                    </span>
                  </div>
                  <div className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-4 sm:col-span-2 px-3 py-3 text-sm rounded-lg bg-slate-100 text-slate-500 select-none">
                      Cash
                    </div>
                    <div className="col-span-8 sm:col-span-4 px-3 py-3 text-sm rounded-lg bg-slate-100 text-slate-500 select-none">
                      Cash
                    </div>
                    <div className="col-span-4 sm:col-span-2 px-3 py-3 text-sm rounded-lg bg-slate-100 text-slate-500 select-none tabular">
                      {defaultCcy || '—'}
                    </div>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={w.opening_balance}
                      onChange={(e) => updateWallet(i, 'opening_balance', e.target.value)}
                      placeholder="Opening balance"
                      className="col-span-8 sm:col-span-4 px-3 py-3 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-400 tabular bg-white"
                    />
                  </div>
                </div>
              );
            }

            // Editable wallet — full form.
            return (
              <div
                key={i}
                className="p-3 border border-slate-200 rounded-lg bg-slate-50/40"
              >
                <div className="grid grid-cols-12 gap-2 items-center">
                  <select
                    value={w.type}
                    onChange={(e) => updateWallet(i, 'type', e.target.value)}
                    className="select-arrow col-span-4 sm:col-span-2 px-3 py-3 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-400 bg-white"
                  >
                    <option value="cash">Cash</option>
                    <option value="bank">Bank</option>
                  </select>
                  {w.type === 'cash' ? (
                    // Cash wallets are auto-named from their currency.
                    <div className="col-span-8 sm:col-span-4 px-3 py-3 text-sm rounded-lg bg-slate-100 text-slate-500 select-none">
                      {walletName(w, i)}
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={w.name}
                      onChange={(e) => updateWallet(i, 'name', e.target.value)}
                      placeholder="Kasikorn Savings"
                      className="col-span-8 sm:col-span-4 px-3 py-3 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-400"
                    />
                  )}
                  <select
                    value={w.currency || form.default_currency || ''}
                    onChange={(e) => updateWallet(i, 'currency', e.target.value)}
                    className="select-arrow col-span-4 sm:col-span-2 px-3 py-3 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-400 bg-white"
                  >
                    {!COMMON_CURRENCIES.includes(w.currency) && w.currency && (
                      <option value={w.currency}>{w.currency}</option>
                    )}
                    {COMMON_CURRENCIES
                      // Cash: hide currencies another cash wallet already uses.
                      .filter((c) => w.type !== 'cash' || c === (w.currency || form.default_currency) || !usedCashCurrencies(i).has(c))
                      .map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                  </select>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={w.opening_balance}
                    onChange={(e) => updateWallet(i, 'opening_balance', e.target.value)}
                    placeholder="Balance"
                    className="col-span-8 sm:col-span-4 px-3 py-3 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-400 tabular"
                  />
                </div>

                {isDuplicateName(w, i) && (
                  <p className="mt-2 text-xs text-red-700">
                    {w.type === 'cash'
                      ? 'You already have a cash wallet in this currency — pick another currency or remove this one.'
                      : 'You already have a wallet with this name — please use a different name.'}
                  </p>
                )}
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => removeWallet(i)}
                    className="text-xs text-slate-400 hover:text-red-600 transition"
                  >
                    Remove this wallet
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <button
          type="button"
          onClick={addWallet}
          className="text-sm text-[var(--color-brand-accent)] hover:underline"
        >
          + Add wallet
        </button>
      </div>
    </div>
  );
}

// Compact currency dropdown for inline wallet rows. Native <select> for
// brevity — uses the same currency list as CurrencyPicker.
const COMMON_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'HKD', 'THB', 'SGD', 'INR', 'AUD',
  'CAD', 'KRW', 'IDR', 'MYR', 'VND', 'PHP', 'AED', 'CHF', 'NZD', 'ZAR',
  'BRL', 'MXN', 'RUB', 'TRY', 'SAR', 'PKR', 'BDT', 'LKR', 'NPR', 'TWD',
  'NOK', 'SEK', 'DKK', 'PLN',
];

function Field({ label, hint, required, children }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-slate-900 mb-1.5">
        {label}
        {required && <span className="text-red-600 ml-0.5">*</span>}
      </span>
      {children}
      {hint && <span className="block text-xs text-slate-500 mt-1.5 leading-relaxed">{hint}</span>}
    </label>
  );
}
