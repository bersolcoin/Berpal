'use client';

/**
 * [+] on /team → a pop-up (full screen on mobile) to invite someone:
 * mobile number + role. No name — the person gives their own when they
 * accept (an admin's guess may be wrong). They accept after signing in with that
 * number; an SMS goes out only when invite SMS is switched on
 * (INVITE_SMS_ENABLED).
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Plus, X } from '@phosphor-icons/react';
import { isValidPhoneNumber, parsePhoneNumberFromString } from 'libphonenumber-js';
import CountrySelect from '../../login/CountrySelect';
import { ROLE_OPTIONS } from './roles';

export default function AddMember({ defaultCountry = 'US', smsOn }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [country, setCountry] = useState(defaultCountry || 'US');
  const [national, setNational] = useState('');
  const [role, setRole] = useState('staff');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null); // { phone, smsSent }

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && !busy && close();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  });

  function close() {
    setOpen(false);
    setNational('');
    setRole('staff');
    setError('');
    setDone(null);
  }

  function addAnother() {
    setDone(null);
    setNational('');
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!isValidPhoneNumber(national, country)) return setError('Enter a valid mobile number.');
    const phone = parsePhoneNumberFromString(national, country).format('E.164');
    setBusy(true);
    try {
      const res = await fetch('/api/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, role }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not send the invite.');
      setDone({ phone, smsSent: !!data.sms?.sent });
      router.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const input = 'w-full h-11 px-3 text-sm border border-slate-300 rounded-lg outline-none focus:border-slate-500 bg-white';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Invite someone"
        aria-label="Invite someone"
        className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-slate-900 text-white hover:bg-slate-800 transition"
      >
        <Plus size={18} weight="bold" />
      </button>

      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 flex md:items-center md:justify-center md:p-6" role="dialog" aria-modal="true" aria-label="Invite to team">
            <div className="hidden md:block absolute inset-0 bg-slate-900/40" onClick={() => !busy && close()} />
            <div className="relative flex flex-col w-full h-full md:h-auto md:max-w-md bg-white md:rounded-2xl md:shadow-2xl overflow-hidden">
              <div className="flex items-center justify-between h-14 px-4 md:px-6 border-b border-slate-100 shrink-0">
                <h2 className="text-base font-semibold text-slate-900">Invite to team</h2>
                <button type="button" onClick={close} disabled={busy} aria-label="Close" className="p-2 -mr-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900">
                  <X size={18} />
                </button>
              </div>

              {done ? (
                <div className="flex-1 px-4 md:px-6 py-6">
                  <p className="text-sm text-slate-800">
                    Invite ready for <strong className="tabular">{done.phone}</strong>.
                  </p>
                  <p className="mt-2 text-sm text-slate-500">
                    {done.smsSent
                      ? 'We’ve texted them. They sign in with this number and tap Join business.'
                      : 'Let them know to sign in with this number — the invite is waiting under Join business.'}
                  </p>
                  <div className="mt-6 flex gap-2">
                    <button type="button" onClick={addAnother} className="h-11 px-4 text-sm font-medium rounded-lg border border-slate-300 hover:border-slate-500">
                      Invite another
                    </button>
                    <button type="button" onClick={close} className="h-11 px-5 text-sm font-medium rounded-lg bg-slate-900 text-white hover:bg-slate-800">
                      Done
                    </button>
                  </div>
                </div>
              ) : (
                <form onSubmit={submit} className="flex-1 flex flex-col">
                  <div className="flex-1 px-4 md:px-6 py-5 space-y-4">
                    <div>
                      <span className="block text-sm font-medium text-slate-700 mb-1.5">Mobile number</span>
                      <div className="flex">
                        <CountrySelect value={country} onChange={setCountry} compact />
                        <input
                          type="tel"
                          inputMode="numeric"
                          autoFocus
                          value={national}
                          onChange={(e) => setNational(e.target.value.replace(/[^\d]/g, ''))}
                          className="flex-1 min-w-0 h-11 px-3 border-y border-r border-slate-300 rounded-r-lg outline-none focus:border-slate-500 text-sm tabular"
                        />
                      </div>
                    </div>

                    <label className="block">
                      <span className="block text-sm font-medium text-slate-700 mb-1.5">Role</span>
                      <select value={role} onChange={(e) => setRole(e.target.value)} className={`${input} pr-8 select-arrow`}>
                        {ROLE_OPTIONS.map(([v, l]) => (
                          <option key={v} value={v}>{l}</option>
                        ))}
                      </select>
                      <span className="block mt-1.5 text-xs text-slate-400">All roles have the same access for now.</span>
                    </label>

                    <p className="text-xs text-slate-500">
                      They sign in with this number and accept the invite to join.
                      {smsOn ? ' We’ll text them too.' : ''}
                    </p>
                    {error && <p className="text-sm text-red-700">{error}</p>}
                  </div>

                  <div className="flex items-center justify-end gap-2 px-4 md:px-6 py-3 border-t border-slate-100">
                    <button type="button" onClick={close} disabled={busy} className="h-11 px-4 text-sm font-medium text-slate-600 rounded-lg hover:bg-slate-100">
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={busy || !national}
                      className="h-11 px-5 text-sm font-medium rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
                    >
                      {busy ? 'Inviting…' : 'Send invite'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
