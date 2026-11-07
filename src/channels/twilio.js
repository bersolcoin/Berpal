/**
 * WhatsApp over Twilio: the 'whatsapp' channel (contract in ./index.js).
 *
 * Sending: createSender(env) builds the Twilio REST sender (sendText / sendConfirmation /
 * sendMedia / sendTemplate). src/twilio-client.js holds THE instance (one Twilio client, one
 * "[twilio] env=… from=…" boot line) as a plain mutable object, and this channel's methods call
 * through it at call time — so tests that monkey-patch `twilioClient.sendText` etc. intercept
 * sends made via channels.forAddress(...) too.
 *
 * Receiving: webhookHandler wraps the X-Twilio-Signature-checked handler in src/webhook.js;
 * inboundFromTwilio turns Twilio's form body into the normalised inbound message (vCards are
 * downloaded and parsed into `contacts` here and removed from `media`).
 *
 * Media: downloadMedia(item) goes through src/media/download.js (Twilio-host allowlist, our
 * account credentials, timeout, MEDIA_MAX_BYTES); item.ref is the Twilio MediaUrl.
 */
const twilio = require('twilio');
const channels = require('./index');
const { normalizeAddress, channelOf } = require('./address');
const download = require('../media/download');
const vcard = require('../vcard');

/** The WhatsApp sender for TWILIO_ENV (src/config.js senderFor() mirrors this). No logging. */
function resolveFromNumber(env = process.env, { warn = false } = {}) {
  const mode = (env.TWILIO_ENV || 'sandbox').toLowerCase();
  const sandbox = env.TWILIO_WHATSAPP_NUMBER_SANDBOX;
  const live = env.TWILIO_WHATSAPP_NUMBER_LIVE;
  const legacy = env.TWILIO_WHATSAPP_NUMBER;

  if (mode === 'live') {
    if (live) return live;
    if (warn) console.warn('[twilio] TWILIO_ENV=live but TWILIO_WHATSAPP_NUMBER_LIVE not set');
  }
  return sandbox || legacy || null;
}

/**
 * "whatsapp:+66…" for Twilio, or null when `addr` is not a WhatsApp address: a LINE address
 * ("line:U…", any case, with or without a "whatsapp:" in front) must never become
 * "whatsapp:line:U…" and reach Twilio. Every send below refuses a null.
 */
function normalizeWhatsappAddress(addr) {
  if (!addr) return null;
  const a = normalizeAddress(addr);
  if (!a || channelOf(a) !== 'whatsapp') return null;
  return `whatsapp:${a}`;
}

/** Build the Twilio sender from `env`. Logs the sender once, like the old module load did. */
function createSender(env = process.env) {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const confirmationContentSid = env.TWILIO_CONFIRMATION_CONTENT_SID;
  const fromNumber = resolveFromNumber(env, { warn: true });
  console.log(`[twilio] env=${env.TWILIO_ENV || 'sandbox'} from=${fromNumber || '(none)'}`);

  const client = accountSid && authToken ? twilio(accountSid, authToken) : null;
  if (!client) {
    console.warn('[twilio] missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN — outbound messaging disabled');
  }

  async function sendConfirmation(toAddress, summaryText) {
    if (!client) {
      console.error('[twilio] cannot send confirmation: client not configured');
      return null;
    }
    if (!confirmationContentSid) {
      console.error('[twilio] cannot send confirmation: TWILIO_CONFIRMATION_CONTENT_SID not set');
      return null;
    }
    if (!fromNumber) {
      console.error('[twilio] cannot send confirmation: TWILIO_WHATSAPP_NUMBER not set');
      return null;
    }

    const to = normalizeWhatsappAddress(toAddress);
    if (!to) {
      console.error('[twilio] cannot send confirmation: not a WhatsApp address');
      return null;
    }

    try {
      const message = await client.messages.create({
        from: fromNumber,
        to,
        contentSid: confirmationContentSid,
        contentVariables: JSON.stringify({ '1': summaryText }),
      });
      console.log(`[twilio] sent confirmation message_sid=${message.sid} to=${to}`);
      return message.sid;
    } catch (err) {
      console.error('[twilio] failed to send confirmation:', err.message);
      return null;
    }
  }

  async function sendText(toAddress, text) {
    if (!client) {
      console.error('[twilio] cannot send text: client not configured');
      return null;
    }
    if (!fromNumber) {
      console.error('[twilio] cannot send text: from number not set');
      return null;
    }
    if (!text || !String(text).trim()) {
      return null;
    }

    const to = normalizeWhatsappAddress(toAddress);
    if (!to) {
      console.error('[twilio] cannot send text: not a WhatsApp address');
      return null;
    }

    try {
      const message = await client.messages.create({
        from: fromNumber,
        to,
        body: String(text),
      });
      console.log(`[twilio] sent text message_sid=${message.sid} to=${to}`);
      return message.sid;
    } catch (err) {
      console.error('[twilio] failed to send text:', err.message);
      return null;
    }
  }

  /**
   * Send text + media (PDFs, images). mediaUrls must be publicly fetchable — Twilio downloads them.
   *
   * WhatsApp accepts only ONE media item per message, so the first URL rides with the text (as its
   * caption) and each further URL goes out as its own message right after. If the first message
   * (the one carrying the text) fails, nothing else is sent — orphaned attachments would confuse
   * the recipient.
   *
   * Returns { sids, errors }: sids in send order; errors [{ index, code, message }] with Twilio's
   * error code, so callers can tell "nothing went out" (sids empty) from "partly sent".
   * Asks for a status callback when PUBLIC_BASE_URL is set, so async delivery failures (e.g. 63016,
   * outside the 24h window) reach POST /twilio/status.
   */
  async function sendMedia(toAddress, text, mediaUrls = []) {
    const fail = (code, message) => {
      console.error(`[twilio] cannot send media: ${message}`);
      return { sids: [], errors: [{ index: 0, code, message }] };
    };
    if (!client) return fail('not_configured', 'client not configured');
    if (!fromNumber) return fail('no_from_number', 'from number not set');

    const urls = (mediaUrls || []).filter(Boolean);
    const body = text && String(text).trim() ? String(text) : null;
    if (!urls.length && !body) return fail('empty', 'nothing to send');
    const parts = urls.length
      ? urls.map((u, i) => ({ ...(i === 0 && body ? { body } : {}), mediaUrl: [u] }))
      : [{ body }];

    const to = normalizeWhatsappAddress(toAddress);
    if (!to) return fail('not_whatsapp', 'not a WhatsApp address');
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    const sids = [];
    const errors = [];
    for (let i = 0; i < parts.length; i++) {
      try {
        const message = await client.messages.create({
          from: fromNumber,
          to,
          ...parts[i],
          ...(base ? { statusCallback: `${base}/twilio/status` } : {}),
        });
        console.log(`[twilio] sent media message_sid=${message.sid} to=${to}`);
        sids.push(message.sid);
      } catch (err) {
        console.error('[twilio] failed to send media:', err.message);
        errors.push({ index: i, code: err.code ?? null, message: err.message });
        if (i === 0) break;
      }
    }
    return { sids, errors };
  }

  /**
   * Send an approved WhatsApp template (Twilio Content API). Needed for business-initiated
   * messages outside WhatsApp's 24h customer-service window: Twilio ACCEPTS free-form text there
   * and returns a SID, but delivery then fails asynchronously (error 63016).
   * `variables` is { '1': '…', '2': '…' }; WhatsApp rejects newlines/tabs inside variables.
   * Asks for a status callback when PUBLIC_BASE_URL is set, so failures reach POST /twilio/status.
   *
   * Unlike sendText, this THROWS (Error with .code / .status) instead of returning null, so the
   * caller can record why — "63112 template not approved" beats "no sid".
   */
  async function sendTemplate(toAddress, contentSid, variables = {}) {
    const fail = (code, message) => Object.assign(new Error(message), { code });
    if (!client) throw fail('TWILIO_NOT_CONFIGURED', 'twilio template: client not configured');
    if (!contentSid) throw fail('TWILIO_NO_CONTENT_SID', 'twilio template: no content SID');
    if (!fromNumber) throw fail('TWILIO_NO_FROM', 'twilio template: TWILIO_WHATSAPP_NUMBER not set');

    const to = normalizeWhatsappAddress(toAddress);
    if (!to) throw fail('TWILIO_NOT_WHATSAPP', 'twilio template: not a WhatsApp address');
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

    try {
      const message = await client.messages.create({
        from: fromNumber,
        to,
        contentSid,
        contentVariables: JSON.stringify(variables),
        ...(base ? { statusCallback: `${base}/twilio/status` } : {}),
      });
      console.log(`[twilio] sent template ${contentSid} message_sid=${message.sid} to=${to}`);
      return message.sid;
    } catch (err) {
      console.error(`[twilio] failed to send template: ${err.code || ''} ${err.message}`);
      const e = fail(err.code || 'TWILIO_ERROR', `twilio template send failed${err.code ? ` (${err.code})` : ''}: ${err.message}`);
      e.status = err.status;
      throw e;
    }
  }

  return { sendConfirmation, sendText, sendMedia, sendTemplate };
}

// ── inbound ─────────────────────────────────────────────────────────

/** vCard text through the media downloader (same allowlist/cap as photos); null on failure. */
async function fetchVCard(url) {
  try {
    return (await download.downloadMedia(url)).toString('utf8');
  } catch (err) {
    console.error('[whatsapp] media fetch error:', err.message);
    return null;
  }
}

/**
 * Twilio's webhook form body → the normalised inbound message. Async because shared contacts
 * (vCard attachments) are downloaded and parsed here: they leave `media` and land in `contacts`
 * (only those with a name or phone; an unreadable vCard is dropped). null when From is not a
 * WhatsApp address (the webhook then drops the message). Exported for tests.
 */
async function inboundFromTwilio(form) {
  const raw = form || {};
  // Twilio only ever posts WhatsApp senders. A From that normalises to another channel's address
  // ("whatsapp:line:U…", only possible on an unsigned dev webhook) would otherwise act — and be
  // answered — as that LINE user: dropped before anything (vCards included) is fetched.
  if (raw.From != null && String(raw.From).trim() && channelOf(raw.From) !== 'whatsapp') {
    console.error('[whatsapp] dropping inbound: From is not a WhatsApp address');
    return null;
  }
  const media = [];
  const contacts = [];
  const n = parseInt(raw.NumMedia || '0', 10) || 0;
  for (let i = 0; i < n; i++) {
    const type = raw[`MediaContentType${i}`];
    const url = raw[`MediaUrl${i}`];
    if (!type || !url) continue;
    const contentType = String(type).split(';')[0].trim().toLowerCase();
    if (/vcard/.test(contentType)) {
      const text = await fetchVCard(url);
      const parsed = text ? vcard.parseVCard(text) : null;
      if (parsed && (parsed.name || parsed.phone)) contacts.push(parsed);
      continue;
    }
    media.push({ contentType, ref: url, url });
  }
  return {
    channel: 'whatsapp',
    from: normalizeAddress(raw.From) || 'unknown',
    body: raw.Body || '',
    media,
    contacts,
    raw: form || null,
  };
}

// ── the channel ─────────────────────────────────────────────────────

// Lazy: src/twilio-client.js requires this file to build its sender.
const sender = () => require('../twilio-client');

const whatsapp = {
  name: 'whatsapp',
  webhookPath: '/webhook',
  supportsTemplates: true,

  isConfigured(env = process.env) {
    return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && resolveFromNumber(env));
  },

  sendText: (address, text) => sender().sendText(address, text),
  sendConfirmation: (address, text) => sender().sendConfirmation(address, text),
  sendMedia: (address, text, mediaUrls = []) => sender().sendMedia(address, text, mediaUrls),
  sendTemplate: (address, contentSid, vars = {}) => sender().sendTemplate(address, contentSid, vars),

  /** item = { contentType, ref: MediaUrl } → { bytes, contentType }. */
  async downloadMedia(item) {
    const bytes = await download.downloadMedia(item.ref || item.url);
    return { bytes, contentType: item.contentType };
  },

  /**
   * POST /webhook. opts: { processMessage, url? } plus src/webhook.js's test injections
   * (authToken, production, validate). `url` omitted → TWILIO_WEBHOOK_URL / PUBLIC_BASE_URL.
   */
  webhookHandler(opts = {}) {
    return require('../webhook').webhookHandler({ ...opts, toInbound: inboundFromTwilio });
  },
};

channels.register(whatsapp);

module.exports = { channel: whatsapp, createSender, resolveFromNumber, inboundFromTwilio, normalizeWhatsappAddress };
