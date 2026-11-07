/**
 * LINE Messaging API adapter: the Channel interface from src/channels/index.js for users
 * addressed as `line:<userId>` (src/channels/address.js).
 *
 * Credentials (both or neither; src/config.js refuses one without the other):
 *   LINE_CHANNEL_SECRET        verifies X-Line-Signature on POST /line/webhook
 *   LINE_CHANNEL_ACCESS_TOKEN  long-lived channel access token; Bearer for every API call
 * Both are read at call time, never cached, never logged.
 *
 * Sending. LINE has two send APIs:
 *   reply  POST /v2/bot/message/reply  free, but needs the replyToken of the inbound event; a
 *          token is single-use and LINE documents it as valid for about a minute
 *   push   POST /v2/bot/message/push   to any user who follows the bot; counts against the
 *          monthly message quota of the plan (small on the free plan)
 * The webhook remembers the newest reply token per address; the first send to that address in
 * the next REPLY_TOKEN_TTL_MS (50s, under LINE's ~1 min) uses it, everything else is pushed. A
 * reply rejected with "Invalid reply token" (used, expired) is retried once as a push. A request
 * carries at most 5 message objects, so longer batches go out as several requests: the first may
 * be a reply, the rest are pushes.
 *
 * Send functions never throw (log, return null), like src/twilio-client.js sendText; the returned
 * id is LINE's x-line-request-id header (one per request, not per message), or a generated
 * `line-<uuid>` when the header is missing. LINE has no delivery receipts and no templates.
 *
 * Inbound (webhookHandler): see the event table above mapEvent().
 */
const crypto = require('node:crypto');
const { lineAddress, channelIdOf, channelOf, maskAddress, normalizeAddress } = require('./address');
const { lineSignatureOk } = require('./line-signature');
const { parseMaxBytes } = require('../media/download');
const { ts } = require('../erp-sync/common');

const API_BASE = 'https://api.line.me/v2/bot';
const DATA_API_BASE = 'https://api-data.line.me/v2/bot';

const SEND_TIMEOUT_MS = 10000;
const DOWNLOAD_TIMEOUT_MS = 20000;
const MAX_TEXT_CHARS = 5000; // per text message object
const MAX_MESSAGES_PER_REQUEST = 5; // reply and push alike
const WEBHOOK_MAX_BYTES = 1024 * 1024;

const REPLY_TOKEN_TTL_MS = 50 * 1000; // use a token only while younger than this
const REPLY_TOKEN_KEEP_MS = 60 * 1000; // evict entries older than this
const REPLY_TOKENS_MAX = 1000;

/** Reply tokens the LINE console's "Verify" button sends; there is no user behind them. */
const VERIFY_REPLY_TOKENS = new Set(['00000000000000000000000000000000', 'ffffffffffffffffffffffffffffffff']);

/**
 * Labels are what the user sees (≤ 20 grapheme clusters each); `text` is what LINE sends back as
 * the user's message. The texts are the words the system prompt (src/conversation.js, steps 4–6)
 * names for "save" and "cancel" — "confirm" / "reject", the same as the Twilio card's buttons
 * (scripts/create-confirmation-template.js). A bare "no" is NOT in the prompt's cancel list and
 * could read as "no, change something". Nothing else parses these; the model does.
 */
const CONFIRMATION_QUICK_REPLY = {
  items: [
    { type: 'action', action: { type: 'message', label: '✅ Confirm', text: 'confirm' } },
    { type: 'action', action: { type: 'message', label: '✏️ Edit', text: 'edit' } },
    { type: 'action', action: { type: 'message', label: '❌ Reject', text: 'reject' } },
  ],
};

// ── injectable for tests ─────────────────────────────────────────────────────────────────────────

let fetchImpl = null; // null → global fetch at call time
let nowImpl = () => Date.now();
let maxBytesOverride = null;

function doFetch(url, init) {
  return (fetchImpl || fetch)(url, init);
}
function now() {
  return nowImpl();
}
function maxBytes() {
  return maxBytesOverride != null ? maxBytesOverride : parseMaxBytes(process.env.MEDIA_MAX_BYTES);
}

// ── config ───────────────────────────────────────────────────────────────────────────────────────

function isSet(v) {
  return v != null && String(v).trim() !== '';
}
function channelSecret() {
  return isSet(process.env.LINE_CHANNEL_SECRET) ? String(process.env.LINE_CHANNEL_SECRET).trim() : null;
}
function accessToken() {
  return isSet(process.env.LINE_CHANNEL_ACCESS_TOKEN) ? String(process.env.LINE_CHANNEL_ACCESS_TOKEN).trim() : null;
}
function isConfigured() {
  return Boolean(channelSecret() && accessToken());
}

// ── reply tokens ─────────────────────────────────────────────────────────────────────────────────

// address → { token, at }. Insertion order is age order (re-inserts delete first), so eviction
// walks from the oldest and stops at the first fresh entry.
const replyTokens = new Map();

function pruneReplyTokens() {
  const t = now();
  for (const [key, entry] of replyTokens) {
    if (t - entry.at <= REPLY_TOKEN_KEEP_MS) break;
    replyTokens.delete(key);
  }
  while (replyTokens.size > REPLY_TOKENS_MAX) replyTokens.delete(replyTokens.keys().next().value);
}

function rememberReplyToken(address, token, at = now()) {
  const key = normalizeAddress(address);
  if (!key || !token) return;
  replyTokens.delete(key);
  replyTokens.set(key, { token: String(token), at });
  pruneReplyTokens();
}

/**
 * Puts back a token a failed reply did not consume, unless a newer one arrived meanwhile (an
 * inbound event during the in-flight request): the newer token is the better one to keep.
 */
function restoreReplyToken(address, token, at) {
  const key = normalizeAddress(address);
  if (!key || replyTokens.has(key)) return;
  rememberReplyToken(address, token, at);
}

/** The held reply token for `address` if younger than REPLY_TOKEN_TTL_MS; removed either way. */
function takeReplyToken(address) {
  const key = normalizeAddress(address);
  const entry = key && replyTokens.get(key);
  if (!entry) return null;
  replyTokens.delete(key);
  return now() - entry.at < REPLY_TOKEN_TTL_MS ? entry.token : null;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────

/** LINE's error `message` field only (never the body, which can echo what we sent), capped. */
function errorSummary(text) {
  try {
    const j = JSON.parse(text);
    if (j && typeof j.message === 'string') return j.message.slice(0, 120);
  } catch { /* not JSON */ }
  return '';
}

async function postJson(path, payload) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await doFetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken()}` },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    const text = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
    const requestId = (res.headers && typeof res.headers.get === 'function' && res.headers.get('x-line-request-id')) || null;
    return { ok: res.ok, status: res.status, requestId, error: res.ok ? '' : errorSummary(text) };
  } catch (err) {
    const timeout = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    return { ok: false, status: 0, requestId: null, error: timeout ? 'timeout' : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

function isInvalidReplyToken(r) {
  return r.status === 400 && /invalid reply token/i.test(r.error);
}

/**
 * Sends `messages` (LINE message objects) to `address`, ≤ 5 per request. The first request uses
 * the held reply token when there is one (push on "Invalid reply token"); later ones push.
 * Stops at the first failed request. Returns { id, status, error } — id null when the first
 * request failed. A reply refused for any reason other than the token puts the token back, so a
 * fallback send (sendConfirmation → sendText) can still reply.
 */
async function deliver(address, messages, type) {
  const masked = maskAddress(address);
  if (!isConfigured()) {
    console.error(`• [line] [${ts()}] cannot send ${type}: LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN not set`);
    return { id: null, status: 0, error: 'not configured' };
  }
  if (channelOf(address) !== 'line') {
    console.error(`• [line] [${ts()}] cannot send ${type}: not a LINE address (${masked})`);
    return { id: null, status: 0, error: 'not a LINE address' };
  }
  const userId = channelIdOf(address);
  if (!userId) {
    console.error(`• [line] [${ts()}] cannot send ${type}: empty LINE user id`);
    return { id: null, status: 0, error: 'not a LINE address' };
  }
  let firstId = null;
  for (let i = 0; i < messages.length; i += MAX_MESSAGES_PER_REQUEST) {
    const batch = messages.slice(i, i + MAX_MESSAGES_PER_REQUEST);
    let via = 'push';
    let r;
    const heldAt = i === 0 ? replyTokens.get(normalizeAddress(address)) : null;
    const token = i === 0 ? takeReplyToken(address) : null;
    if (token) {
      via = 'reply';
      r = await postJson('/message/reply', { replyToken: token, messages: batch });
      if (!r.ok && isInvalidReplyToken(r)) {
        console.warn(`• [line] [${ts()}] reply token rejected for ${masked}, retrying as push`);
        via = 'push';
        r = null;
      } else if (!r.ok && heldAt) {
        restoreReplyToken(address, token, heldAt.at);
      }
    }
    if (!r) r = await postJson('/message/push', { to: userId, messages: batch });
    if (!r.ok) {
      console.error(`• [line] [${ts()}] failed to send ${type} to=${masked} via=${via}: HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`);
      return { id: firstId, status: r.status, error: r.error };
    }
    const id = r.requestId || `line-${crypto.randomUUID()}`;
    console.log(`• [line] [${ts()}] to=${masked} type=${type} via=${via} messages=${batch.length} id=${id}`);
    if (firstId == null) firstId = id;
  }
  return { id: firstId, status: 200, error: '' };
}

/**
 * Splits text into ≤ MAX_TEXT_CHARS pieces (UTF-16 length, which is never under LINE's count),
 * preferring a newline, then a space, in the back half of the window; never splits a surrogate
 * pair (emoji).
 */
function chunkText(text, max = MAX_TEXT_CHARS) {
  const out = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff && cut > 1) cut -= 1;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[\n ]/, '');
  }
  if (rest) out.push(rest);
  return out;
}

function textMessages(text) {
  return chunkText(text).map((t) => ({ type: 'text', text: t }));
}

// ── Channel interface: sending ───────────────────────────────────────────────────────────────────

async function sendText(address, text) {
  if (!text || !String(text).trim()) return null;
  return (await deliver(address, textMessages(text), 'text')).id;
}

/** Text with Yes / Edit / No quick-reply buttons on the last message; sendText if LINE refuses it. */
async function sendConfirmation(address, text) {
  if (!text || !String(text).trim()) return null;
  const messages = textMessages(text);
  messages[messages.length - 1] = { ...messages[messages.length - 1], quickReply: CONFIRMATION_QUICK_REPLY };
  const r = await deliver(address, messages, 'confirmation');
  if (r.id) return r.id;
  if (r.status === 400) {
    console.warn(`• [line] [${ts()}] quick reply refused for ${maskAddress(address)}, sending plain text`);
    return sendText(address, text);
  }
  return null;
}

function isLineImageUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && /\.(jpe?g|png)$/i.test(u.pathname);
}

/**
 * https .jpg/.jpeg/.png URLs become image messages. Anything else (PDFs: the Messaging API cannot
 * send files) is appended to the text as a link. Text goes first.
 *
 * The original doubles as previewImageUrl. LINE allows 10 MB for originalContentUrl but only 1 MB
 * for the preview, and LINE fetches both itself (no error at send time), so an image over 1 MB
 * shows a broken thumbnail until tapped. The only images sent today are PromptPay QR PNGs
 * (src/outreach/send-invoice.js, a few KB); a caller sending photos must supply a small preview.
 */
async function sendMedia(address, text, mediaUrls = []) {
  const urls = (mediaUrls || []).filter(Boolean).map(String);
  const images = urls.filter(isLineImageUrl);
  const links = urls.filter((u) => !isLineImageUrl(u));
  const body = [text && String(text).trim() ? String(text) : '', ...links].filter(Boolean).join('\n');
  const messages = [
    ...(body ? textMessages(body) : []),
    ...images.map((u) => ({ type: 'image', originalContentUrl: u, previewImageUrl: u })),
  ];
  if (!messages.length) {
    console.error(`• [line] [${ts()}] cannot send media: nothing to send`);
    return null;
  }
  return (await deliver(address, messages, 'media')).id;
}

async function sendTemplate() {
  throw new Error('LINE has no message templates; check channel.supportsTemplates');
}

// ── Channel interface: media ─────────────────────────────────────────────────────────────────────

function tooLarge(size) {
  return Object.assign(new Error(`media too large: over ${maxBytes()} bytes (got ${size})`), { code: 'MEDIA_TOO_LARGE' });
}

/** Mirrors readCapped() in src/media/download.js (not exported there). */
async function readCapped(res, abort) {
  const cap = maxBytes();
  const declared = Number(res.headers && res.headers.get && res.headers.get('content-length'));
  if (declared > cap) {
    abort();
    throw tooLarge(declared);
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
      throw tooLarge(total);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/**
 * The type media/index.js should treat the bytes as. Items from file events carry the type
 * derived from the file name (application/pdf or application/octet-stream) and keep it; images
 * and audio take the response header, with audio/x-m4a → audio/mp4 (src/media/transcribe.js maps
 * both to .m4a; audio/mp4 is the registered name).
 */
function resolveContentType(item, header) {
  const declared = String(item.contentType || '').toLowerCase();
  if (declared === 'application/pdf' || declared === 'application/octet-stream') return declared;
  const ct = String(header || '').split(';')[0].trim().toLowerCase();
  if (ct === 'audio/x-m4a') return 'audio/mp4';
  if (ct.startsWith('image/') || ct.startsWith('audio/')) return ct;
  return declared || ct || 'application/octet-stream';
}

/**
 * GET api-data.line.me/v2/bot/message/{id}/content. The host is fixed, so the token only ever
 * goes to LINE; `ref` must look like a LINE message id. Throws on non-200 (202 = still being
 * prepared, video only), timeout, or over MEDIA_MAX_BYTES.
 */
async function downloadMedia(item) {
  const ref = item && item.ref != null ? String(item.ref) : '';
  if (!/^[A-Za-z0-9]{1,64}$/.test(ref)) throw new Error('LINE media: missing or malformed message id');
  const token = accessToken();
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN not set');
  const controller = new AbortController();
  const res = await doFetch(`${DATA_API_BASE}/message/${encodeURIComponent(ref)}/content`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
  });
  if (res.status !== 200) {
    try { await res.body?.cancel(); } catch { /* nothing to drain */ }
    throw new Error(`LINE media download failed: HTTP ${res.status}`);
  }
  const bytes = await readCapped(res, () => controller.abort());
  const contentType = resolveContentType(item, res.headers && res.headers.get && res.headers.get('content-type'));
  console.log(`• [line] [${ts()}] downloaded ${bytes.length} bytes (${contentType})`);
  return { bytes, contentType };
}

// ── Channel interface: inbound ───────────────────────────────────────────────────────────────────

/**
 * A file message's type from its name: the ones media/index.js can scan (a receipt sent "as a
 * file" keeps its extension), else application/octet-stream, which media/index.js answers with
 * its "unsupported" reply without downloading.
 */
function fileContentType(fileName) {
  const ext = (/\.([a-z0-9]+)$/i.exec(String(fileName || '')) || [])[1];
  const types = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
  return types[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

function skip(ev, what, who) {
  console.log(`• [line] [${ts()}] skipping ${what}${who ? ` from=${maskAddress(who)}` : ''}`);
  return null;
}

/**
 * LINE webhook event → normalised inbound (src/channels/index.js), or null to skip:
 *
 *   message/text                 body = text
 *   message/image                media [{ contentType: 'image/jpeg', ref: message.id }], body ''
 *   message/audio                media [{ contentType: 'audio/mp4', ref }], body ''
 *   message/file                 media [{ contentType: by extension — application/pdf,
 *                                image/jpeg, image/png — else application/octet-stream, ref }]
 *   message/video                media [{ contentType: 'video/mp4', ref }]: never downloaded;
 *                                media/index.js answers "can't read that kind of file", as it
 *                                does for a WhatsApp video
 *   image/audio/video with contentProvider.type 'external' stay as above: Get content can't
 *                                fetch them, so the download fails and media/index.js answers
 *                                with its scan/voice-failed reply (rare: not sent from a LINE app)
 *   message/sticker              skipped (nothing to book; same outcome as WhatsApp stickers)
 *   message/location, …          skipped, logged
 *   follow, new friend           body 'hi', so onboarding greets a new user like a first message
 *   follow, unblock              skipped, logged (follow.isUnblocked): the user already talked
 *                                to the bot, and a 'hi' mid-signup would be taken as the answer
 *                                to the current onboarding step (e.g. the business name)
 *   unfollow (block)             logged only (can't message a user who blocked the bot)
 *   postback                     body = postback.data
 *   anything else                skipped, logged (join/leave/memberJoined/unsend/beacon/…)
 *
 * Only 1:1 chats: group/room sources (or no userId) are skipped. Standby-mode events (another
 * module channel owns the chat) are skipped. Redeliveries (deliveryContext.isRedelivery) are
 * processed and logged; de-duplication is the per-sender queue's concern. LINE messages have no
 * captions, so a photo's body is always ''.
 */
function mapEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const source = ev.source || {};
  if (source.type !== 'user' || !source.userId) return skip(ev, `${ev.type} event from a ${source.type || 'unknown'} source`);
  const from = lineAddress(source.userId);
  if (ev.mode === 'standby') return skip(ev, `${ev.type} event in standby mode`, from);
  if (ev.deliveryContext && ev.deliveryContext.isRedelivery) {
    console.log(`• [line] [${ts()}] redelivered ${ev.type} event from=${maskAddress(from)} id=${ev.webhookEventId || '?'}`);
  }
  const inbound = (body, media = []) => ({ channel: 'line', from, body, media, contacts: [], raw: ev });

  switch (ev.type) {
    case 'message': {
      const m = ev.message || {};
      switch (m.type) {
        case 'text': return inbound(String(m.text || ''));
        case 'image': return inbound('', [{ contentType: 'image/jpeg', ref: m.id }]);
        case 'audio': return inbound('', [{ contentType: 'audio/mp4', ref: m.id }]);
        case 'file': return inbound('', [{ contentType: fileContentType(m.fileName), ref: m.id }]);
        case 'video': return inbound('', [{ contentType: 'video/mp4', ref: m.id }]);
        default: return skip(ev, `${m.type || 'unknown'} message`, from);
      }
    }
    case 'follow':
      if (ev.follow && ev.follow.isUnblocked) return skip(ev, 'follow (user unblocked the bot)', from);
      return inbound('hi');
    case 'postback': return inbound(String((ev.postback && ev.postback.data) || ''));
    case 'unfollow': return skip(ev, 'unfollow (user blocked the bot)', from);
    default: return skip(ev, `${ev.type || 'unknown'} event`, from);
  }
}

function isVerifyPing(ev) {
  return Boolean(ev && VERIFY_REPLY_TOKENS.has(ev.replyToken));
}

/**
 * Maps and dispatches every event. processMessage is called in event order without waiting for
 * the previous one (the per-sender queue serialises a user's messages); one failure doesn't stop
 * the rest. Resolves when all settle.
 */
function processEvents(payload, processMessage) {
  const events = payload && Array.isArray(payload.events) ? payload.events : [];
  const pending = [];
  for (const ev of events) {
    if (isVerifyPing(ev)) {
      console.log(`• [line] [${ts()}] webhook verify ping, skipped`);
      continue;
    }
    let inbound;
    try {
      inbound = mapEvent(ev);
      if (inbound && ev.replyToken) rememberReplyToken(inbound.from, ev.replyToken);
    } catch (err) {
      // A malformed event must not escape after the 200 (unhandled rejection) or stop the rest.
      console.error(`• [line] [${ts()}] could not map ${(ev && ev.type) || 'unknown'} event: ${err.message}`);
      continue;
    }
    if (!inbound) continue;
    pending.push(Promise.resolve()
      .then(() => processMessage(inbound))
      .catch((err) => console.error(`[line webhook async] processing error from=${maskAddress(inbound.from)}:`, err)));
  }
  return Promise.all(pending);
}

class BodyTooLargeError extends Error {
  constructor() {
    super(`webhook body over ${WEBHOOK_MAX_BYTES} bytes`);
    this.code = 'BODY_TOO_LARGE';
  }
}

/**
 * The raw request body as a Buffer: req.rawBody (Buffer/string) if a verify hook stored it,
 * req.body if express.raw() parsed it, otherwise read from the stream, capped at 1 MB.
 * Throws BodyTooLargeError, or a plain Error when a JSON parser already consumed the stream.
 */
function readRawBody(req) {
  const ready = Buffer.isBuffer(req.rawBody) ? req.rawBody
    : typeof req.rawBody === 'string' ? Buffer.from(req.rawBody, 'utf8')
      : Buffer.isBuffer(req.body) ? req.body : null;
  if (ready) {
    if (ready.length > WEBHOOK_MAX_BYTES) return Promise.reject(new BodyTooLargeError());
    return Promise.resolve(ready);
  }
  const declared = Number(req.headers && req.headers['content-length']);
  if (declared > WEBHOOK_MAX_BYTES) {
    req.resume?.();
    return Promise.reject(new BodyTooLargeError());
  }
  if (req.readableEnded || req._body) return Promise.reject(new Error('request body already consumed by another parser'));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('close', onClose);
      fn(arg);
    };
    const onData = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > WEBHOOK_MAX_BYTES) {
        req.resume?.(); // drain and discard the rest
        finish(reject, new BodyTooLargeError());
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => finish(resolve, Buffer.concat(chunks, total));
    const onError = (err) => finish(reject, err);
    // Client gone before 'end' (no 'error' on some paths): settle instead of hanging.
    const onClose = () => finish(reject, new Error('request closed before the body ended'));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

/**
 * Express handler for POST /line/webhook. Works with no body parser on the route (reads the
 * stream itself; server.js's global express.urlencoded() leaves JSON bodies unread), with
 * req.rawBody set by a verify hook, or behind express.raw({ type: 'application/json' }) (req.body
 * is then the Buffer) — see webhookRoute() for the last one ready-made. A route-level
 * express.json() would break the signature check (the parsed object is not the signed bytes).
 *
 *   413 body over 1 MB · 403 missing/invalid X-Line-Signature (or LINE_CHANNEL_SECRET unset)
 *   400 body unreadable or not JSON · 200 otherwise, sent BEFORE any event is processed
 *
 * Options (injectable for tests): processMessage(inbound) — required; channelSecret — defaults
 * to LINE_CHANNEL_SECRET read per request. The returned promise (tests await it) resolves once
 * every event has been handled.
 */
function webhookHandler({ processMessage, channelSecret: secretOverride } = {}) {
  if (typeof processMessage !== 'function') throw new Error('[line] webhookHandler needs processMessage');
  return async (req, res) => {
    let raw;
    try {
      raw = await readRawBody(req);
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        console.error(`• [line] [${ts()}] rejected webhook: body over ${WEBHOOK_MAX_BYTES} bytes`);
        return res.status(413).send('payload too large');
      }
      console.error(`• [line] [${ts()}] rejected webhook: ${err.message}`);
      return res.status(400).send('unreadable body');
    }
    const secret = secretOverride !== undefined ? secretOverride : channelSecret();
    const signature = req.headers && req.headers['x-line-signature'];
    if (!lineSignatureOk(raw, signature, secret)) {
      const why = !secret ? 'LINE_CHANNEL_SECRET unset' : signature ? 'invalid X-Line-Signature' : 'missing X-Line-Signature';
      console.error(`• [line] [${ts()}] rejected webhook: ${why} (${raw.length} bytes)`);
      return res.status(403).send('invalid signature');
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      console.error(`• [line] [${ts()}] rejected webhook: signed body is not JSON (${raw.length} bytes)`);
      return res.status(400).send('invalid json');
    }

    // Ack first: LINE times out (and may redeliver) if the response is slow.
    res.status(200).send('ok');

    return processEvents(payload, processMessage).catch((err) => {
      console.error('[line webhook async] processing error:', err);
    });
  };
}

/**
 * [express.raw({ type: 'application/json', limit: '1mb' }), webhookHandler(opts)], for
 * `app.post(line.webhookPath, ...line.webhookRoute({ processMessage }))` when the route should
 * parse the body with Express. express.raw answers an oversized body with 413 itself.
 */
function webhookRoute(opts) {
  const express = require('express');
  return [express.raw({ type: 'application/json', limit: WEBHOOK_MAX_BYTES }), webhookHandler(opts)];
}

// ── tests only ───────────────────────────────────────────────────────────────────────────────────

/** Replace fetch (sends and downloads); null restores global fetch. */
function _setFetchForTests(fn) {
  fetchImpl = fn || null;
}
function _setNowForTests(fn) {
  nowImpl = fn || (() => Date.now());
}
function _setMaxBytesForTests(n) {
  maxBytesOverride = n == null ? null : n;
}
function _resetForTests() {
  replyTokens.clear();
  fetchImpl = null;
  nowImpl = () => Date.now();
  maxBytesOverride = null;
}

// Exported before index.js is required: when this file is loaded first, index.js's adapter loop
// requires it back and must get the finished object, not {}.
module.exports = {
  name: 'line',
  supportsTemplates: false,
  webhookPath: '/line/webhook',
  isConfigured,
  sendText,
  sendConfirmation,
  sendMedia,
  sendTemplate,
  downloadMedia,
  webhookHandler,
  webhookRoute,
  // LINE-specific helpers
  takeReplyToken,
  rememberReplyToken,
  mapEvent,
  chunkText,
  readRawBody,
  CONFIRMATION_QUICK_REPLY,
  WEBHOOK_MAX_BYTES,
  MAX_TEXT_CHARS,
  REPLY_TOKEN_TTL_MS,
  _setFetchForTests,
  _setNowForTests,
  _setMaxBytesForTests,
  _resetForTests,
};

// index.js assigns its module.exports before requiring the adapters, so this works whichever
// file loads first (test/line.test.js covers both orders).
require('./index').register(module.exports);
