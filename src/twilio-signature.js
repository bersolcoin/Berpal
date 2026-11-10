/**
 * X-Twilio-Signature check shared by POST /webhook (src/webhook.js) and POST /twilio/status
 * (src/jobs/scheduler.js). Kept separate so the webhook doesn't load the scheduler.
 */
const defaultValidate = (...args) => require('twilio').validateRequest(...args);

/** `url` is the exact public URL Twilio called; false when the token or URL is missing. */
function twilioSignatureOk(req, { authToken, url, validate = defaultValidate }) {
  const signature = (req.headers && req.headers['x-twilio-signature']) || '';
  return !!(authToken && url && validate(authToken, signature, url, req.body || {}));
}

module.exports = { twilioSignatureOk, defaultValidate };
