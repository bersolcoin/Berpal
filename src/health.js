/**
 * GET /health — liveness + dependency checks for load balancers, Docker HEALTHCHECK and uptime
 * monitors.
 *
 *   status  ok        every check passed
 *           degraded  db fine, ERPNext or Twilio failing (messages may fail; still serve 200 so
 *                     the platform doesn't restart a healthy process over someone else's outage)
 *           fail      db failing → 503
 *
 * `?deep=0` skips the external calls (ERPNext, Twilio) and reports them `{ ok: true, skipped: true }`; use it for
 * frequent platform probes. Default is deep. The endpoint is public, so deep results are cached
 * for DEEP_CACHE_MS (concurrent callers share one in-flight check): however often /health is hit,
 * it costs at most one Twilio API request and one ERPNext ping per window.
 * Responses never include credentials, hostnames or upstream bodies: only ok/latency, and for
 * ERPNext a fixed-vocabulary detail ("HTTP 502", "timeout", "unreachable"). Raw error text goes
 * to the log only.
 */
const { version } = require('../package.json');

const TIMEOUT_MS = 3000;
const DEEP_CACHE_MS = 30000;

/** Runs `fn` with a timeout; resolves { ok, ms, error? }. `error` is for logs, never the wire. */
async function timed(fn, now, timeoutMs) {
  const start = now();
  let timer;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { ok: true, ms: now() - start };
  } catch (err) {
    return { ok: false, ms: now() - start, error: err };
  } finally {
    clearTimeout(timer);
  }
}

class HttpStatusError extends Error {}
class TimeoutError extends Error {}

/**
 * fetch that throws on a non-2xx status. The request is aborted at timeoutMs (the race in
 * timed() only stops waiting; the AbortController is what closes the socket), and the response
 * body is discarded so the connection goes back to the pool instead of waiting for GC.
 */
async function fetchOk(fetchImpl, url, init, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new TimeoutError(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ac.signal });
    try { await res.body?.cancel(); } catch { /* already consumed or not a stream */ }
    if (!res.ok) throw new HttpStatusError(`HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Safe-for-the-wire summary of a failed check: never the raw message (can carry URLs/hosts). */
function publicDetail(err) {
  if (err instanceof HttpStatusError) return err.message;
  if (err instanceof TimeoutError || /timeout/i.test(String(err && err.message))) return 'timeout';
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  return 'unreachable';
}

/** Raw error text for the log, capped. */
function logDetail(err) {
  return String((err && err.message) || err).slice(0, 200);
}

/**
 * Express handler. Everything is injectable for tests:
 *   db         { query(sql) } — src/db.js
 *   fetchImpl  fetch
 *   scheduler  { running() } — whether this instance ticks the job scheduler
 *   now        ms clock
 *   env        for ERPNEXT_URL / TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN
 */
function createHealthHandler({
  db = require('./db'),
  fetchImpl = (...args) => fetch(...args),
  scheduler = { running: () => false },
  now = () => Date.now(),
  env = process.env,
  timeoutMs = TIMEOUT_MS,
  deepCacheMs = DEEP_CACHE_MS,
} = {}) {
  const startedAt = now();

  async function checkErpnext() {
    const base = String(env.ERPNEXT_URL || '').replace(/\/+$/, '');
    if (!base) return { ok: false, ms: 0, detail: 'ERPNEXT_URL not set' };
    const r = await timed(() => fetchOk(fetchImpl, `${base}/api/method/ping`, {}, timeoutMs), now, timeoutMs);
    if (r.ok) return r;
    console.warn(`[health] erpnext check failed: ${logDetail(r.error)}`);
    return { ok: false, ms: r.ms, detail: publicDetail(r.error) };
  }

  async function checkTwilio() {
    const sid = env.TWILIO_ACCOUNT_SID;
    const token = env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) return { ok: false, ms: 0 };
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`;
    const r = await timed(() => fetchOk(fetchImpl, url, { headers: { Authorization: `Basic ${auth}` } }, timeoutMs), now, timeoutMs);
    if (r.ok) return r;
    // Twilio detail stays in the log only.
    console.warn(`[health] twilio check failed: ${logDetail(r.error)}`);
    return { ok: false, ms: r.ms };
  }

  // { at, promise } of the last deep run; reused while fresh, shared while in flight.
  let deepRun = null;
  function externalChecks() {
    const t = now();
    if (deepRun && t - deepRun.at < deepCacheMs) return deepRun.promise;
    const promise = Promise.all([checkErpnext(), checkTwilio()]);
    deepRun = { at: t, promise };
    return promise;
  }

  return async (req, res) => {
    const deep = String((req.query && req.query.deep) ?? '1') !== '0';
    const skipped = { ok: true, ms: 0, skipped: true };

    const [dbCheck, [erpnext, twilio]] = await Promise.all([
      timed(() => db.query('SELECT 1'), now, timeoutMs),
      deep ? externalChecks() : [skipped, skipped],
    ]);
    // db error text can name hosts/users: log only.
    if (!dbCheck.ok) console.error(`[health] db check failed: ${logDetail(dbCheck.error)}`);

    const status = !dbCheck.ok ? 'fail' : (erpnext.ok && twilio.ok ? 'ok' : 'degraded');

    res.status(status === 'fail' ? 503 : 200).json({
      status,
      uptime_s: Math.round((now() - startedAt) / 1000),
      version,
      checks: {
        db: { ok: dbCheck.ok, ms: dbCheck.ms },
        erpnext,
        twilio,
        scheduler: { running: Boolean(scheduler.running()) },
      },
    });
  };
}

module.exports = { createHealthHandler, publicDetail };
