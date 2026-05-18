'use client';

/**
 * Login page — country picker + national phone number → 6-digit OTP → session.
 *
 * Phone is assembled into E.164 (+<dial><national>) before submit. On mount
 * we ping ipapi.co to pre-select the user's country (best-effort; if the
 * lookup fails we just default to US).
 *
 * Sandbox mode: OTP is a plain WhatsApp text. The user must have first
 * joined the Twilio sandbox by sending the join code to +1 415 523 8886.
 */

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  getCountryCallingCode,
  isValidPhoneNumber,
  parsePhoneNumberFromString,
  getExampleNumber,
} from 'libphonenumber-js';
import examples from 'libphonenumber-js/examples.mobile.json';
import CountrySelect from './CountrySelect';

const STEPS = { PHONE: 'phone', CODE: 'code' };
const DEFAULT_COUNTRY = 'US';

/**
 * National-formatted example number for the selected country, e.g.
 *   US → "(201) 555-0123"
 *   TH → "081 234 5678"
 *   HK → "5123 4567"
 * Falls back to a generic placeholder if the country has no example.
 */
function placeholderFor(country) {
  try {
    const ex = getExampleNumber(country, examples);
    if (ex) return ex.formatNational();
  } catch {
    /* fall through */
  }
  return '818-8888';
}

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState(STEPS.PHONE);
  // Country starts empty — we wait on IP geolocation before populating so
  // the user never sees a flash of the wrong country (US default → TH).
  // detecting=true gates the form render while we await IP (with a hard
  // 2.5s ceiling so a slow / blocked lookup doesn't strand the user).
  const [country, setCountry] = useState('');
  const [detecting, setDetecting] = useState(true);
  const [national, setNational] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const finish = (cc) => {
      if (cancelled) return;
      setCountry(cc || DEFAULT_COUNTRY);
      setDetecting(false);
    };

    // Hard ceiling so blocked / slow IP lookups don't strand the user.
    const timeout = setTimeout(() => finish(null), 2500);

    (async () => {
      try {
        const r = await fetch('https://ipapi.co/json/', { cache: 'no-store' });
        if (!r.ok) return finish(null);
        const data = await r.json();
        clearTimeout(timeout);
        finish(data.country_code || null);
      } catch {
        clearTimeout(timeout);
        finish(null);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, []);

  function buildE164() {
    let dial;
    try {
      dial = `+${getCountryCallingCode(country)}`;
    } catch {
      return null;
    }
    const cleaned = String(national).replace(/[^\d]/g, '');
    if (!cleaned) return null;
    const candidate = `${dial}${cleaned}`;
    if (!isValidPhoneNumber(candidate, country)) return null;
    const parsed = parsePhoneNumberFromString(candidate, country);
    return parsed?.number || candidate;
  }

  async function submitPhone(e) {
    e.preventDefault();
    setError('');
    setInfo('');
    const phone = buildE164();
    if (!phone) {
      setError('That phone number doesn’t look right. Check the country and digits.');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/auth/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        setError(data.error || 'Could not send code.');
        return;
      }
      setStep(STEPS.CODE);
      setInfo(`Code sent via WhatsApp to ${phone}. Check your messages.`);
    } catch (err) {
      setError(err.message || 'Network error.');
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e) {
    e.preventDefault();
    setError('');
    const phone = buildE164();
    if (!phone) {
      setError('Phone number is invalid.');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code: code.trim() }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        setError(data.error || 'Invalid code.');
        return;
      }
      router.push(data.onboarded ? '/dashboard' : '/onboarding');
    } catch (err) {
      setError(err.message || 'Network error.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="max-w-md mx-auto px-6 py-6 sm:py-16">
      <img src="/logo.svg" alt="Berpal" className="w-8 h-8 sm:w-9 sm:h-9 mb-4 sm:mb-8" />
      <h1 className="text-xl sm:text-2xl font-semibold tracking-tight mb-1.5 sm:mb-2">Sign in</h1>
      <p className="text-sm text-slate-600 mb-4 sm:mb-6">
        {step === STEPS.PHONE
          ? 'Enter your WhatsApp number — we’ll text you a one-time code.'
          : 'Enter the 6-digit code we just sent you.'}
      </p>

      {step === STEPS.PHONE && (
        <form onSubmit={submitPhone} className="space-y-4">
          {/* Not a <label> wrapper — the country trigger is a <button>, and
              implicit label association causes browsers to forward the
              click to the input, which prevents the popover from opening.
              Heading is a sibling span. */}
          <div className="block">
            <span className="block text-sm font-medium text-slate-700 mb-1.5">Phone number</span>
            <div className="flex">
              <CountrySelect value={country} onChange={setCountry} />
              <input
                type="tel"
                inputMode="numeric"
                pattern="[0-9]*"
                autoFocus
                placeholder={placeholderFor(country)}
                value={national}
                onKeyDown={(e) => {
                  // Allow control keys + digits only. Blocks letters,
                  // symbols, paste of mixed content, etc.
                  if (
                    e.metaKey || e.ctrlKey || e.altKey ||
                    ['Backspace', 'Delete', 'Tab', 'Enter', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)
                  ) return;
                  if (!/^[0-9]$/.test(e.key)) e.preventDefault();
                }}
                onChange={(e) => setNational(e.target.value.replace(/[^\d]/g, ''))}
                disabled={busy}
                className="flex-1 min-w-0 px-3 py-3 border-y border-r border-slate-300 rounded-r-lg outline-none focus:border-slate-400 text-base tabular"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={busy || !national || !country}
            className="w-full py-3 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 disabled:opacity-50 transition"
          >
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </form>
      )}

      {step === STEPS.CODE && (
        <form onSubmit={submitCode} className="space-y-4">
          <label className="block">
            <span className="block text-sm font-medium text-slate-700 mb-1.5">6-digit code</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              disabled={busy}
              className="w-full px-3 py-3 border border-slate-300 rounded-lg outline-none focus:border-slate-400 text-2xl tabular text-center tracking-[0.4em]"
            />
          </label>
          <button
            type="submit"
            disabled={busy || code.length !== 6}
            className="w-full py-3 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 disabled:opacity-50 transition"
          >
            {busy ? 'Verifying…' : 'Verify'}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep(STEPS.PHONE);
              setCode('');
              setError('');
              setInfo('');
            }}
            disabled={busy}
            className="text-sm text-slate-500 hover:text-slate-900 transition"
          >
            ← Use a different number
          </button>
        </form>
      )}

      {info && <p className="mt-4 text-sm text-emerald-700">{info}</p>}
      {error && <p className="mt-4 text-sm text-red-700">{error}</p>}

      <div className="mt-6 sm:mt-12">
        <p className="text-xs text-slate-500 leading-relaxed mb-2 sm:mb-3">
          Sandbox mode — first time? Join the Twilio WhatsApp sandbox.
          Opens WhatsApp with the join code pre-filled.
        </p>
        <a
          href="https://wa.me/14155238886?text=join%20explore-individual"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 w-full py-3 bg-orange-500 hover:bg-orange-600 text-white rounded-lg text-sm font-medium transition"
        >
          Join Twilio sandbox →
        </a>
      </div>
    </main>
  );
}
