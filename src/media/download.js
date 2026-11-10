/**
 * Download a Twilio media URL as raw bytes. Twilio media URLs require the account's basic auth
 * and redirect to a signed CDN URL; fetch follows the redirect (and drops Authorization on the
 * cross-origin hop, per the fetch spec).
 */
const { ts } = require('../erp-sync/common');

const DOWNLOAD_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

/** MEDIA_MAX_BYTES must be a positive integer; a typo'd value fails the boot instead of disabling the cap. */
function parseMaxBytes(value) {
  if (value == null || value === '') return DEFAULT_MAX_BYTES;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`MEDIA_MAX_BYTES must be a positive integer, got "${value}"`);
  return n;
}

let maxBytes = parseMaxBytes(process.env.MEDIA_MAX_BYTES);

class MediaTooLargeError extends Error {
  constructor(size, cap = maxBytes) {
    super(`media too large: over ${cap} bytes (got ${size})`);
    this.code = 'MEDIA_TOO_LARGE';
  }
}

/**
 * MediaUrl* comes from the webhook body, which anyone can POST. Only ever send the Twilio
 * credentials to Twilio itself — otherwise a forged webhook could harvest SID:token or make us
 * fetch internal URLs.
 */
function isTwilioMediaUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  return host === 'api.twilio.com' || host.endsWith('.twilio.com');
}

/**
 * Read a fetch Response body chunk by chunk, aborting the moment it passes the cap. Content-Length
 * can be missing or lie, so it's only an early-out — this is the real bound on memory. `cap`
 * defaults to MEDIA_MAX_BYTES; channels with their own override (src/channels/line.js) pass theirs.
 */
async function readCapped(res, abort, cap = maxBytes) {
  const declared = Number(res.headers && res.headers.get && res.headers.get('content-length'));
  if (declared > cap) {
    abort();
    throw new MediaTooLargeError(declared, cap);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      abort();
      await reader.cancel().catch(() => {});
      throw new MediaTooLargeError(total, cap);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

async function twilioDownload(url) {
  if (!isTwilioMediaUrl(url)) throw new Error('refusing non-Twilio media URL');
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set');
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const controller = new AbortController();
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
  });
  if (!res.ok) throw new Error(`media download failed: HTTP ${res.status}`);
  return readCapped(res, () => controller.abort());
}

let _impl = twilioDownload;

/** Throws MediaTooLargeError over MEDIA_MAX_BYTES; returns `bytes`. Any channel's download. */
function enforceMaxBytes(bytes) {
  if (bytes.length > maxBytes) throw new MediaTooLargeError(bytes.length);
  return bytes;
}

/**
 * Twilio media (the 'whatsapp' channel's downloadMedia): resolve to a Buffer of the bytes;
 * throws on failure, bad URL, or over MEDIA_MAX_BYTES.
 */
async function downloadMedia(url) {
  const bytes = await _impl(url);
  // Stubs (tests) bypass readCapped; keep the cap authoritative for every path.
  enforceMaxBytes(bytes);
  console.log(`• [media] [${ts()}] downloaded ${bytes.length} bytes`);
  return bytes;
}

/** Tests only: replace the downloader with (url) => Buffer. Pass null to restore. */
function _setDownloaderForTests(fn) {
  _impl = fn || twilioDownload;
}

/** Tests only: override the size cap (null → back to the env/default value). */
function _setMaxBytesForTests(n) {
  maxBytes = n == null ? parseMaxBytes(process.env.MEDIA_MAX_BYTES) : n;
}

module.exports = {
  downloadMedia, enforceMaxBytes, isTwilioMediaUrl, parseMaxBytes, readCapped, MediaTooLargeError,
  _setDownloaderForTests, _setMaxBytesForTests,
};
