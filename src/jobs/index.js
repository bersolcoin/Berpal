/**
 * Helpers shared by the scheduler, the jobs and the set_schedule_preferences tool:
 * user-local clock, HH:MM / timezone validation, job_prefs parsing.
 * Kept free of job loading so a tool can require it without pulling every *.job.js in.
 */
const DEFAULT_TIMEZONE = 'Asia/Bangkok';
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

// IANA geographic areas. Etc/*, bare abbreviations (EST, ICT) and raw offsets are refused:
// they don't follow DST and owners rarely mean them.
const TZ_AREAS = new Set(['Africa', 'America', 'Antarctica', 'Arctic', 'Asia', 'Atlantic', 'Australia', 'Europe', 'Indian', 'Pacific']);
const TZ_SHAPE = /^([A-Za-z]+)\/[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)?$/;

/**
 * Canonical IANA name ('asia/singapore' → 'Asia/Singapore') if `tz` is an Area/City zone Intl
 * knows, or 'UTC'; otherwise null.
 */
function validTimezone(tz) {
  if (!tz || typeof tz !== 'string') return null;
  const raw = tz.trim();
  if (/^utc$/i.test(raw)) return 'UTC';
  const shape = TZ_SHAPE.exec(raw);
  if (!shape) return null;
  const area = shape[1][0].toUpperCase() + shape[1].slice(1).toLowerCase();
  if (!TZ_AREAS.has(area)) return null;
  let resolved;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  const r = TZ_SHAPE.exec(resolved);
  return r && TZ_AREAS.has(r[1]) ? resolved : null;
}

/** '7:30' → '07:30'; anything that isn't a 24h HH:MM → null. */
function normalizeTime(s) {
  const m = TIME_RE.exec(String(s ?? '').trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

/**
 * The user's wall clock at `now`: { date: 'YYYY-MM-DD', time: 'HH:MM', timezone }.
 * A bad stored timezone falls back to the default rather than stalling that user's jobs.
 */
function localClock(now, timezone) {
  const tz = validTimezone(timezone) || DEFAULT_TIMEZONE;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, timezone: tz };
}

/** 'HH:MM' → minutes since midnight (assumes a normalized time). */
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * A job's run window in minutes: a number of minutes, or an 'H:MM' duration ('2:00' = 120).
 * Anything else → null (caller falls back to the default).
 */
function windowMinutes(w) {
  if (typeof w === 'number' && Number.isFinite(w) && w > 0) return Math.min(Math.round(w), 1440);
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(w ?? '').trim());
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins > 0 ? Math.min(mins, 1440) : null;
}

/** DISABLE_JOBS=1|true|yes|on (any case) turns the scheduler off. */
function jobsDisabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** users.job_prefs is free-form JSON text; a corrupt value must not break the scheduler. */
function parseJobPrefs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

module.exports = {
  DEFAULT_TIMEZONE, validTimezone, normalizeTime, localClock, addDays, parseJobPrefs,
  toMinutes, windowMinutes, jobsDisabled,
};
