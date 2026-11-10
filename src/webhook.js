/**
 * POST /webhook — Twilio's inbound WhatsApp message callback. Mounted by server.js through the
 * 'whatsapp' channel (src/channels/twilio.js: webhookPath '/webhook', webhookHandler wraps this
 * one); the form body becomes the normalised inbound message (src/channels/index.js) before
 * processMessage sees it.
 *
 * X-Twilio-Signature is checked against the exact public URL Twilio calls: TWILIO_WEBHOOK_URL if
 * set, else PUBLIC_BASE_URL + '/webhook' (the same origin the /twilio/status route uses), with
 * TWILIO_AUTH_TOKEN. Invalid → 403 and the message is dropped.
 *
 * When neither URL is configured:
 *   - NODE_ENV=production → every request is refused (403), logged once. Without a URL there is
 *     nothing to check the signature against, and an unchecked webhook lets anyone post a message
 *     "from" any registered user's number.
 *   - otherwise (local dev behind a changing ngrok URL) the check is skipped; server.js logs a
 *     loud warning at boot.
 * A configured URL that isn't a valid absolute http(s) URL throws at boot (webhookUrl) instead
 * of failing every message later.
 */
const { twilioSignatureOk } = require('./twilio-signature');
const { ts } = require('./erp-sync/common');
const { normalizeAddress } = require('./channels/address');

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function checkedUrl(name, value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL: "${value}"`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`${name} must be an http(s) URL: "${value}"`);
  return value;
}

/** The URL Twilio signs for /webhook, or null when unconfigured. Throws on a malformed URL. */
function webhookUrl(env = process.env) {
  // PUBLIC_BASE_URL is checked even when TWILIO_WEBHOOK_URL overrides it here: the status route
  // and Twilio status callbacks still use it.
  if (env.PUBLIC_BASE_URL) checkedUrl('PUBLIC_BASE_URL', env.PUBLIC_BASE_URL);
  if (env.TWILIO_WEBHOOK_URL) return checkedUrl('TWILIO_WEBHOOK_URL', env.TWILIO_WEBHOOK_URL);
  if (env.PUBLIC_BASE_URL) return `${String(env.PUBLIC_BASE_URL).replace(/\/$/, '')}/webhook`;
  return null;
}

/**
 * Express handler. Options are injectable for tests; `processMessage` is
 * whatsapp.processIncomingMessage and receives the normalised inbound message (`toInbound`,
 * default inboundFromTwilio). `url: null` means unconfigured (see the header for the
 * production vs dev behaviour).
 */
function webhookHandler({
  processMessage,
  toInbound = (form) => require('./channels/twilio').inboundFromTwilio(form),
  url = webhookUrl(),
  authToken = process.env.TWILIO_AUTH_TOKEN,
  production = process.env.NODE_ENV === 'production',
  validate,
} = {}) {
  let warnedUnconfigured = false;
  // Converting the form can await vCard downloads, so conversion + the processMessage CALL are
  // chained per sender: a quick follow-up text can't overtake a contact share on its way into
  // whatsapp.js's per-sender FIFO. Only the call is chained, not the processing it starts.
  const tails = new Map();
  const inOrder = (form) => {
    // Same key as whatsapp.js's queue (the normalised address), so "whatsapp:+66…" and "+66…"
    // can never land on two chains that overtake each other.
    const key = normalizeAddress(form && form.From) || 'unknown';
    const run = (tails.get(key) || Promise.resolve())
      .then(() => toInbound(form))
      // toInbound → null: not a message to process (e.g. a From that isn't a WhatsApp address).
      .then((inbound) => ({ done: inbound ? processMessage(inbound) : undefined }));
    const tail = run.catch(() => {});
    tails.set(key, tail);
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run.then(({ done }) => done);
  };
  return (req, res) => {
    if (!url && production) {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        console.error(`• [webhook] [${ts()}] refusing all requests: NODE_ENV=production but neither TWILIO_WEBHOOK_URL nor PUBLIC_BASE_URL is set`);
      }
      return res.status(403).send('webhook signature URL not configured');
    }
    if (url && !twilioSignatureOk(req, { authToken, url, validate })) {
      console.error(`• [webhook] [${ts()}] rejected: invalid X-Twilio-Signature (or TWILIO_AUTH_TOKEN unset)`);
      return res.status(403).send('invalid signature');
    }

    // Ack Twilio immediately so the 15s webhook timeout never kicks in.
    res.set('Content-Type', 'text/xml');
    res.send(EMPTY_TWIML);

    // Process and send the actual reply via Twilio REST API in the background.
    const body = req.body || {};
    return inOrder(body)
      .catch((err) => {
        console.error('[webhook async] processing error:', err);
      });
  };
}

module.exports = { webhookHandler, webhookUrl, EMPTY_TWIML };
