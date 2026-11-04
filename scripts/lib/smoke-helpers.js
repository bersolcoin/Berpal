/**
 * Pure helpers for scripts/smoke-erpnext.js: argument parsing, expectation comparison, ERPNext
 * error messages, cleanup ordering and report shaping. No network, no database — unit-tested in
 * test/smoke-helpers.test.js.
 */

const PREFIX = 'SMOKE-';
const TOLERANCE = 0.005;

const USAGE = `Usage: node scripts/smoke-erpnext.js [options]      (npm run smoke:erpnext -- [options])

Exercises the bot's ERPNext write/read paths against a REAL ERPNext Company and checks every
posted document and its GL Entries. Postgres is not needed (pg-mem in-process).

Modes (default: full = preflight + flows):
  --preflight          only check the Company setup (read-only apart from a temp File upload)
  --cleanup            after the flows, cancel + delete everything the run created (no prompt)
  --cleanup-only       cancel + delete what an earlier run recorded in its --report file
  --keep               never offer cleanup at the end

Options:
  --company "Name"     ERPNext Company (default: ERPNEXT_COMPANY_DEFAULT)
  --fix                preflight: create what the bot would create itself anyway (tax / per-currency
                       party accounts, generic items, Products item group, a Stores warehouse,
                       Duties and Taxes group). Never touches Company defaults or settings.
  --allow-live         run flows / --fix even when the Company has GL Entries the smoke test
                       did not create
  --report <path>      JSON report path (default ./smoke-report.json)
  -h, --help           this text

Env (.env): ERPNEXT_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET, ERPNEXT_COMPANY_DEFAULT,
            ERPNEXT_INVOICE_PRINT_FORMAT (optional)
Exit code: 0 all good, 1 a check/step failed, 2 refused (safety guard / bad arguments).
`;

/** argv (without node + script) → options. Unknown flags land in `errors`. */
function parseArgs(argv) {
  const opts = {
    mode: 'full', fix: false, allowLive: false, cleanup: false, keep: false,
    company: null, report: './smoke-report.json', help: false, errors: [],
  };
  const takeValue = (i, flag) => {
    const v = argv[i + 1];
    if (v == null || v.startsWith('--')) {
      opts.errors.push(`${flag} needs a value`);
      return null;
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    switch (flag) {
      case '-h':
      case '--help': opts.help = true; break;
      case '--preflight': opts.mode = 'preflight'; break;
      case '--cleanup-only': opts.mode = 'cleanup'; break;
      case '--cleanup': opts.cleanup = true; break;
      case '--keep': opts.keep = true; break;
      case '--fix': opts.fix = true; break;
      case '--allow-live': opts.allowLive = true; break;
      case '--company':
      case '--report': {
        const v = inline != null ? inline : takeValue(i, flag);
        if (inline == null && v != null) i++;
        if (v != null) opts[flag.slice(2)] = v;
        break;
      }
      default: opts.errors.push(`unknown argument ${a}`);
    }
  }
  if (opts.cleanup && opts.keep) opts.errors.push('--cleanup and --keep contradict each other');
  if (opts.mode === 'preflight' && opts.cleanup) opts.errors.push('--cleanup needs the flows; use --cleanup-only to remove an earlier run');
  return opts;
}

function round2(n) {
  return Math.round(Number((Number(n) * 100).toFixed(8))) / 100;
}

/**
 * Deep equality with a numeric tolerance (default half a satang). Numbers and numeric strings
 * compare as numbers; objects compare key by key (a missing key on either side counts as 0 only
 * when the other side is a number within tolerance of 0).
 */
function sameValue(expected, actual, tol = TOLERANCE) {
  const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : null);
  if (num(expected) != null && num(actual) != null && typeof expected === 'number') {
    return Math.abs(num(expected) - num(actual)) <= tol;
  }
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    if (Array.isArray(expected) !== Array.isArray(actual)) return false;
    if (Array.isArray(expected)) {
      return expected.length === actual.length && expected.every((v, i) => sameValue(v, actual[i], tol));
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const k of keys) {
      const e = expected[k];
      const a = actual[k];
      if (e === undefined && typeof a === 'number' && Math.abs(a) <= tol) continue;
      if (a === undefined && typeof e === 'number' && Math.abs(e) <= tol) continue;
      if (!sameValue(e, a, tol)) return false;
    }
    return true;
  }
  return expected === actual;
}

/** One assertion result. `soft` checks print ⚠ and never fail the run. */
function check(label, expected, actual, { tol = TOLERANCE, soft = false } = {}) {
  return { label, ok: sameValue(expected, actual, tol), expected, actual, ...(soft ? { soft: true } : {}) };
}

/** A predicate check (e.g. "≥ 850", "starts with %PDF-"): expected is the description. */
function checkThat(label, ok, expectedText, actual, { soft = false } = {}) {
  return { label, ok: !!ok, expected: expectedText, actual, ...(soft ? { soft: true } : {}) };
}

/** GL Entry rows → { account: Dr − Cr } in company currency, zero nets dropped. */
function glNet(entries) {
  const out = {};
  for (const g of entries || []) {
    out[g.account] = round2((out[g.account] || 0) + (Number(g.debit) || 0) - (Number(g.credit) || 0));
  }
  for (const k of Object.keys(out)) if (Math.abs(out[k]) <= TOLERANCE) delete out[k];
  return out;
}

/**
 * Expected GL nets vs actual: every expected account must match and no other account may carry
 * a balance (a Round Off or stray FX line is exactly what the run is looking for).
 */
function compareGl(expected, actual, tol = TOLERANCE) {
  const diffs = [];
  for (const [acc, exp] of Object.entries(expected)) {
    const act = actual[acc] || 0;
    if (Math.abs(act - exp) > tol) diffs.push({ account: acc, expected: exp, actual: act });
  }
  for (const [acc, act] of Object.entries(actual)) {
    if (!(acc in expected) && Math.abs(act) > tol) diffs.push({ account: acc, expected: 0, actual: act });
  }
  return { ok: diffs.length === 0, diffs };
}

function checkGl(label, expected, actual, opts = {}) {
  const r = compareGl(expected, actual, opts.tol);
  return { label, ok: r.ok, expected, actual, ...(r.ok ? {} : { diffs: r.diffs }), ...(opts.soft ? { soft: true } : {}) };
}

function stripHtml(s) {
  return String(s).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The human-readable server message behind an ERPNext error. Frappe puts it in
 * `_server_messages` (a JSON string of JSON strings, each { message }), `exception`
 * ("frappe.exceptions.ValidationError: …"), `exc_type` or `message`. Falls back to err.message.
 */
function serverMessage(err) {
  if (!err) return '';
  const res = err.response;
  const parts = [];
  if (res && typeof res === 'object') {
    if (res._server_messages) {
      try {
        for (const m of JSON.parse(res._server_messages)) {
          let msg = m;
          try {
            const o = JSON.parse(m);
            msg = o.message || m;
          } catch { /* plain string */ }
          parts.push(stripHtml(msg));
        }
      } catch {
        parts.push(stripHtml(res._server_messages));
      }
    }
    if (res.exception) parts.push(stripHtml(res.exception));
    else if (res.exc_type) parts.push(String(res.exc_type));
    if (!parts.length && typeof res.message === 'string') parts.push(stripHtml(res.message));
    if (!parts.length && res.raw) parts.push(stripHtml(res.raw).slice(0, 300));
  }
  const unique = [...new Set(parts.filter(Boolean))];
  if (!unique.length) return err.message || String(err);
  return `${err.status ? `HTTP ${err.status}: ` : ''}${unique.join(' | ')}`;
}

/** Short printable form of a value for one-line results. */
function show(v) {
  if (v === undefined) return 'undefined';
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  return s && s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

function formatCheck(c) {
  const mark = c.ok ? '✔' : c.soft ? '⚠' : '✖';
  if (c.ok) return `  ${mark} ${c.label}`;
  let line = `  ${mark} ${c.label} — expected ${show(c.expected)}, actual ${show(c.actual)}`;
  if (c.diffs) line += `\n      differs: ${c.diffs.map((d) => `${d.account} exp ${d.expected} got ${d.actual}`).join('; ')}`;
  return line;
}

function formatPreflight(p) {
  const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  let line = `  ${pad(p.status, 5)} ${pad(p.label, 44)} ${p.detail || ''}`.trimEnd();
  if (p.status !== 'PASS' && p.hint) line += `\n        → ${p.hint}`;
  return line;
}

/** System Settings.rounding_method → preflight status. Pre-v15 sites have no field: legacy only. */
function roundingStatus(value) {
  if (value == null || value === '') return { status: 'PASS', detail: '(no rounding_method field: legacy rounding)' };
  if (/legacy/i.test(value)) return { status: 'PASS', detail: value };
  return {
    status: 'WARN',
    detail: value,
    hint: 'System Settings → Rounding Method: "Banker\'s Rounding (legacy)" is what the bot reproduces; others can differ by a satang',
  };
}

/**
 * Safety guard. total = GL Entries in the Company; smoke = how many of those belong to vouchers
 * that touch a SMOKE- account or party (an earlier smoke run).
 */
function liveGuardDecision({ total, smoke = 0, allowLive = false }) {
  const foreign = Math.max(0, (Number(total) || 0) - (Number(smoke) || 0));
  if (foreign === 0) {
    return { ok: true, foreign, message: total ? `${total} GL Entries, all from earlier smoke runs` : 'no GL Entries (fresh Company)' };
  }
  if (allowLive) return { ok: true, foreign, message: `${foreign} GL Entries not created by the smoke test — continuing because of --allow-live` };
  return {
    ok: false,
    foreign,
    message: `${foreign} GL Entries not created by the smoke test: this looks like a live Company. Use a dedicated test Company, or pass --allow-live.`,
  };
}

// Cancel / delete order: payments before what they settle, invoices before the JEs and masters
// they reference, stock documents before their Items, Files whenever, masters last.
const CLEANUP_RANK = {
  'Payment Entry': 0,
  'Sales Invoice': 1,
  'Purchase Invoice': 1,
  'Journal Entry': 2,
  File: 3,
  Item: 4,
  Customer: 5,
  Supplier: 5,
  Account: 6,
};
const SUBMITTABLE = new Set(['Payment Entry', 'Sales Invoice', 'Purchase Invoice', 'Journal Entry']);

/** created [{ doctype, name, seq }] → cleanup order (by rank, then newest first). Dedupes. */
function cleanupOrder(created) {
  const seen = new Set();
  const list = [];
  (created || []).forEach((c, i) => {
    const key = `${c.doctype}|${c.name}`;
    if (!c.name || seen.has(key)) return;
    seen.add(key);
    list.push({ ...c, seq: c.seq != null ? c.seq : i });
  });
  const rank = (d) => (d in CLEANUP_RANK ? CLEANUP_RANK[d] : 7);
  return list.sort((a, b) => rank(a.doctype) - rank(b.doctype) || b.seq - a.seq);
}

function isSubmittable(doctype) {
  return SUBMITTABLE.has(doctype);
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Counts for the summary block and the exit code. */
function summarize({ preflight = [], steps = [], cleanup = null }) {
  const pf = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const p of preflight) pf[p.status] = (pf[p.status] || 0) + 1;
  const checks = { passed: 0, failed: 0, soft_failed: 0 };
  const st = { ok: 0, failed: 0, skipped: 0 };
  for (const s of steps) {
    for (const c of s.checks || []) {
      if (c.ok) checks.passed++;
      else if (c.soft) checks.soft_failed++;
      else checks.failed++;
    }
    if (s.skipped) st.skipped++;
    else if (s.ok) st.ok++;
    else st.failed++;
  }
  const failed = pf.FAIL > 0 || st.failed > 0 || checks.failed > 0;
  return {
    preflight: { pass: pf.PASS, warn: pf.WARN, fail: pf.FAIL },
    steps: st,
    checks,
    cleanup: cleanup ? { removed: cleanup.removed.length, failed: cleanup.failed.length } : null,
    failed,
  };
}

/** The JSON report. Never contains credentials. */
function buildReport({ startedAt, finishedAt, mode, options, target, preflight, steps, queries, created, cleanup, guard }) {
  return {
    tool: 'smoke-erpnext',
    started_at: startedAt,
    finished_at: finishedAt,
    mode,
    options: {
      fix: !!options.fix, allow_live: !!options.allowLive, cleanup: !!options.cleanup, keep: !!options.keep,
    },
    target: target || null,
    guard: guard || null,
    preflight: preflight || [],
    steps: (steps || []).map((s) => ({
      id: s.id,
      label: s.label,
      ok: !!s.ok,
      ...(s.skipped ? { skipped: s.skipped } : {}),
      ...(s.docs && Object.keys(s.docs).length ? { docs: s.docs } : {}),
      checks: s.checks || [],
      ...(s.error ? { error: s.error } : {}),
    })),
    queries: queries || {},
    created: created || [],
    cleanup: cleanup || null,
    summary: summarize({ preflight, steps, cleanup }),
  };
}

module.exports = {
  PREFIX, USAGE, parseArgs, round2, sameValue, check, checkThat, glNet, compareGl, checkGl,
  serverMessage, formatCheck, formatPreflight, roundingStatus, liveGuardDecision, cleanupOrder,
  isSubmittable, addDays, summarize, buildReport, show,
};
