'use client';

/**
 * First screen after sign-up — and for "New business" in the sidebar's
 * business switcher: set up a new business, or join one you've been
 * invited to. "Join business" is live only with invites to this number
 * (shows the count); without, it's grey — "You do not have any invite".
 * There's no searching for businesses: a business invites you from its
 * Team page. Picking "new" reveals the 3-step OnboardingFlow; "join"
 * lists the invites (Join / Decline).
 *
 * `hasBusiness`: the person already runs a business — show "Back to
 * dashboard" instead of Logout. `displayName` prefills "your name".
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Buildings, UsersThree } from '@phosphor-icons/react';
import OnboardingFlow from './OnboardingFlow';

const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', manager: 'Manager', staff: 'Staff' };

export default function OnboardingStart({ phone, hasBusiness = false, displayName = '', invites: initialInvites = [] }) {
  const router = useRouter();
  const [mode, setMode] = useState(null); // null | 'new' | 'join'
  const [invites, setInvites] = useState(initialInvites);
  const [busy, setBusy] = useState(null); // invite id being answered
  const [error, setError] = useState('');
  // New people give their own name before joining (an inviter's guess may
  // be wrong). Someone who already has one keeps it — one name across all
  // their businesses — so it's shown greyed, not editable.
  const [name, setName] = useState(displayName);
  const needName = !displayName;

  async function answer(invite, accept) {
    if (accept && needName && !name.trim()) return setError('Please enter your name first.');
    setBusy(invite.id);
    setError('');
    try {
      const res = await fetch(`/api/invites/${invite.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accept, ...(accept && needName ? { name: name.trim() } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Something went wrong.');
      if (data.next) return window.location.assign(data.next); // full reload into the business
      const left = invites.filter((i) => i.id !== invite.id);
      setInvites(left);
      if (!left.length) setMode(null);
      setBusy(null);
    } catch (err) {
      setError(err.message);
      setBusy(null);
    }
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* ignore — proceed to /login either way */
    }
    router.push('/login');
  }

  const signedInAs = phone && (
    <p className="text-xs text-slate-400 mb-8">
      Signed in as <strong className="text-slate-600">{phone}</strong>
    </p>
  );

  if (mode === 'new') {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight mb-1">{hasBusiness ? 'Set up another business' : 'Set up your business'}</h1>
        <p className="text-sm text-slate-600 mb-2">
          A few quick questions to set up your accounting workspace. Most fields are optional and editable later.
        </p>
        {signedInAs || <div className="mb-8" />}
        <OnboardingFlow
          onBackToStart={() => setMode(null)}
          defaultDisplayName={displayName}
          cancelHref={hasBusiness ? '/dashboard' : null}
        />
      </>
    );
  }

  if (mode === 'join') {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight mb-1">Join business</h1>
        <p className="text-sm text-slate-600 mb-2">Invites to your number. Joining opens the business right away.</p>
        {signedInAs || <div className="mb-8" />}
        <label className="block mb-5">
          <span className="block text-sm font-medium text-slate-700 mb-1.5">Your name</span>
          <input
            autoFocus={needName}
            value={name}
            onChange={(e) => setName(e.target.value)}
            readOnly={!needName}
            aria-readonly={!needName}
            maxLength={80}
            placeholder="As your team should see it"
            className={`w-full h-11 px-3 text-sm border border-slate-300 rounded-lg outline-none ${
              needName ? 'bg-white focus:border-slate-500' : 'bg-slate-50 text-slate-500 cursor-not-allowed'
            }`}
          />
        </label>
        <div className="space-y-3">
          {invites.map((i) => (
            <div key={i.id} className="flex flex-wrap items-center gap-3 p-4 border border-slate-300 rounded-xl bg-white">
              <Buildings size={24} className="text-slate-900 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-900 truncate">{i.business_name}</div>
                <div className="text-xs text-slate-500">
                  {ROLE_LABELS[i.role] || i.role}
                  {i.invited_by_name ? ` · invited by ${i.invited_by_name}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => answer(i, false)}
                  disabled={busy != null}
                  className="h-10 px-4 text-sm text-slate-600 rounded-lg hover:bg-slate-100 disabled:opacity-50"
                >
                  Decline
                </button>
                <button
                  type="button"
                  onClick={() => answer(i, true)}
                  disabled={busy != null}
                  className="h-10 px-5 text-sm font-medium rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {busy === i.id ? 'Joining…' : 'Join'}
                </button>
              </div>
            </div>
          ))}
        </div>
        {error && <p className="mt-4 text-sm text-red-700">{error}</p>}
        <div className="mt-8">
          <button
            type="button"
            onClick={() => setMode(null)}
            className="px-4 py-2.5 text-sm text-slate-500 hover:text-slate-900 hover:bg-slate-50 border border-slate-200 rounded-lg transition"
          >
            Back
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight mb-1">{hasBusiness ? 'New business' : 'Welcome'}</h1>
      <p className="text-sm text-slate-600 mb-2">
        {hasBusiness ? 'Your current businesses stay as they are — switch between them from the sidebar.' : 'How would you like to get started?'}
      </p>
      {signedInAs || <div className="mb-8" />}

      <div className="grid sm:grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setMode('new')}
          className="text-left p-5 border border-slate-300 rounded-xl bg-white hover:border-slate-900 hover:shadow-sm transition"
        >
          <Buildings size={28} className="text-slate-900 mb-3" />
          <div className="text-sm font-medium text-slate-900">Set up new business</div>
          <div className="text-xs text-slate-500 mt-1">
            Create your own accounting workspace. You’ll be the owner.
          </div>
        </button>

        {invites.length > 0 ? (
          <button
            type="button"
            onClick={() => setMode('join')}
            className="relative text-left p-5 border border-slate-300 rounded-xl bg-white hover:border-slate-900 hover:shadow-sm transition"
          >
            <span className="absolute top-3 right-3 min-w-[22px] h-[22px] px-1.5 rounded-full bg-[var(--color-brand-accent)] text-white text-xs font-medium inline-flex items-center justify-center tabular">
              {invites.length}
            </span>
            <UsersThree size={28} className="text-slate-900 mb-3" />
            <div className="text-sm font-medium text-slate-900">Join business</div>
            <div className="text-xs text-slate-500 mt-1">
              {invites.length === 1 ? `${invites[0].business_name} invited you.` : `${invites.length} businesses invited you.`}
            </div>
          </button>
        ) : (
          <div
            aria-disabled="true"
            className="relative text-left p-5 border border-slate-200 rounded-xl bg-slate-50 opacity-60 cursor-not-allowed select-none"
          >
            <UsersThree size={28} className="text-slate-500 mb-3" />
            <div className="text-sm font-medium text-slate-700">Join business</div>
            <div className="text-xs text-slate-500 mt-1">You do not have any invite.</div>
          </div>
        )}
      </div>

      <div className="mt-8">
        {hasBusiness ? (
          <button
            type="button"
            onClick={() => router.push('/dashboard')}
            className="px-4 py-2.5 text-sm text-slate-500 hover:text-slate-900 hover:bg-slate-50 border border-slate-200 rounded-lg transition"
          >
            Back to dashboard
          </button>
        ) : (
          <button
            type="button"
            onClick={logout}
            className="px-4 py-2.5 text-sm text-slate-500 hover:text-slate-900 hover:bg-slate-50 border border-slate-200 rounded-lg transition"
          >
            Logout
          </button>
        )}
      </div>
    </>
  );
}
