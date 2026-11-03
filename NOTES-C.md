# Lane C: daily job scheduler and morning digest

## What was built

| File | Purpose |
|---|---|
| `src/migrations/040-schedule.sql` | Adds three `users` columns: `timezone` (default `Asia/Bangkok`), `digest_enabled` (default 1) and `job_prefs` (JSON text). Creates `job_runs` in one `CREATE TABLE IF NOT EXISTS`: `id BIGSERIAL PRIMARY KEY`, `user_id` FK `ON DELETE CASCADE`, job, run_date, started_at, finished_at, status, error, `message_sid`, `result`, and `UNIQUE(user_id, job, run_date)`. Columns added later use `ADD COLUMN IF NOT EXISTS` only. Nothing alters a type or drops/re-adds a constraint on boot. The one-off ALTERs for a database created from the pre-review draft are in a comment at the end of the file. The test runs the file three times on pg-mem (with `noAstCoverageCheck`) and checks that no such statement appears outside comments. |
| `src/jobs/index.js` | Pure helpers: `localClock`, `validTimezone` (Area/City or `UTC` only), `normalizeTime`, `windowMinutes`, `jobsDisabled`, `parseJobPrefs`, `addDays`, `toMinutes`. |
| `src/jobs/scheduler.js` | Exports `start({ now, intervalMs })`, `stop()` (returns the in-flight tick's promise) and `runDue({ now })`. Also exports `loadJobs`, `getJobs`, `jobSetting`, `dueRunDate`, `reapAbandoned`, `recordDeliveryStatus` and `twilioStatusHandler`. |
| `src/jobs/digest.job.js` | `digest`, default 08:00, window 120 min. Sections: cash (credit cards listed separately as "Owed on cards"), overdue, due in the next 7 days, yesterday. Counts come from `total_count`; days are counted from the user's local date. Empty sections are dropped, and nothing is sent when all are empty. Delivery is covered below. |
| `src/tools/set-schedule-preferences.js` | Sets the digest time and on/off, the reminders time (time only), and the timezone. |
| `src/prompt/40-digest.js` | Tells the model when to call the tool and how to confirm; shows the user's current settings, using the job's own `defaultTime`. |
| `src/twilio-client.js` | Added `sendTemplate(to, contentSid, variables)` only. It returns the SID and sets `statusCallback` when `PUBLIC_BASE_URL` is set. It **throws** an `Error` with `.code` (and `.status`) on Twilio or configuration errors, so `job_runs.error` records e.g. `twilio template send failed (63112): …`. |
| `src/erp-query/open-invoices.js` | Added an optional `today` (ISO date) option. The default is unchanged (server UTC date). |
| `server.js` | Starts the scheduler unless `DISABLE_JOBS` matches `1/true/yes/on` (any case). Adds `POST /twilio/status`, which always checks the signature. On SIGTERM or SIGINT it awaits `scheduler.stop()` for at most 10s, then exits. `stop()` sets a flag that the tick checks between users, so no new user's sends start after shutdown begins. |
| `test/jobs.test.js` | 29 tests (see the list at the end). |

## Job interface contract

```js
// src/jobs/<anything>.job.js
module.exports = {
  name: 'reminders',            // unique; key in job_runs.job and users.job_prefs
  defaultTime: '09:00',         // 24h HH:MM, user-local
  window: 120,                  // optional: minutes, or 'H:MM'. Default 120. Runs only inside [time, time+window)
  timeoutMs: 60000,             // optional: per-run time budget. Default 60s
  enabled: (user) => !!user.x,  // optional: when false, the day is NOT claimed, so switching it on later that day still runs
  async run(user, deps) { … },  // deps = { erp, twilio, now, clock, signal }
};
```

- `deps.erp` is `erpnext.forUser(user)`, built lazily once per user per tick. `deps.twilio` is `src/twilio-client`.
- `deps.now` is the Date for this user. It is re-read for each user rather than frozen for the whole tick.
- `deps.clock` is `{ date, time, timezone, run_date }`:
  - `date` and `time` are the user's **real** local date and time. Use `date` for "today" and "yesterday", and pass it as `today` to `getOpenInvoices`.
  - `run_date` is the day the run belongs to. It differs from `date` only when a window crosses midnight: a 23:30 job running at 00:30 has `run_date` = the previous day. It is used for the once-per-day lock.
- `deps.signal` is an `AbortSignal` that fires when the run reaches `timeoutMs`. Jobs should pass it to `fetch` and other long calls, and stop sending once it has fired.
- **Timeout:** the row is set to `failed` / `timeout` immediately, but JS can't kill the job.
  - When an overrunning job finally settles, its **real** outcome (status, result, `message_sid`) overwrites the row, with error `finished after Nms timeout` or `timeout; then <error>`.
  - Until it settles, no other job starts for that user; later ticks skip the user.
  - `stop()` also waits for overrunning jobs, capped at 10s by `server.js`.
- **Return value:**
  - `{ skipped: true, note? }` records the run as `skipped`, with the note in `error`.
  - Any other object is stored as JSON in `job_runs.result`, and `message_sid` (if given) goes into `job_runs.message_sid`.
  - The run is recorded `failed` when `sent` is 0 and there were failures: `failed` as an array or a number (`failed: 2`), or a `failures` array.
  - A throw records `failed`. Other jobs and users keep running.
- **Once per day.** The job_runs row is claimed with `INSERT … ON CONFLICT DO NOTHING RETURNING id` before `run()`. It has no conflict target on purpose: with a target, pg-mem returns the existing row. A claim is also refused when either of these holds:
  - the same (user, job) started a run in the last 20h, so changing timezone can't produce a second "today";
  - the latest recorded `run_date` for that (user, job) is on or after the candidate date.
  
  Each tick does one read of the last 3 days of runs to apply these checks; the INSERT stays the lock.
- **No catch-up, no late runs.** A day missed or started outside the window is skipped (for example a deploy at 22:00).
- **Abandoned runs.** On start, rows still `running` after more than 30 min are marked `failed` / `abandoned`, and are never re-run.

`job_prefs` looks like `{ "digest": { "time": "07:30" }, "reminders": { "time": "10:15" } }`. The scheduler also honours `enabled: false` in it, but the tool never writes that. On/off has one switch per job: `users.digest_enabled` for the digest, and `users.reminders_enabled` (set via `set_payment_settings`) for reminders.

## Digest delivery and the WhatsApp 24h window (template required in production)

WhatsApp only delivers free-form business messages within 24h of the user's last message. Outside that window Twilio still accepts the message and returns a SID; the failure (63016) arrives later through the status callback. The digest therefore works like this:

1. **`TWILIO_DIGEST_CONTENT_SID` is set:** it sends the approved template via `sendTemplate` with variables `{1: 'Tue 3 Nov', 2: <body on one line, sections joined by " | ">}`. WhatsApp rejects newlines and tabs in variables, so every tab, CR and LF in both variables becomes a space. The body is capped at 900 characters. Suggested template body: `Your books, {{1}}: {{2}}`.
2. **Otherwise:** it sends free-form text only if `conversations.last_message_at` is within the last 23h. If not, the run is recorded `skipped` with the note `outside 24h window; set TWILIO_DIGEST_CONTENT_SID`.
3. The SID is stored in `job_runs.message_sid`. `POST /twilio/status`:
   - validates `X-Twilio-Signature` against `PUBLIC_BASE_URL + '/twilio/status'` and `TWILIO_AUTH_TOKEN`, and returns 403 when either is unset. There is no bypass switch in production code: tests inject `twilioStatusHandler({ validate })`, and one test runs the real `twilio.validateRequest` with a computed signature;
   - on `failed` or `undelivered`, marks the matching job_runs row `failed` with `twilio <status> <ErrorCode>`;
   - also updates `outreach_log.status`/`error` by `message_sid`, but only if `information_schema` shows that column exists.

**Production requirement:** create and approve a WhatsApp template for the digest, set `TWILIO_DIGEST_CONTENT_SID`, and set `PUBLIC_BASE_URL` so template sends carry a status callback. Free-form sends via the existing `sendText` carry no `statusCallback` (I didn't change it). They only get callbacks if a status callback URL is configured on the Twilio sender or Messaging Service.

## Env vars to add to `.env.example` (I haven't edited it)

```
# Skip the daily job scheduler (digest, reminders) on this instance: 1/true/yes/on.
DISABLE_JOBS=false
# Approved WhatsApp template for the morning digest (variables {{1}} date, {{2}} body).
TWILIO_DIGEST_CONTENT_SID=
# Public https origin of this server; used for Twilio status callbacks + signature validation.
PUBLIC_BASE_URL=https://your-host.example.com
```

## For the owner of `src/jobs/reminders.job.js` (I didn't edit it)

I'm not asking reminders to export `enabled(user)`. It runs for disabled users too, to clean up files, so it has to claim the day even when switched off. The cost: switching reminders on after 09:00 takes effect the next day. If same-day switch-on matters, move the cleanup into its own `cleanup.job.js` (no `enabled`); after that, reminders can export `enabled`.

1. It already uses `deps.clock?.date` as "today". Keep it that way: `clock.date` is the real local date, and the run date is `clock.run_date`.
2. Declare `timeoutMs` (larger than 60s for many invoices) and pass `deps.signal` to PDF fetches and sends. Stop the loop once `signal.aborted`.
3. Return SIDs in the result (`message_sid` for the main one, or a list), and write `message_sid` into `outreach_log`. That needs `ALTER TABLE outreach_log ADD COLUMN IF NOT EXISTS message_sid TEXT` in 030. With it, `POST /twilio/status` marks undelivered reminders as failed. Sends to customers outside their 24h window also need an approved template.
4. Consider `window: 60`: customers are messaged only between 09:00 and 10:00 local. The default is 120.
5. `{ sent: 0, failed: [...] | n }` and `{ sent: 0, failures: [...] }` are recorded as failed runs; `{ skipped: true }` is recorded as skipped.

## For the integrator (another lane's file)

- `src/erpnext.js` `ErpNextClient._fetch`: accept an optional `signal` and pass it to `fetch`, so a job's `deps.signal` can cancel in-flight ERPNext calls. The digest would then pass `signal` through the erp-query calls. Today an overrunning digest finishes its reads; it can't hang forever on its own, but it can't be cut short either.

## Changes needed elsewhere (I haven't made them)

- `scripts/check-load.js`: add `require('../src/jobs/scheduler')` and print `✓ jobs/ loads`.
- `README.md`: add `src/jobs/`, `POST /twilio/status` and the env vars above to the layout.
- `.env.example`: the vars above.

## Known limitations

- `ALTER COLUMN id TYPE BIGINT` doesn't widen the sequence of a `job_runs` table created by the first version of this migration (SERIAL). That only matters past 2^31 runs.
- The 20h guard means that moving the digest from evening to morning (for example 20:00 to 08:00 the next day) skips that one morning.
- An overrunning job is aborted only cooperatively, through `deps.signal`. The ERPNext client doesn't take a signal yet (see the integrator note above).
- A real-Postgres database created from the pre-review draft keeps its draft shape until the commented one-off ALTERs are run by hand.
- "Yesterday" totals are in the company (reporting) currency only.
- Template variables are capped at 900 characters, so a very long digest is cut with "…".
- If more than 47 items are overdue, due-soon rows fall outside the 50-row page. The section then shows the correct count with "N items, ask me for the list".

## Tests (test/jobs.test.js)

- The migration file run three times; no on-boot ALTER TYPE or DROP/ADD CONSTRAINT; the PRIMARY KEY enforced and ON DELETE CASCADE cascading.
- Digest content: cards kept out of the cash totals, a wallet named like its currency, a zero-netting currency shown as 0.00, a card in credit, no "Good morning".
- The `today` option, at Bangkok 00:30 local.
- Delivery: the 24h-window skip, the free-form path and the template path; tab/CR/LF flattening; `sendTemplate` throwing with a code that ends up in `job_runs.error`.
- The digest through the scheduler: SID and result recorded, then the status callback marks it failed.
- The status callback: the real signature check (valid, forged, unconfigured) and an injected `validate`; the `outreach_log` column present and absent.
- Timezone, window and `DISABLE_JOBS` parsing.
- Window: before, inside, after, a 22:00 deploy, a job's own window, a window crossing midnight (real local date vs `run_date`).
- Bangkok vs New York at the same UTC instants.
- Timezone change: no second send; no run_date earlier than one already recorded.
- Two concurrent `runDue` passes run once.
- Failure handling: throw; timeout with the AbortSignal fired, the user's next jobs held back while the job overruns, and the late real result and SID recorded; an `enabled()` that throws; `erpFor` failing.
- Result JSON; all-failed as an array, a count or a `failures` list.
- Disabled jobs not claimed.
- `job_prefs`, and inactive, credless and junk-prefs users.
- Auto-load from a temp dir.
- Reaping abandoned runs; `stop()` waits for the in-flight tick and starts no new user.
- Tool validation; reminders time only; the prompt section.
- More than 50 open items.
