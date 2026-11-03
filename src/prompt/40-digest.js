/**
 * Scheduled messages (morning digest, customer reminders) and the set_schedule_preferences tool.
 * Shows the current settings so the model can answer "when do I get my summary?" without a tool call.
 */
const { DEFAULT_TIMEZONE, parseJobPrefs, normalizeTime } = require('../jobs');
const digestJob = require('../jobs/digest.job');

module.exports = ({ user } = {}) => {
  const tz = (user && user.timezone) || DEFAULT_TIMEZONE;
  const prefs = parseJobPrefs(user && user.job_prefs);
  const digestOn = !user || digestJob.enabled(user);
  const digestAt = normalizeTime(prefs.digest && prefs.digest.time) || digestJob.defaultTime;
  return `SCHEDULED MESSAGES:
- Current: morning digest ${digestOn ? `at ${digestAt}` : 'OFF'}, timezone ${tz}.
- The morning digest is a daily WhatsApp summary to the user: cash per wallet, overdue and due-this-week invoices/bills, yesterday's income and expenses. Days with nothing to report send nothing.
- Call set_schedule_preferences when the user changes it: "send my digest at 7:30" → time "07:30"; "turn off the morning summary" → enabled false; "my timezone is Singapore" → timezone "Asia/Singapore" (always an IANA Area/City name). "send payment reminders to my customers at 10am" → job "reminders", time "10:00".
- Turning customer reminders on/off is set_payment_settings (reminders_enabled), never set_schedule_preferences.
- Pass only what changed. Then reply with the tool's confirmation line as-is, e.g. "Digest set for 07:30 Asia/Bangkok."
- On an error (unknown timezone, bad time), ask once for a corrected value.`;
};
