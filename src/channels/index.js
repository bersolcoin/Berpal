/**
 * Messaging channels. The bot talks to a user over whichever channel their address belongs to
 * (src/channels/address.js); everything above this layer (conversation, onboarding, jobs, tools)
 * only ever sees addresses, normalised inbound messages and the Channel interface below.
 *
 * ── Channel interface ───────────────────────────────────────────────────────────────────────────
 *
 *   name                     'whatsapp' | 'line'
 *   webhookPath              Express path server.js mounts webhookHandler() on with app.post:
 *                            '/webhook' (whatsapp, the URL Twilio is configured with) and
 *                            '/line/webhook' (line)
 *   isConfigured()           → bool: credentials present. Only configured channels get a webhook
 *                            route (server.js loops over configured()).
 *   supportsTemplates        true when sendTemplate works (WhatsApp Content templates; LINE: false,
 *                            pushes need no template and have no 24-hour window)
 *
 *   sendText(address, text)                      → message id | null   (never throws; logs).
 *                                                  The id must be truthy on success: the digest
 *                                                  job treats null as "not sent" and stores the
 *                                                  id as job_runs.message_sid.
 *   sendConfirmation(address, text)              → message id | null   the card with Yes/No/Edit
 *                                                  buttons (Twilio quick-reply Content template;
 *                                                  LINE quick-reply items). Falls back to sendText.
 *   sendMedia(address, text, mediaUrls = [])     → message id | null   public https URLs
 *   sendTemplate(address, contentSid, vars = {}) → message id          throws when unsupported or
 *                                                  rejected (callers check supportsTemplates)
 *
 *   downloadMedia(item)                          → { bytes, contentType }  for an inbound media
 *                                                  item this channel produced; enforces
 *                                                  MEDIA_MAX_BYTES and a host allowlist / token
 *
 *   webhookHandler(opts)                         Express handler for this channel's inbound
 *                                                  webhook. Verifies the signature, acks fast, and
 *                                                  calls opts.processMessage(inbound) per message.
 *                                                  May return an array of handlers (e.g. a raw-body
 *                                                  parser first); server.js passes it to app.post
 *                                                  as-is. Only express.urlencoded runs globally, so
 *                                                  a JSON body arrives unparsed.
 *
 * ── Normalised inbound message ──────────────────────────────────────────────────────────────────
 *
 *   {
 *     channel:  'whatsapp' | 'line',
 *     from:     address (see address.js),
 *     body:     string (text, caption, or ''),
 *     media:    [{ contentType, ref, url? }]    ref is channel-specific (Twilio MediaUrl, LINE
 *                                               messageId); media/index.js downloads through
 *                                               channel.downloadMedia(item), never by URL itself
 *     contacts: [{ name, phone?, email?, org? }]  shared contacts already parsed (WhatsApp vCard,
 *                                               removed from media; LINE has none)
 *     raw:      the provider payload, for message logging only
 *   }
 *
 * Address-based routing: forAddress(address) returns the channel that delivers to it. Jobs and
 * tools that used to require the Twilio client directly go through here, so a LINE user's digest
 * is pushed over LINE while an invoice to a customer's phone still goes out over WhatsApp.
 */
const { channelOf } = require('./address');

const registry = {};

function register(channel) {
  if (!channel || !channel.name) throw new Error('[channels] a channel needs a name');
  registry[channel.name] = channel;
  return channel;
}

/** A channel is "configured" when its credentials are present; unconfigured ones are not routable. */
function configured() {
  return Object.values(registry).filter((c) => (typeof c.isConfigured === 'function' ? c.isConfigured() : true));
}

function get(name) {
  return registry[name] || null;
}

function forAddress(address) {
  const name = channelOf(address);
  const ch = name && registry[name];
  if (!ch) throw new Error(`[channels] no channel for address ${name || '(invalid)'}`);
  return ch;
}

// Exported BEFORE the adapters load: each adapter does require('./index').register(...) at its
// own load, which is a require cycle back into this file — with module.exports assigned at the
// bottom it would see an empty object.
module.exports = { register, get, forAddress, configured };

// Adapters register themselves on require. Each is optional at runtime (missing credentials →
// isConfigured() false), but the module must load so tests can inject fakes.
for (const mod of ['./twilio', './line']) {
  try {
    require(mod);
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND' || !String(err.message).includes(mod.slice(2))) throw err;
  }
}
