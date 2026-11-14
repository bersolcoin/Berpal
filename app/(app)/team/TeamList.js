'use client';

/**
 * Team of the active business: members (role changeable except the
 * owner; remove — not the owner, not yourself), then invites still
 * waiting for the person to accept (text again when invite SMS is on;
 * cancel).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash, PaperPlaneTilt, X } from '@phosphor-icons/react';
import { date } from '../_components/format';
import { ROLE_LABELS, ROLE_OPTIONS } from './roles';

async function send(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

const Avatar = ({ label }) => (
  <span className="w-9 h-9 shrink-0 rounded-full bg-slate-100 text-slate-600 text-sm font-medium flex items-center justify-center">
    {(label || '#').trim().charAt(0).toUpperCase()}
  </span>
);

const iconBtn = 'p-2 rounded-lg text-slate-400 disabled:opacity-50';

export default function TeamList({ members, invites, myPhone, smsOn }) {
  const router = useRouter();
  const [busy, setBusy] = useState(null); // row key being changed
  const [note, setNote] = useState({}); // row key → message

  async function act(key, fn, after = () => router.refresh()) {
    setBusy(key);
    setNote((n) => ({ ...n, [key]: '' }));
    try {
      after(await fn());
    } catch (err) {
      setNote((n) => ({ ...n, [key]: err.message }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white border border-[var(--color-border)] rounded-xl divide-y divide-[var(--color-border)]">
        {members.map((m) => {
          const key = `m${m.person_id}`;
          const me = m.phone === myPhone;
          const owner = m.role === 'owner';
          return (
            <div key={key} className="flex flex-wrap md:flex-nowrap items-center gap-x-3 gap-y-2 px-4 py-3">
              <Avatar label={m.display_name} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-slate-900">
                  <span className="truncate">{m.display_name || m.phone}</span>
                  {me && <span className="shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">You</span>}
                </div>
                <div className="text-xs text-slate-500 tabular truncate">
                  {m.display_name ? `${m.phone} · ` : ''}
                  {owner ? 'Set up this business' : `Joined ${date(m.joined_at)}${m.invited_by_name ? ` · invited by ${m.invited_by_name}` : ''}`}
                </div>
                {note[key] && <div className="mt-1 text-xs text-red-700">{note[key]}</div>}
              </div>

              <div className="flex items-center gap-2 ml-12 md:ml-0">
                {owner ? (
                  <span className="inline-flex items-center h-9 w-[120px] px-3 text-sm text-slate-500">{ROLE_LABELS.owner}</span>
                ) : (
                  <select
                    value={m.role}
                    onChange={(e) => act(key, () => send(`/api/team/members/${m.person_id}`, 'PATCH', { role: e.target.value }))}
                    disabled={busy === key}
                    aria-label="Role"
                    className="h-9 w-[120px] pl-3 pr-8 text-sm border border-slate-300 rounded-lg bg-white outline-none focus:border-slate-500 select-arrow disabled:opacity-50"
                  >
                    {ROLE_OPTIONS.map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                )}
                <div className="w-9 flex justify-end">
                  {!owner && !me && (
                    <button
                      type="button"
                      onClick={() =>
                        confirm(`Remove ${m.display_name || m.phone} from the team? They'll lose access to this business.`) &&
                        act(key, () => send(`/api/team/members/${m.person_id}`, 'DELETE'))
                      }
                      disabled={busy === key}
                      title="Remove from team"
                      aria-label="Remove from team"
                      className={`${iconBtn} hover:text-red-600 hover:bg-red-50`}
                    >
                      <Trash size={16} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {invites.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-slate-900 mb-2">
            Invited <span className="text-slate-400 font-normal">— waiting for them to accept</span>
          </h2>
          <div className="bg-white border border-[var(--color-border)] rounded-xl divide-y divide-[var(--color-border)]">
            {invites.map((i) => {
              const key = `i${i.id}`;
              return (
                <div key={key} className="flex flex-wrap md:flex-nowrap items-center gap-x-3 gap-y-2 px-4 py-3">
                  <Avatar label={null} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-900 tabular truncate">{i.phone}</div>
                    <div className="text-xs text-slate-500 tabular truncate">
                      Invited {date(i.created_at)}
                      {i.invited_by_name ? ` by ${i.invited_by_name}` : ''}
                      {i.sms_sent_at ? ' · texted' : ''}
                    </div>
                    {note[key] && <div className="mt-1 text-xs text-slate-500">{note[key]}</div>}
                  </div>
                  <div className="flex items-center gap-2 ml-12 md:ml-0">
                    <span className="inline-flex items-center h-9 w-[120px] px-3 text-sm text-slate-500">{ROLE_LABELS[i.role]}</span>
                    <div className="w-[76px] flex justify-end">
                      {smsOn && (
                        <button
                          type="button"
                          onClick={() =>
                            act(key, () => send(`/api/team/invites/${i.id}`, 'POST'), (data) =>
                              setNote((n) => ({ ...n, [key]: data.sms?.sent ? 'Text sent.' : `Not sent: ${data.sms?.reason}` }))
                            )
                          }
                          disabled={busy === key}
                          title="Text them again"
                          aria-label="Text them again"
                          className={`${iconBtn} hover:text-slate-900 hover:bg-slate-100`}
                        >
                          <PaperPlaneTilt size={16} />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => confirm(`Cancel the invite to ${i.phone}?`) && act(key, () => send(`/api/team/invites/${i.id}`, 'DELETE'))}
                        disabled={busy === key}
                        title="Cancel invite"
                        aria-label="Cancel invite"
                        className={`${iconBtn} hover:text-red-600 hover:bg-red-50`}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
