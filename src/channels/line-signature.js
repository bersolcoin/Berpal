/**
 * X-Line-Signature check for POST /line/webhook (src/channels/line.js).
 *
 * LINE signs the exact request body bytes: signature = base64(HMAC-SHA256(channel secret, body)).
 * Unlike Twilio there is no URL in the signed string, so the check needs the RAW body, before any
 * JSON parse/re-serialise (which would change whitespace and key order and break the HMAC).
 */
const crypto = require('node:crypto');

/** Expected signature for `rawBody` (Buffer or string), base64. */
function lineSignature(rawBody, channelSecret) {
  return crypto.createHmac('sha256', String(channelSecret)).update(rawBody).digest('base64');
}

/**
 * true only when the secret is set, the header is present and it matches in constant time.
 * A missing secret is always false: an unconfigured channel accepts nothing.
 */
function lineSignatureOk(rawBody, signature, channelSecret) {
  if (!channelSecret || !signature || rawBody == null) return false;
  const expected = crypto.createHmac('sha256', String(channelSecret)).update(rawBody).digest();
  const given = Buffer.from(String(signature), 'base64');
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

module.exports = { lineSignature, lineSignatureOk };
