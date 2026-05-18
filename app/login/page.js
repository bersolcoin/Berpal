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

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getCountryCallingCode, isValidPhoneNumber, parsePhoneNumberFromString } from 'libphonenumber-js';
import CountrySelect from './CountrySelect';

const STEPS = { PHONE: 'phone', CODE: 'code' };
const DEFAULT_COUNTRY = 'US';

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState(STEPS.PHONE);
  const [country, setCountry] = useState(DEFAULT_COUNTRY);
  const [national, setNational] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [ipDetected, setIpDetected] = useState(false);

  // Best-effort IP geolocation. Don't override if the user has already
  // touched the country picker (we infer that from `ipDetected`).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('https://ipapi.co/json/', { cache: 'no-store' });
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled && data.country_code && !ipDetected) {
          setCountry(data.country_code);
          setIpDetected(true);
        }
      } catch {
        /* swallow — IP lookup is a nice-to-have */
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentional: only on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <main className="max-w-md mx-auto px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight mb-2">Sign in to Berpal</h1>
      <p className="text-sm text-slate-600 mb-8">
        {step === STEPS.PHONE
          ? 'Enter your WhatsApp number — we’ll text you a one-time code.'
          : 'Enter the 6-digit code we just sent you.'}
      </p>

      {step === STEPS.PHONE && (
        <form onSubmit={submitPhone} className="space-y-4">
          <label className="block">
            <span className="block text-sm font-medium text-slate-700 mb-1.5">Phone number</span>
            <div className="flex">
              <CountrySelect value={country} onChange={setCountry} />
              <input
                type="tel"
                inputMode="tel"
                autoFocus
                placeholder="838883866"
                value={national}
                onChange={(e) => setNational(e.target.value.replace(/[^\d\s]/g, ''))}
                disabled={busy}
                className="flex-1 min-w-0 px-3 py-3 border-y border-r border-slate-300 rounded-r-lg outline-none focus:border-slate-400 text-base tabular"
              />
            </div>
          </label>
          <button
            type="submit"
            disabled={busy || !national}
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

      <p className="mt-12 text-xs text-slate-500 leading-relaxed">
        Sandbox mode: you must first join the Twilio WhatsApp sandbox by
        messaging the join code to <code className="font-mono">+1 415 523 8886</code>.
      </p>
    </main>
  );
}
