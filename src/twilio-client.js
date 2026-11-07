/**
 * The Twilio WhatsApp sender, kept at this path for existing requires and test stubs.
 *
 * The sending logic lives in src/channels/twilio.js; this module only builds THE instance from
 * process.env (one Twilio client, one "[twilio] env=… from=…" line) as a plain mutable object.
 * The 'whatsapp' channel calls through this object at call time, so replacing e.g.
 * `twilioClient.sendText` in a test intercepts channel sends as well.
 *
 * New code should not require this: use require('./channels').forAddress(address) (or
 * .get('whatsapp') for customer outreach).
 */
const { createSender } = require('./channels/twilio');

module.exports = { ...createSender(process.env) };
