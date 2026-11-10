const { query } = require('../db');
const { DEFAULT_TIMEZONE, validTimezone, normalizeTime, parseJobPrefs } = require('../jobs');

// Jobs whose time the owner can change from chat. On/off has ONE switch per job so two flags
// can never disagree: users.digest_enabled (here) and users.reminders_enabled (owned by
// set_payment_settings, since reminders message the owner's customers).
const JOBS = { digest: 'Digest', reminders: 'Customer payment reminders' };
const REMINDERS_ONOFF_NOTE = 'Reminders are turned on/off with set_payment_settings (reminders_enabled), not here.';

/** The job file's own defaultTime, if that job is installed (loaded lazily, at call time). */
function defaultTimeFor(job) {
  const found = require('../jobs/scheduler').getJobs().find((j) => j.name === job);
  return found ? normalizeTime(found.defaultTime) : null;
}

const definition = {
  name: 'set_schedule_preferences',
  description:
    "Change the user's timezone, the time of their morning digest (cash, overdue and upcoming invoices, yesterday's totals) or turn it on/off, or the time automatic payment reminders go out to their CUSTOMERS. Reminders on/off is NOT here — use set_payment_settings. Pass only what the user asked to change. Returns a confirmation line to relay.",
  parameters: {
    type: 'object',
    properties: {
      job: { type: 'string', enum: Object.keys(JOBS), description: 'Default digest.' },
      time: { type: 'string', description: '24h local time HH:MM, e.g. "7:30am" → "07:30", "6pm" → "18:00".' },
      enabled: { type: 'boolean', description: 'Digest only: false = turn it off, true = back on.' },
      timezone: { type: 'string', description: 'IANA Area/City timezone, e.g. Asia/Singapore, America/New_York, Europe/London, or UTC.' },
    },
  },
};

async function execute(args, ctx) {
  const user = ctx.user;
  const job = args.job || 'digest';
  if (!JOBS[job]) return { ok: false, error: `job must be one of: ${Object.keys(JOBS).join(', ')}` };
  const wantsOnOff = args.enabled != null;
  if (job === 'reminders' && wantsOnOff && args.time == null && args.timezone == null) {
    return { ok: false, error: REMINDERS_ONOFF_NOTE };
  }
  if (args.time == null && !wantsOnOff && args.timezone == null) {
    return { ok: false, error: 'Nothing to change: pass time, enabled and/or timezone.' };
  }

  let time = null;
  if (args.time != null) {
    time = normalizeTime(args.time);
    if (!time) return { ok: false, error: `time must be 24h HH:MM (got "${args.time}")` };
  }
  let timezone = null;
  if (args.timezone != null) {
    timezone = validTimezone(args.timezone);
    if (!timezone) {
      return { ok: false, error: `Unknown timezone "${args.timezone}". Use an IANA Area/City name like Asia/Singapore (not an abbreviation or offset).` };
    }
  }
  if (wantsOnOff && typeof args.enabled !== 'boolean') {
    return { ok: false, error: 'enabled must be true or false' };
  }

  const prefs = parseJobPrefs(user.job_prefs);
  const entry = { ...(prefs[job] || {}) };
  if (time) entry.time = time;
  prefs[job] = entry;

  const digestEnabled = job === 'digest' && wantsOnOff ? (args.enabled ? 1 : 0) : null;
  const r = await query(
    `UPDATE users SET
       job_prefs = $2,
       timezone = COALESCE($3, timezone),
       digest_enabled = COALESCE($4, digest_enabled),
       updated_at = $5
     WHERE id = $1
     RETURNING *`,
    [user.id, JSON.stringify(prefs), timezone, digestEnabled, new Date().toISOString()]
  );
  // Keep this turn's user row current so the prompt / later tools see the new settings.
  Object.assign(user, r.rows[0]);

  const tz = user.timezone || DEFAULT_TIMEZONE;
  const at = entry.time || defaultTimeFor(job);
  const label = JOBS[job];
  const out = { ok: true, job, time: at, timezone: tz };
  if (job === 'digest') {
    out.enabled = Number(user.digest_enabled) !== 0;
    out.confirmation = !out.enabled ? 'Digest turned off.' : at ? `Digest set for ${at} ${tz}.` : `Digest on (${tz}).`;
  } else {
    out.enabled = !!Number(user.reminders_enabled);
    const when = at ? `${at} ${tz}` : tz;
    out.confirmation = out.enabled
      ? `${label} set for ${when}.`
      : `${label} set for ${when} (currently off).`;
    if (wantsOnOff) out.note = REMINDERS_ONOFF_NOTE;
  }
  return out;
}

module.exports = { definition, execute };
