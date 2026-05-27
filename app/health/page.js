/**
 * /health — operator-facing dependency health page.
 *
 * Lives OUTSIDE the (app) route group on purpose: the (app)/layout
 * itself does an ERPNext health check, so if ERPNext is down the
 * authenticated shell can't render. /health needs to be reachable
 * exactly when something is down, so it does its own auth + has no
 * dependency on the Shell layout or its ERPNext probe.
 *
 * Each check runs in parallel with its own timeout, so one slow probe
 * never blocks the page. Each returns { ok, ms, note?, error? } and
 * renders into a uniform status row.
 *
 * Coverage:
 *   • Postgres        — direct SELECT 1 (Berpal's own DB)
 *   • ERPNext API     — frappe.handler.ping via the user's API key
 *   • MariaDB         — inferred via a DB-touching ERPNext call
 *   • Twilio          — token-validated account fetch
 *   • OpenAI          — /v1/models list (auth + reachability)
 *
 * Redis (cache + queue) isn't directly reachable from here — those are
 * internal-only Railway services that only Frappe sees. If ERPNext API
 * is green AND a DB-touching call works, Redis is implicitly healthy
 * (Frappe wouldn't serve API calls without it). Surfaced as a note.
 */

import { redirect } from 'next/navigation';
import { getSession } from '../../src/auth/session';
import { query } from '../../src/db';
const erpnext = require('../../src/erpnext');

export const dynamic = 'force-dynamic';
export const metadata = { title: 'System health — Berpal' };

const RAILWAY_URL = 'https://railway.app/dashboard';
const ERPNEXT_DIRECT_URL = 'https://erpnext-docker-production.up.railway.app';

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms);
  });
  try {
    const out = await Promise.race([promise, timeout]);
    clearTimeout(timer);
    return out;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function checkPostgres() {
  const start = Date.now();
  try {
    await withTimeout(query('SELECT 1'), 5000);
    return { ok: true, ms: Date.now() - start };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: err.message };
  }
}

async function checkErpnext(erp) {
  if (!erp) return { ok: false, ms: 0, error: 'ERPNext client not configured for this user.' };
  const start = Date.now();
  try {
    const r = await withTimeout(erp.callMethod('frappe.handler.ping'), 10000);
    const pong = r?.message || r?.data?.message;
    if (pong !== 'pong') {
      return { ok: false, ms: Date.now() - start, error: `unexpected reply: ${JSON.stringify(pong)}` };
    }
    return { ok: true, ms: Date.now() - start };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: err.message };
  }
}

async function checkMariadb(erp) {
  if (!erp) return { ok: false, ms: 0, error: 'no ERPNext client to probe MariaDB through.' };
  const start = Date.now();
  try {
    await withTimeout(
      erp.callMethod('frappe.client.get_count', { doctype: 'Company' }),
      10000
    );
    return { ok: true, ms: Date.now() - start, note: 'verified via ERPNext (DB-touching call).' };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: err.message };
  }
}

async function checkTwilio() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    return { ok: 'skip', note: 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set.' };
  }
  const start = Date.now();
  try {
    const r = await withTimeout(
      fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
        headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` },
        signal: AbortSignal.timeout(5000),
      }),
      6000
    );
    if (!r.ok) return { ok: false, ms: Date.now() - start, error: `HTTP ${r.status}` };
    const data = await r.json();
    return { ok: true, ms: Date.now() - start, note: `account status: ${data.status || 'active'}` };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: err.message };
  }
}

async function checkOpenai() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: 'skip', note: 'OPENAI_API_KEY not set.' };
  const start = Date.now();
  try {
    const r = await withTimeout(
      fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000),
      }),
      6000
    );
    if (!r.ok) return { ok: false, ms: Date.now() - start, error: `HTTP ${r.status}` };
    return { ok: true, ms: Date.now() - start };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: err.message };
  }
}

function StatusPill({ status, ms }) {
  if (status === 'skip') {
    return <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded bg-slate-100 text-slate-500">Skipped</span>;
  }
  if (status === true || status === 'ok') {
    const tone = ms != null && ms > 2000 ? 'amber' : 'emerald';
    return (
      <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded ${
        tone === 'amber' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'
      }`}>
        {tone === 'amber' ? 'Slow' : 'OK'}
      </span>
    );
  }
  return <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded bg-red-100 text-red-700">Down</span>;
}

function Row({ name, doc, result }) {
  const pillStatus = result?.ok === 'skip' ? 'skip' : result?.ok ? 'ok' : 'down';
  return (
    <div className="px-4 py-3 sm:px-5 sm:py-4 flex items-start gap-3 flex-wrap">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-sm font-medium text-slate-900">{name}</h3>
          <StatusPill status={pillStatus} ms={result?.ms} />
          {result?.ms != null && pillStatus !== 'skip' && (
            <span className="text-[11px] text-slate-500 tabular">{result.ms}ms</span>
          )}
        </div>
        {doc && <div className="text-[11px] text-slate-500 mt-0.5">{doc}</div>}
        {result?.note && pillStatus !== 'down' && (
          <div className="text-[11px] text-slate-500 mt-1">{result.note}</div>
        )}
        {result?.error && pillStatus === 'down' && (
          <div className="text-[11px] text-red-700 mt-1 font-mono break-all leading-snug">{result.error}</div>
        )}
      </div>
    </div>
  );
}

export default async function HealthPage({ searchParams }) {
  // Own auth check — we're outside (app)/layout intentionally so this
  // page stays reachable when ERPNext is down.
  const sess = await getSession();
  if (!sess.user_id) redirect('/login?return_to=/health');

  // Load the user's ERPNext credentials (PG only — no upstream call).
  // If the user has no ERPNext binding (half-broken onboarding), erp
  // stays null and the ERPNext + MariaDB checks render as Down with a
  // clear "not configured" note.
  let erp = null;
  let userRow = null;
  try {
    const r = await query(
      `SELECT id, phone, display_name, default_currency, reporting_currency,
              erpnext_company, erpnext_api_key, erpnext_api_secret
         FROM users WHERE id = $1`,
      [sess.user_id]
    );
    userRow = r.rows[0];
    if (userRow?.erpnext_api_key && userRow?.erpnext_api_secret && userRow?.erpnext_company) {
      erp = erpnext.forUser(userRow);
    }
  } catch (err) {
    // PG itself is down — checkPostgres below will reflect that. Keep going.
    console.warn('[health] loading user row failed:', err.message);
  }

  // Run all checks in parallel. Each has its own timeout — no single
  // slow probe can hold the page up past ~10s.
  const [pg, erpHealth, mariadb, twilio, openai] = await Promise.all([
    checkPostgres(),
    checkErpnext(erp),
    checkMariadb(erp),
    checkTwilio(),
    checkOpenai(),
  ]);

  const anyDown = [pg, erpHealth, mariadb, twilio, openai].some((r) => r?.ok === false);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">System health</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Dependency checks for the Berpal stack. {userRow?.erpnext_company && `Tenant: ${userRow.erpnext_company}`}
            </p>
          </div>
          <form>
            <button
              type="submit"
              className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 bg-white rounded-md hover:bg-slate-50"
            >
              Refresh
            </button>
          </form>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-4">
        {anyDown && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-900">
            One or more dependencies are down. If it's ERPNext or MariaDB, the most reliable fix is the
            <strong> restart-erpnext.bat </strong>script in the project root, which redeploys MariaDB first
            (waiting 90s for InnoDB recovery), then Redis, then ERPNext.
          </div>
        )}

        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 sm:px-5 py-3 bg-slate-50 border-b border-slate-200">
            <h2 className="text-xs uppercase tracking-wider font-medium text-slate-500">Your tenant</h2>
          </div>
          <div className="divide-y divide-slate-100">
            <Row
              name="Postgres (Berpal app DB)"
              doc="SELECT 1 — round-trip check."
              result={pg}
            />
            <Row
              name="ERPNext API"
              doc="frappe.handler.ping — round-trips via your bot user's API key."
              result={erpHealth}
            />
            <Row
              name="MariaDB (Frappe DB)"
              doc="Inferred — DB-touching ERPNext call (frappe.client.get_count Company)."
              result={mariadb}
            />
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 sm:px-5 py-3 bg-slate-50 border-b border-slate-200">
            <h2 className="text-xs uppercase tracking-wider font-medium text-slate-500">Infrastructure (shared)</h2>
          </div>
          <div className="divide-y divide-slate-100">
            <Row
              name="Twilio"
              doc="Account fetch — confirms credentials + WhatsApp API reachability."
              result={twilio}
            />
            <Row
              name="OpenAI"
              doc="GET /v1/models — confirms API key + reachability."
              result={openai}
            />
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 text-sm space-y-2">
          <h2 className="text-xs uppercase tracking-wider font-medium text-slate-500 mb-1">Quick actions</h2>
          <ul className="text-sm text-slate-700 space-y-1.5">
            <li>
              Railway dashboard: <a href={RAILWAY_URL} target="_blank" rel="noreferrer" className="text-[var(--color-brand-accent)] hover:underline">{RAILWAY_URL}</a>
            </li>
            <li>
              ERPNext direct URL: <a href={ERPNEXT_DIRECT_URL} target="_blank" rel="noreferrer" className="text-[var(--color-brand-accent)] hover:underline">{ERPNEXT_DIRECT_URL}</a>
            </li>
            <li>
              Restart the ERPNext stack: double-click <span className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">restart-erpnext.bat</span> at the project root
              (MariaDB → wait 90s → Redis → ERPNext).
            </li>
          </ul>
        </section>

        <section className="text-[11px] text-slate-500 px-1 leading-relaxed">
          Redis (cache + queue) services aren't directly probed from here — they're internal-only on Railway.
          When ERPNext API + MariaDB are both ✅, Redis is implicitly healthy (Frappe wouldn't answer API
          calls without it). If ERPNext shows ✅ but MariaDB ❌, MariaDB is the suspect; the reverse points at
          ERPNext itself.
        </section>
      </main>
    </div>
  );
}
