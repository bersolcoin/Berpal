/**
 * A user's address is the one string that identifies them across channels and is what the
 * `users.phone` column holds:
 *
 *   WhatsApp   "+66812345678"        (E.164; inbound "whatsapp:+66…" is normalised to this)
 *   LINE       "line:U4af4980629…"   (the LINE userId behind a stable prefix; LINE gives no phone)
 *
 * Everything keyed by phone today (users, onboarding sessions, rate limits, the per-sender queue,
 * job_runs) keeps working unchanged because the LINE form is just another unique string. Code that
 * needs to know the channel asks here instead of pattern-matching the string itself.
 */
const LINE_PREFIX = 'line:';

function normalizeAddress(raw) {
  if (raw == null) return null;
  // "whatsapp:" first, so "WhatsApp:LINE:U1" canonicalises to "line:U1" like "LINE:U1" does: such
  // an address is a LINE one everywhere (channelOf), and the Twilio adapter refuses it both ways.
  const s = String(raw).trim().replace(/^whatsapp:/i, '').trim();
  if (!s) return null;
  if (/^line:/i.test(s)) return LINE_PREFIX + s.slice(LINE_PREFIX.length).trim();
  return s;
}

/** 'line' | 'whatsapp' */
function channelOf(address) {
  const a = normalizeAddress(address);
  if (!a) return null;
  return a.startsWith(LINE_PREFIX) ? 'line' : 'whatsapp';
}

/** The channel-native id: the E.164 number, or the bare LINE userId. */
function channelIdOf(address) {
  const a = normalizeAddress(address);
  if (!a) return null;
  return a.startsWith(LINE_PREFIX) ? a.slice(LINE_PREFIX.length) : a;
}

function lineAddress(userId) {
  return LINE_PREFIX + String(userId).trim();
}

/** For logs: last 4 characters only, whichever channel. */
function maskAddress(address) {
  const a = normalizeAddress(address) || '';
  const id = channelIdOf(a) || '';
  return `${channelOf(a) === 'line' ? LINE_PREFIX : ''}…${id.slice(-4)}`;
}

module.exports = { normalizeAddress, channelOf, channelIdOf, lineAddress, maskAddress, LINE_PREFIX };
