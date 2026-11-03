/**
 * Per-user daily job scheduler.
 *
 * Every src/jobs/*.job.js exports { name, defaultTime: 'HH:MM', async run(user, deps) } and
 * optionally window (minutes, or 'H:MM'; default 120), timeoutMs (default 60s) and
 * enabled(user) → bool.
 * Each tick (default 60s) walks the active users; a job is due for a user while their LOCAL
 * clock is inside [time, time + window) (time = job_prefs override, else defaultTime).
 *
 * Exactly-once per user/job/day:
 *  - the job_runs row is claimed (INSERT … ON CONFLICT DO NOTHING) BEFORE the job runs; the
 *    unique index on (user_id, job, run_date) is the cross-instance lock;
 *  - a run is also refused if the same job ran for the user in the last 20h, or for a later
 *    run_date — so a timezone change can't produce a second send for the "new" local day.
 *
 * Nothing is ever caught up: outside the window (server down at 08:00, deploy at 22:00) the
 * day is simply skipped — nobody wants "good morning" at night, and reminders must never
 * message customers at night.
 */
const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const erpnext = require('../erpnext');
const { ts } = require('../erp-sync/common');
const { normalizeTime, localClock, parseJobPrefs, addDays, toMinutes, windowMinutes } = require('./index');

const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_WINDOW_MIN = 120;
const MIN_GAP_MS = 20 * 3600 * 1000;
const JOB_TIMEOUT_MS = 60 * 1000;
const ABANDON_AFTER_MS = 30 * 60 * 1000;
// How far back the per-tick read of previous runs looks. Any run that could block today's
// (≤ 20h ago, or a run_date ahead of the user's local date) started well inside this.
const LOOKBACK_MS = 3 * 86400 * 1000;

/** Load and validate every *.job.js in `dir`. Malformed files are logged and skipped. */
function loadJobs(dir = __dirname) {
  const jobs = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.job.js')).sort()) {
    let job;
    try {
      job = require(path.join(dir, f));
    } catch (err) {
      console.error(`• [jobs] [${ts()}] ${f} failed to load: ${err.message}`);
      continue;
    }
    if (!job || !job.name || typeof job.run !== 'function' || !normalizeTime(job.defaultTime)) {
      console.error(`• [jobs] [${ts()}] ${f} skipped: needs { name, defaultTime: 'HH:MM', run(user, deps) }`);
      continue;
    }
    if (jobs.some((j) => j.name === job.name)) {
      console.error(`• [jobs] [${ts()}] ${f} skipped: duplicate job name '${job.name}'`);
      continue;
    }
    if (job.window != null && !windowMinutes(job.window)) {
      console.error(`• [jobs] [${ts()}] ${f}: bad window ${JSON.stringify(job.window)}, using ${DEFAULT_WINDOW_MIN} min`);
    }
    jobs.push(job);
  }
  return jobs;
}

// Loaded on first use, not at require time, so requiring the scheduler stays side-effect free.
let _jobs = null;
function getJobs() {
  if (!_jobs) _jobs = loadJobs();
  return _jobs;
}

function defaultTwilio() {
  return require('../twilio-client');
}

/**
 * The user's time / window / on-off for one job. job_prefs wins over the job's defaults; a
 * job's own enabled(user) (e.g. users.digest_enabled) is checked here so a disabled job never
 * claims the day — switching it on later the same day still runs.
 */
function jobSetting(user, job) {
  const pref = parseJobPrefs(user.job_prefs)[job.name] || {};
  let enabled = pref.enabled !== false;
  if (enabled && typeof job.enabled === 'function') enabled = !!job.enabled(user);
  return {
    time: normalizeTime(pref.time) || normalizeTime(job.defaultTime),
    window: windowMinutes(job.window) || DEFAULT_WINDOW_MIN,
    enabled,
  };
}

/**
 * The local date this run belongs to, or null when the clock is outside [time, time + window).
 * A window that crosses midnight (23:30 + 120) belongs to the day the time fell on.
 */
function dueRunDate(clock, { time, window }) {
  const nowMin = toMinutes(clock.time);
  const atMin = toMinutes(time);
  const since = (nowMin - atMin + 1440) % 1440;
  if (since >= window) return null;
  return nowMin >= atMin ? clock.date : addDays(clock.date, -1);
}

/**
 * Claim (user, job, date). Returns the new row id, or null if the row already exists.
 * No conflict target on purpose: with one, pg-mem hands back the EXISTING row from
 * DO NOTHING … RETURNING (a fake win); without one both Postgres and pg-mem return [].
 */
async function claimRun(userId, jobName, runDate, startedAt) {
  const r = await query(
    `INSERT INTO job_runs (user_id, job, run_date, started_at, status)
     VALUES ($1, $2, $3, $4, 'running')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [userId, jobName, runDate, startedAt]
  );
  return r.rows[0] ? r.rows[0].id : null;
}

async function finishRun(id, { status, error = null, result = null, messageSid = null }) {
  await query(
    `UPDATE job_runs SET status = $2, error = $3, result = $4, message_sid = $5, finished_at = $6 WHERE id = $1`,
    [id, status, error ? String(error).slice(0, 1000) : null, result, messageSid, new Date().toISOString()]
  );
}

/** Latest run per (user, job) in the lookback, keyed 'user_id:job'. One query per tick. */
async function recentRuns(at) {
  const r = await query(
    `SELECT user_id, job, MAX(run_date) AS last_date, MAX(started_at) AS last_started
     FROM job_runs WHERE started_at >= $1
     GROUP BY user_id, job`,
    [new Date(at.getTime() - LOOKBACK_MS).toISOString()]
  );
  return new Map(r.rows.map((x) => [`${x.user_id}:${x.job}`, x]));
}

/** Map what job.run returned onto the job_runs row. */
function outcome(res) {
  if (res && res.skipped === true) {
    return { status: 'skipped', error: typeof res.note === 'string' ? res.note : null };
  }
  const summary = res && typeof res === 'object' ? res : {};
  // Jobs report failures as a list (`failed` or `failures`) or just a count (`failed: 2`).
  const list = Array.isArray(summary.failed) ? summary.failed : Array.isArray(summary.failures) ? summary.failures : null;
  const failedCount = list ? list.length : Number(summary.failed) || 0;
  // Every attempted send failed → the run failed, even though run() didn't throw.
  const allFailed = failedCount > 0 && !Number(summary.sent);
  const detail = list ? `: ${list.map((f) => (f && (f.error || f.ref)) || String(f)).join('; ')}` : '';
  return {
    status: allFailed ? 'failed' : 'ok',
    error: allFailed ? `${failedCount} failed${detail}` : null,
    result: JSON.stringify(summary).slice(0, 4000),
    messageSid: typeof summary.message_sid === 'string' ? summary.message_sid : null,
  };
}

const TIMED_OUT = Symbol('timeout');
const _overrun = new Set(); // user ids with a job still running past its timeout
const _late = new Set(); // promises of overrun jobs, so stop() can wait for them

/**
 * Run a job with an AbortSignal that fires at `timeoutMs`. On timeout the row is marked
 * failed:'timeout' and TIMED_OUT is returned at once; the job isn't killed (JS can't), so when
 * it eventually settles its REAL outcome (status, result, message_sid) overwrites the row —
 * a message it did send is still on record for the status callback.
 */
async function runWithTimeout(job, user, deps, runId, timeoutMs) {
  const ac = new AbortController();
  const run = Promise.resolve().then(() => job.run(user, { ...deps, signal: ac.signal }));
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  const first = await Promise.race([run.then((v) => ({ v }), (e) => ({ e })), timedOut]);
  clearTimeout(timer);
  if (first !== TIMED_OUT) {
    if (first.e) throw first.e;
    return first.v;
  }

  ac.abort(new Error('timeout'));
  await finishRun(runId, { status: 'failed', error: 'timeout' });
  _overrun.add(user.id);
  const late = run
    .then(
      (res) => {
        const o = outcome(res);
        return finishRun(runId, { ...o, error: o.error || `finished after ${timeoutMs}ms timeout` });
      },
      (err) => finishRun(runId, { status: 'failed', error: `timeout; then ${err.message}` })
    )
    .catch((e) => console.error(`• [jobs] [${ts()}] could not record late result for run ${runId}: ${e.message}`))
    .finally(() => {
      _overrun.delete(user.id);
      _late.delete(late);
    });
  _late.add(late);
  return TIMED_OUT;
}

/**
 * One scheduler pass. `now` is a Date or a clock function — it's re-read per user/job so a
 * slow tick doesn't judge late users by a stale time. Tests inject `jobs`, `twilio`,
 * `erpFor`, `jobTimeoutMs` (default for jobs without their own timeoutMs) and `isStopping`.
 * Returns what was attempted: [{ user_id, job, run_date, status, error? }].
 */
async function runDue({
  now = () => new Date(), jobs = getJobs(), twilio = null, erpFor = erpnext.forUser, jobTimeoutMs = JOB_TIMEOUT_MS,
  isStopping = () => false,
} = {}) {
  if (!jobs.length) return [];
  const clockNow = typeof now === 'function' ? now : () => now;
  const users = await query(
    `SELECT * FROM users
     WHERE subscription_status = 'active'
       AND erpnext_company IS NOT NULL AND erpnext_api_key IS NOT NULL AND erpnext_api_secret IS NOT NULL
     ORDER BY id`
  );
  const previous = await recentRuns(clockNow());

  const results = [];
  // Users run one after another: a burst of parallel digests would hammer the shared ERPNext.
  for (const user of users.rows) {
    // Shutdown requested: finish the user in hand, start no new sends.
    if (isStopping()) break;
    // A job that overran its timeout for this user is still running: don't pile another on.
    if (_overrun.has(user.id)) continue;
    let erp = null;
    for (const job of jobs) {
      if (_overrun.has(user.id)) break;
      let runId = null;
      let out = null;
      try {
        const at = clockNow();
        const clock = localClock(at, user.timezone);
        const setting = jobSetting(user, job);
        if (!setting.enabled) continue;
        const runDate = dueRunDate(clock, setting);
        if (!runDate) continue;
        const prev = previous.get(`${user.id}:${job.name}`);
        if (prev && (prev.last_date >= runDate || prev.last_started > new Date(at.getTime() - MIN_GAP_MS).toISOString())) {
          continue;
        }

        runId = await claimRun(user.id, job.name, runDate, at.toISOString());
        if (!runId) continue; // claimed by another instance / overlapping tick

        out = { user_id: user.id, job: job.name, run_date: runDate };
        // Built lazily so a user with nothing due costs no ERPNext client.
        if (!erp) erp = erpFor(user);
        // clock.date is the REAL local date (use it for "today"); run_date is the day the run
        // belongs to — the previous date when a window crosses midnight.
        const deps = { erp, twilio: twilio || defaultTwilio(), now: at, clock: { ...clock, run_date: runDate } };
        const res = await runWithTimeout(job, user, deps, runId, Number(job.timeoutMs) > 0 ? Number(job.timeoutMs) : jobTimeoutMs);
        if (res === TIMED_OUT) {
          out.status = 'failed';
          out.error = 'timeout';
          console.error(`• [jobs] [${ts()}] ${job.name} user=${user.id} ${runDate} timed out; will record its result if it finishes`);
        } else {
          const o = outcome(res);
          out.status = o.status;
          if (o.error && o.status === 'failed') out.error = o.error;
          await finishRun(runId, o);
          console.log(`• [jobs] [${ts()}] ${job.name} user=${user.id} ${runDate} ${clock.time} ${clock.timezone} → ${o.status}`);
        }
      } catch (err) {
        // Claim/record errors and job failures alike: log, record if we hold a row, move on.
        console.error(`• [jobs] [${ts()}] ${job.name} user=${user.id} failed: ${err.message}`);
        if (runId) {
          out.status = 'failed';
          out.error = err.message;
          await finishRun(runId, { status: 'failed', error: err.message }).catch((e) => {
            console.error(`• [jobs] [${ts()}] could not record failure for run ${runId}: ${e.message}`);
          });
        }
      }
      if (out) results.push(out);
    }
  }
  return results;
}

/** Runs left 'running' by a crash/kill: mark failed so they're visible (never re-run). */
async function reapAbandoned(at = new Date()) {
  const r = await query(
    `UPDATE job_runs SET status = 'failed', error = 'abandoned', finished_at = $2
     WHERE status = 'running' AND started_at < $1`,
    [new Date(at.getTime() - ABANDON_AFTER_MS).toISOString(), at.toISOString()]
  );
  if (r.rowCount) console.log(`• [jobs] [${ts()}] marked ${r.rowCount} abandoned run(s) failed`);
  return r.rowCount;
}

// ── delivery status (POST /twilio/status) ───────────────────────────

const _hasColumn = new Set();
async function hasColumn(table, column) {
  const key = `${table}.${column}`;
  if (_hasColumn.has(key)) return true;
  const r = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  // Only positives are cached: another lane's migration may add the column later.
  if (r.rows.length) _hasColumn.add(key);
  return r.rows.length > 0;
}

/**
 * Twilio delivery callback. failed/undelivered → the job run (and the outreach_log row, if
 * that table tracks message_sid) is marked failed with the error code; other statuses are logged.
 */
async function recordDeliveryStatus({ sid, status, errorCode = null }) {
  const counts = { job_runs: 0, outreach_log: 0 };
  if (!sid || !status) return counts;
  console.log(`• [jobs] [${ts()}] twilio status sid=${sid} status=${status}${errorCode ? ` error=${errorCode}` : ''}`);
  if (!['failed', 'undelivered'].includes(status)) return counts;
  const error = `twilio ${status}${errorCode ? ` ${errorCode}` : ''}`;
  const r = await query(`UPDATE job_runs SET status = 'failed', error = $2 WHERE message_sid = $1`, [sid, error]);
  counts.job_runs = r.rowCount;
  if (await hasColumn('outreach_log', 'message_sid')) {
    const o = await query(`UPDATE outreach_log SET status = 'failed', error = $2 WHERE message_sid = $1`, [sid, error]);
    counts.outreach_log = o.rowCount;
  }
  return counts;
}

/**
 * Express handler for POST /twilio/status. Validates X-Twilio-Signature against
 * PUBLIC_BASE_URL + '/twilio/status'. There is no bypass switch: tests inject `validate`.
 */
function twilioStatusHandler({
  authToken = process.env.TWILIO_AUTH_TOKEN,
  publicBaseUrl = process.env.PUBLIC_BASE_URL,
  validate = (...args) => require('twilio').validateRequest(...args),
} = {}) {
  return async (req, res) => {
    const params = req.body || {};
    const url = `${String(publicBaseUrl || '').replace(/\/$/, '')}/twilio/status`;
    const signature = (req.headers && req.headers['x-twilio-signature']) || '';
    if (!authToken || !publicBaseUrl || !validate(authToken, signature, url, params)) {
      console.error(`• [jobs] [${ts()}] /twilio/status rejected: bad signature or PUBLIC_BASE_URL/TWILIO_AUTH_TOKEN unset`);
      return res.status(403).send('invalid signature');
    }
    try {
      await recordDeliveryStatus({ sid: params.MessageSid, status: params.MessageStatus, errorCode: params.ErrorCode });
    } catch (err) {
      console.error(`• [jobs] [${ts()}] /twilio/status failed: ${err.message}`);
    }
    return res.status(204).end();
  };
}

// ── lifecycle ────────────────────────────────────────────────────────

let _timer = null;
let _inflight = null;
let _stopping = false;

/**
 * Start ticking. `now` is a clock function (tests). The first tick reaps abandoned runs and
 * then runs immediately, so a restart at 08:00:30 doesn't wait a minute.
 */
function start({ now = () => new Date(), intervalMs = DEFAULT_INTERVAL_MS, ...opts } = {}) {
  if (_timer) return;
  _stopping = false;
  const tick = (first = false) => {
    // A slow tick (many users, slow ERPNext) must not overlap the next one.
    if (_inflight) return _inflight;
    _inflight = (async () => {
      try {
        if (first) await reapAbandoned(now());
        await runDue({ ...opts, now, isStopping: () => _stopping });
      } catch (err) {
        console.error(`• [jobs] [${ts()}] tick failed: ${err.message}`);
      }
    })().finally(() => {
      _inflight = null;
    });
    return _inflight;
  };
  _timer = setInterval(tick, intervalMs);
  if (_timer.unref) _timer.unref();
  console.log(`• [jobs] [${ts()}] scheduler started: ${(opts.jobs || getJobs()).map((j) => j.name).join(', ') || '(no jobs)'} every ${Math.round(intervalMs / 1000)}s`);
  tick(true);
}

/**
 * Stop ticking. The in-flight tick finishes the user in hand and starts no new users.
 * Resolves when that tick and any overrun jobs have settled (the caller caps the wait).
 */
function stop() {
  _stopping = true;
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log(`• [jobs] [${ts()}] scheduler stopped`);
  }
  return Promise.all([_inflight, ..._late]).then(() => undefined);
}

/** Tests: resolves once overrun jobs have finished and recorded their real outcome. */
function settled() {
  return Promise.all([..._late]).then(() => undefined);
}

module.exports = {
  start, stop, runDue, loadJobs, getJobs, jobSetting, dueRunDate, reapAbandoned,
  recordDeliveryStatus, twilioStatusHandler, settled, DEFAULT_WINDOW_MIN,
};
