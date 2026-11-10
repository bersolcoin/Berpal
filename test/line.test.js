/**
 * LINE Messaging API adapter (src/channels/line.js): webhook signature/size/ack, event mapping,
 * reply-token vs push, text chunking, the quick-reply payload, media sends and downloads, plus
 * the LINE blocks in src/config.js and src/health.js. fetch is injected; HMACs are real.
 *
 *   npm test
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const line = require('../src/channels/line');
const { lineSignature } = require('../src/channels/line-signature');
const { validateEnv } = require('../src/config');
const { createHealthHandler } = require('../src/health');

const SECRET = 'test-channel-secret';
const TOKEN = 'tok-SECRET-line-access';
const USER = 'U4af4980629abcdef0123456789abcd';
const ADDR = `line:${USER}`;

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/** Captures console output; returns the joined text. */
function captureConsole() {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  const grab = (...args) => lines.push(args.map(String).join(' '));
  console.log = console.warn = console.error = grab;
  return {
    text: () => lines.join('\n'),
    restore: () => Object.assign(console, saved),
  };
}

let out;
beforeEach(() => {
  line._resetForTests();
  process.env.LINE_CHANNEL_SECRET = SECRET;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = TOKEN;
  out = captureConsole();
});
afterEach(() => {
  out.restore();
  line._resetForTests();
  delete process.env.LINE_CHANNEL_SECRET;
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
});

/** fetch stub. `respond(url, init, n)` returns a Response (or { status, json, headers }). */
function fakeFetch(respond = () => ({ status: 200 })) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const r = await respond(url, init, calls.length);
    if (r instanceof Response) return r;
    const headers = { 'x-line-request-id': `req-${calls.length}`, ...(r.headers || {}) };
    return new Response(r.json ? JSON.stringify(r.json) : '{}', { status: r.status || 200, headers });
  };
  line._setFetchForTests(impl);
  return calls;
}

function fakeReq(body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const req = Readable.from([buf]);
  req.headers = { 'content-type': 'application/json', ...headers };
  return { req, buf };
}

function signedReq(payload, extraHeaders = {}) {
  const { req, buf } = fakeReq(payload);
  req.headers['x-line-signature'] = lineSignature(buf, SECRET);
  Object.assign(req.headers, extraHeaders);
  return req;
}

function fakeRes() {
  return {
    code: null,
    body: undefined,
    status(c) { this.code = c; return this; },
    send(b) { this.body = b; if (this.code == null) this.code = 200; return this; },
  };
}

/** Runs the webhook; returns { res, inbound[] } after async processing settles. */
async function hook(req, opts = {}) {
  const inbound = [];
  const handler = line.webhookHandler({ processMessage: async (m) => { inbound.push(m); }, ...opts });
  const res = fakeRes();
  await handler(req, res);
  return { res, inbound };
}

const userSource = { type: 'user', userId: USER };
// A fresh webhookEventId per event: a repeated id is a duplicate (dropped), so tests that want
// one pass it explicitly.
let eventSeq = 0;
const ev = (extra) => ({
  type: 'message',
  mode: 'active',
  timestamp: 1700000000000,
  source: userSource,
  webhookEventId: `01HXYZ${++eventSeq}`,
  deliveryContext: { isRedelivery: false },
  replyToken: 'rtok-1',
  ...extra,
});

// ── module loading ───────────────────────────────────────────────────────────────────────────────

test('registers with src/channels whichever file is required first', () => {
  const root = path.join(__dirname, '..');
  const indexFirst = "const c=require('./src/channels'); const l=c.get('line'); if(!l||l.name!=='line'||c.forAddress('line:Uabc')!==l) process.exit(1); console.log('ok')";
  const lineFirst = "const l=require('./src/channels/line'); const c=require('./src/channels'); if(c.get('line')!==l) process.exit(1); console.log('ok')";
  for (const code of [indexFirst, lineFirst]) {
    const r = execFileSync(process.execPath, ['-e', code], { cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.match(r, /ok\s*$/);
  }
});

test('adapter shape', () => {
  assert.equal(line.name, 'line');
  assert.equal(line.supportsTemplates, false);
  assert.equal(line.webhookPath, '/line/webhook');
  for (const fn of ['sendText', 'sendConfirmation', 'sendMedia', 'sendTemplate', 'downloadMedia', 'webhookHandler', 'isConfigured']) {
    assert.equal(typeof line[fn], 'function', fn);
  }
});

test('isConfigured: both → true, one or none → false (read at call time)', () => {
  assert.equal(line.isConfigured(), true);
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  assert.equal(line.isConfigured(), false);
  process.env.LINE_CHANNEL_ACCESS_TOKEN = TOKEN;
  process.env.LINE_CHANNEL_SECRET = '  ';
  assert.equal(line.isConfigured(), false);
  delete process.env.LINE_CHANNEL_SECRET;
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  assert.equal(line.isConfigured(), false);
});

// ── webhook: signature, size, ack ────────────────────────────────────────────────────────────────

test('webhook: valid signature → 200 and the event is processed', async () => {
  const { res, inbound } = await hook(signedReq({ destination: 'Ubot', events: [ev({ message: { type: 'text', id: '1', text: 'paid 850 for lunch' } })] }));
  assert.equal(res.code, 200);
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].body, 'paid 850 for lunch');
});

test('webhook: invalid signature → 403, nothing processed, body not logged', async () => {
  const { req } = fakeReq({ events: [ev({ message: { type: 'text', id: '1', text: 'very secret text' } })] });
  req.headers['x-line-signature'] = lineSignature(Buffer.from('something else'), SECRET);
  const { res, inbound } = await hook(req);
  assert.equal(res.code, 403);
  assert.equal(inbound.length, 0);
  assert.match(out.text(), /invalid X-Line-Signature/);
  assert.doesNotMatch(out.text(), /very secret text/);
});

test('webhook: missing signature → 403', async () => {
  const { req } = fakeReq({ events: [] });
  const { res } = await hook(req);
  assert.equal(res.code, 403);
  assert.match(out.text(), /missing X-Line-Signature/);
});

test('webhook: LINE_CHANNEL_SECRET unset → 403 even with a signature', async () => {
  const req = signedReq({ events: [] });
  delete process.env.LINE_CHANNEL_SECRET;
  const { res } = await hook(req);
  assert.equal(res.code, 403);
});

test('webhook: signature over the raw bytes, not re-serialised JSON', async () => {
  const raw = '{ "events" : [ ] ,"destination":"Ubot"}';
  const { req } = fakeReq(raw);
  req.headers['x-line-signature'] = lineSignature(Buffer.from(raw), SECRET);
  const { res } = await hook(req);
  assert.equal(res.code, 200);
});

test('webhook: accepts req.rawBody and an express.raw Buffer body', async () => {
  // One event per request: the same event twice would be a duplicate and dropped.
  const signed = () => {
    const buf = Buffer.from(JSON.stringify({ events: [ev({ message: { type: 'text', id: '1', text: 'a' } })] }));
    return { buf, sig: lineSignature(buf, SECRET) };
  };
  const raw = signed();
  const body = signed();
  const viaRaw = { rawBody: raw.buf, headers: { 'x-line-signature': raw.sig } };
  const viaBody = { body: body.buf, headers: { 'x-line-signature': body.sig } };
  for (const req of [viaRaw, viaBody]) {
    const { res, inbound } = await hook(req);
    assert.equal(res.code, 200);
    assert.equal(inbound.length, 1);
  }
  const route = line.webhookRoute({ processMessage: () => {} });
  assert.equal(route.length, 2);
});

test('webhook: body over 1 MB → 413 (streamed and declared)', async () => {
  const big = Buffer.alloc(line.WEBHOOK_MAX_BYTES + 10, 0x20);
  const streamed = Readable.from([big.subarray(0, 600000), big.subarray(600000)]);
  streamed.headers = { 'x-line-signature': lineSignature(big, SECRET) };
  assert.equal((await hook(streamed)).res.code, 413);

  const declared = Readable.from([Buffer.from('{}')]);
  declared.headers = { 'content-length': String(line.WEBHOOK_MAX_BYTES + 1), 'x-line-signature': 'x' };
  assert.equal((await hook(declared)).res.code, 413);

  assert.equal((await hook({ rawBody: big, headers: {} })).res.code, 413);
});

test('webhook: client gone before the body ended → 400, no hang', async () => {
  const { PassThrough } = require('node:stream');
  const req = new PassThrough();
  req.headers = { 'content-type': 'application/json', 'x-line-signature': 'x' };
  req.write('{"events":');
  setImmediate(() => req.destroy());
  const { res, inbound } = await hook(req);
  assert.equal(res.code, 400);
  assert.equal(inbound.length, 0);
});

test('webhook: signed but not JSON → 400', async () => {
  const { req, buf } = fakeReq('not json');
  req.headers['x-line-signature'] = lineSignature(buf, SECRET);
  assert.equal((await hook(req)).res.code, 400);
});

test('webhook: acks 200 before processing finishes', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const res = fakeRes();
  const handler = line.webhookHandler({ processMessage: () => gate });
  const done = handler(signedReq({ events: [ev({ message: { type: 'text', id: '1', text: 'x' } })] }), res);
  await new Promise((r) => setImmediate(r));
  assert.equal(res.code, 200);
  release();
  await done;
});

test('webhook: a processMessage failure is caught and logged', async () => {
  const res = fakeRes();
  const handler = line.webhookHandler({ processMessage: async () => { throw new Error('boom'); } });
  await handler(signedReq({ events: [ev({ message: { type: 'text', id: '1', text: 'x' } })] }), res);
  assert.equal(res.code, 200);
  assert.match(out.text(), /processing error/);
});

test('webhook: verify pings (all-0 / all-f reply tokens, empty events) → 200, skipped', async () => {
  const pings = [
    ev({ replyToken: '00000000000000000000000000000000', message: { type: 'text', id: '1', text: 'Hello, world' } }),
    ev({ replyToken: 'ffffffffffffffffffffffffffffffff', message: { type: 'sticker', id: '2', packageId: '1', stickerId: '1' } }),
  ];
  const { res, inbound } = await hook(signedReq({ destination: 'Ubot', events: pings }));
  assert.equal(res.code, 200);
  assert.equal(inbound.length, 0);
  assert.equal(line.takeReplyToken(ADDR), null);

  const empty = await hook(signedReq({ destination: 'Ubot', events: [] }));
  assert.equal(empty.res.code, 200);
  assert.equal(empty.inbound.length, 0);
});

// ── event mapping ────────────────────────────────────────────────────────────────────────────────

const base = (e) => ({ channel: 'line', from: ADDR, contacts: [], raw: e });

test('mapping: text', () => {
  const e = ev({ message: { type: 'text', id: '10', text: 'ขายพลอย 45000' } });
  assert.deepEqual(line.mapEvent(e), { ...base(e), body: 'ขายพลอย 45000', media: [] });
});

test('mapping: image, audio, pdf file, other file', () => {
  const img = ev({ message: { type: 'image', id: '11', contentProvider: { type: 'line' } } });
  assert.deepEqual(line.mapEvent(img), { ...base(img), body: '', media: [{ contentType: 'image/jpeg', ref: '11' }] });
  const aud = ev({ message: { type: 'audio', id: '12', duration: 4000 } });
  assert.deepEqual(line.mapEvent(aud), { ...base(aud), body: '', media: [{ contentType: 'audio/mp4', ref: '12' }] });
  const pdf = ev({ message: { type: 'file', id: '13', fileName: 'Bill-Acme.PDF', fileSize: 1000 } });
  assert.deepEqual(line.mapEvent(pdf), { ...base(pdf), body: '', media: [{ contentType: 'application/pdf', ref: '13' }] });
  const zip = ev({ message: { type: 'file', id: '14', fileName: 'stuff.zip', fileSize: 1000 } });
  assert.deepEqual(line.mapEvent(zip).media, [{ contentType: 'application/octet-stream', ref: '14' }]);
  const jpg = ev({ message: { type: 'file', id: '15', fileName: 'receipt.JPEG', fileSize: 1000 } });
  assert.deepEqual(line.mapEvent(jpg).media, [{ contentType: 'image/jpeg', ref: '15' }]);
  const noext = ev({ message: { type: 'file', id: '16', fileName: 'pdf', fileSize: 1000 } });
  assert.deepEqual(line.mapEvent(noext).media, [{ contentType: 'application/octet-stream', ref: '16' }]);
});

test('mapping: video → a video/mp4 item (media/index.js answers "unsupported", no download)', () => {
  const v = ev({ message: { type: 'video', id: '17', duration: 3000, contentProvider: { type: 'line' } } });
  assert.deepEqual(line.mapEvent(v).media, [{ contentType: 'video/mp4', ref: '17' }]);
  assert.equal(require('../src/media/index').kindOf('video/mp4'), 'unsupported');
});

test('mapping: sticker, location → skipped with a log line', () => {
  for (const type of ['sticker', 'location']) {
    assert.equal(line.mapEvent(ev({ message: { type, id: '20' } })), null, type);
    assert.match(out.text(), new RegExp(`skipping ${type} message`));
  }
});

test('mapping: follow → "hi", postback → data, unfollow → skipped', () => {
  const f = ev({ type: 'follow', message: undefined, follow: { isUnblocked: false } });
  assert.equal(line.mapEvent(f).body, 'hi');
  // Unblock: no 'hi' (mid-signup it would be taken as the current step's answer).
  const u = ev({ type: 'follow', message: undefined, follow: { isUnblocked: true } });
  assert.equal(line.mapEvent(u), null);
  assert.match(out.text(), /unblocked/);
  const p = ev({ type: 'postback', message: undefined, postback: { data: 'action=confirm' } });
  assert.equal(line.mapEvent(p).body, 'action=confirm');
  assert.equal(line.mapEvent(ev({ type: 'unfollow', replyToken: undefined, message: undefined })), null);
  assert.match(out.text(), /unfollow/);
});

test('mapping: group/room sources and missing userId are ignored', () => {
  const msg = { type: 'text', id: '1', text: 'hi all' };
  assert.equal(line.mapEvent(ev({ source: { type: 'group', groupId: 'C1', userId: USER }, message: msg })), null);
  assert.equal(line.mapEvent(ev({ source: { type: 'room', roomId: 'R1' }, message: msg })), null);
  assert.equal(line.mapEvent(ev({ source: { type: 'user' }, message: msg })), null);
  assert.match(out.text(), /group source/);
  assert.doesNotMatch(out.text(), /hi all/);
});

test('mapping: a first-time redelivery is processed and logged', async () => {
  const e = ev({ deliveryContext: { isRedelivery: true }, message: { type: 'text', id: '1', text: 'again' } });
  const { inbound } = await hook(signedReq({ events: [e] }));
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].body, 'again');
  assert.match(out.text(), /redelivered message event/);
});

// ── duplicate events ─────────────────────────────────────────────────────────────────────────────

test('dedupe: the same webhookEventId is processed once, flagged as redelivery or not', async () => {
  const first = ev({ webhookEventId: 'EV-1', message: { type: 'text', id: '1', text: 'once' } });
  const again = ev({ webhookEventId: 'EV-1', deliveryContext: { isRedelivery: true }, replyToken: 'rtok-2', message: { type: 'text', id: '1', text: 'once' } });
  const unflagged = ev({ webhookEventId: 'EV-1', replyToken: 'rtok-3', message: { type: 'text', id: '1', text: 'once' } });
  const { inbound: a } = await hook(signedReq({ events: [first] }));
  const { inbound: b } = await hook(signedReq({ events: [again, unflagged] }));
  assert.equal(a.length, 1);
  assert.equal(b.length, 0);
  assert.match(out.text(), /duplicate message event from=line:…abcd id=EV-1, skipped/);
  assert.doesNotMatch(out.text(), new RegExp(USER), 'address is masked');
  // A dropped duplicate still hands over its reply token: the latest one is the live one.
  assert.equal(line.takeReplyToken(ADDR), 'rtok-3');
});

test('dedupe: different ids are all processed; events without an id always are', async () => {
  const events = [
    ev({ webhookEventId: 'EV-A', message: { type: 'text', id: '1', text: 'a' } }),
    ev({ webhookEventId: 'EV-B', message: { type: 'text', id: '2', text: 'b' } }),
  ];
  const { inbound } = await hook(signedReq({ events }));
  assert.deepEqual(inbound.map((m) => m.body), ['a', 'b']);
  const noId = ev({ message: { type: 'text', id: '3', text: 'c' } });
  delete noId.webhookEventId;
  const { inbound: twice } = await hook(signedReq({ events: [noId, noId] }));
  assert.deepEqual(twice.map((m) => m.body), ['c', 'c']);
});

test('dedupe: ids are evicted over the cap and after SEEN_EVENT_KEEP_MS', async () => {
  let t = 1_700_000_000_000;
  line._setNowForTests(() => t);
  const batch = (start, n) => Array.from({ length: n }, (_, i) => ev({ webhookEventId: `EV-${start + i}`, message: { type: 'text', id: '1', text: 'x' } }));
  await hook(signedReq({ events: [batch(0, 1)[0]] }));
  // Fill the map past the cap in chunks the 1 MB body limit allows: EV-0 is the oldest, so it goes.
  for (let i = 1; i < line.SEEN_EVENTS_MAX + 1; i += 500) {
    await hook(signedReq({ events: batch(i, Math.min(500, line.SEEN_EVENTS_MAX + 1 - i)) }));
  }
  const { inbound: evicted } = await hook(signedReq({ events: [batch(0, 1)[0]] }));
  assert.equal(evicted.length, 1, 'EV-0 fell out of the cap and is processed again');
  const { inbound: kept } = await hook(signedReq({ events: [batch(line.SEEN_EVENTS_MAX, 1)[0]] }));
  assert.equal(kept.length, 0, 'the newest id is still remembered');
  // Age: the whole map is older than the keep window.
  t += line.SEEN_EVENT_KEEP_MS + 1;
  const { inbound: aged } = await hook(signedReq({ events: [batch(line.SEEN_EVENTS_MAX, 1)[0]] }));
  assert.equal(aged.length, 1);
  // _resetForTests forgets everything.
  line._resetForTests();
  const { inbound: reset } = await hook(signedReq({ events: [batch(line.SEEN_EVENTS_MAX, 1)[0]] }));
  assert.equal(reset.length, 1);
});

// ── reply token vs push ──────────────────────────────────────────────────────────────────────────

test('reply token: used once for the first send, then push', async () => {
  const calls = fakeFetch();
  await hook(signedReq({ events: [ev({ replyToken: 'rtok-A', message: { type: 'text', id: '1', text: 'x' } })] }));
  const id1 = await line.sendText(ADDR, 'first');
  const id2 = await line.sendText(ADDR, 'second');
  assert.equal(id1, 'req-1');
  assert.equal(id2, 'req-2');
  assert.equal(calls[0].url, 'https://api.line.me/v2/bot/message/reply');
  assert.deepEqual(calls[0].body, { replyToken: 'rtok-A', messages: [{ type: 'text', text: 'first' }] });
  assert.equal(calls[1].url, 'https://api.line.me/v2/bot/message/push');
  assert.deepEqual(calls[1].body, { to: USER, messages: [{ type: 'text', text: 'second' }] });
  for (const c of calls) {
    assert.equal(c.init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(c.init.signal, 'has an abort signal');
  }
  assert.match(out.text(), /• \[line\] \[\d\d:\d\d:\d\d\] to=line:…abcd type=text via=reply messages=1 id=req-1/);
  assert.doesNotMatch(out.text(), new RegExp(TOKEN));
  assert.doesNotMatch(out.text(), new RegExp(USER));
});

test('reply token: older than 50s → push', async () => {
  let t = 1_000_000;
  line._setNowForTests(() => t);
  const calls = fakeFetch();
  line.rememberReplyToken(ADDR, 'rtok-old');
  t += line.REPLY_TOKEN_TTL_MS;
  await line.sendText(ADDR, 'late');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.line.me/v2/bot/message/push');
});

test('reply token: 400 "Invalid reply token" → retried once as push', async () => {
  const calls = fakeFetch((url) => (url.endsWith('/reply') ? { status: 400, json: { message: 'Invalid reply token' } } : { status: 200 }));
  line.rememberReplyToken(ADDR, 'rtok-used');
  const id = await line.sendText(ADDR, 'hello');
  assert.equal(id, 'req-2');
  assert.deepEqual(calls.map((c) => c.url.split('/').pop()), ['reply', 'push']);
  assert.deepEqual(calls[1].body.messages, [{ type: 'text', text: 'hello' }]);
});

test('reply token: a failed reply puts the token back, but never over a newer one', async () => {
  // 500 on the reply: the token was not consumed, so it is kept for the next send.
  fakeFetch(() => ({ status: 500, json: { message: 'oops' } }));
  line.rememberReplyToken(ADDR, 'rtok-A');
  assert.equal(await line.sendText(ADDR, 'x'), null);
  assert.equal(line.takeReplyToken(ADDR), 'rtok-A');

  // A newer event arrives while the reply is in flight: its token wins.
  fakeFetch(async () => {
    line.rememberReplyToken(ADDR, 'rtok-B');
    return { status: 500, json: { message: 'oops' } };
  });
  line.rememberReplyToken(ADDR, 'rtok-A');
  await line.sendText(ADDR, 'x');
  assert.equal(line.takeReplyToken(ADDR), 'rtok-B');
});

test('reply token: concurrent sends never use the same token twice', async () => {
  const calls = fakeFetch();
  line.rememberReplyToken(ADDR, 'rtok-C');
  await Promise.all([line.sendText(ADDR, 'one'), line.sendText(ADDR, 'two')]);
  assert.deepEqual(calls.map((c) => c.url.split('/').pop()).sort(), ['push', 'reply']);
});

test('reply token map is bounded', () => {
  let t = 0;
  line._setNowForTests(() => t);
  line.rememberReplyToken('line:Uold', 'x');
  t = 61_000;
  line.rememberReplyToken('line:Unew', 'y');
  assert.equal(line.takeReplyToken('line:Uold'), null, 'evicted after 60s');
  for (let i = 0; i < 1100; i++) line.rememberReplyToken(`line:U${i}`, `t${i}`);
  assert.equal(line.takeReplyToken('line:U0'), null, 'oldest evicted over 1000 entries');
  assert.equal(line.takeReplyToken('line:U1099'), 't1099');
});

test('sendText: failure → null, never throws; unconfigured → null without a request', async () => {
  fakeFetch(() => ({ status: 429, json: { message: 'You have reached your monthly limit.' } }));
  assert.equal(await line.sendText(ADDR, 'x'), null);
  assert.match(out.text(), /HTTP 429 You have reached your monthly limit/);

  line._setFetchForTests(async () => { throw new Error('ECONNRESET'); });
  assert.equal(await line.sendText(ADDR, 'x'), null);

  const calls = fakeFetch();
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  assert.equal(await line.sendText(ADDR, 'x'), null);
  assert.equal(await line.sendText('+66812345678', 'x'), null);
  assert.equal(calls.length, 0);
});

test('sendText: generates an id when x-line-request-id is missing', async () => {
  line._setFetchForTests(async () => new Response('{}', { status: 200 }));
  assert.match(await line.sendText(ADDR, 'x'), /^line-[0-9a-f-]{36}$/);
});

// ── chunking, confirmation, media, templates ─────────────────────────────────────────────────────

test('sendText: chunks at 5000 chars, ≤ 5 messages per request', async () => {
  const calls = fakeFetch();
  const text = 'a'.repeat(5000) + 'b'.repeat(5000) + 'c';
  await line.sendText(ADDR, text);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.messages.map((m) => m.text.length), [5000, 5000, 1]);
  assert.equal(calls[0].body.messages.map((m) => m.text).join(''), text);

  const calls2 = fakeFetch();
  await line.sendText(ADDR, 'x'.repeat(5000 * 6 + 1));
  assert.deepEqual(calls2.map((c) => c.body.messages.length), [5, 2]);
  for (const c of calls2) for (const m of c.body.messages) assert.ok(m.text.length <= 5000);
});

test('chunkText prefers line breaks and never splits a surrogate pair', () => {
  const para = 'x'.repeat(4000) + '\n' + 'y'.repeat(2000);
  assert.deepEqual(line.chunkText(para).map((s) => s.length), [4000, 2000]);
  const emoji = 'a'.repeat(4999) + '😀' + 'b';
  const parts = line.chunkText(emoji);
  assert.deepEqual(parts, ['a'.repeat(4999), '😀b']);
});

test('sendConfirmation: quickReply payload shape', async () => {
  const calls = fakeFetch();
  await line.sendConfirmation(ADDR, 'Expense 850 THB\nLunch\nConfirm?');
  assert.deepEqual(calls[0].body, {
    to: USER,
    messages: [{
      type: 'text',
      text: 'Expense 850 THB\nLunch\nConfirm?',
      quickReply: {
        items: [
          { type: 'action', action: { type: 'message', label: '✅ Confirm', text: 'confirm' } },
          { type: 'action', action: { type: 'message', label: '✏️ Edit', text: 'edit' } },
          { type: 'action', action: { type: 'message', label: '❌ Reject', text: 'reject' } },
        ],
      },
    }],
  });
  assert.match(out.text(), /type=confirmation/);
});

test('sendConfirmation: quickReply rejected → plain text, reusing the reply token', async () => {
  const calls = fakeFetch((url, init) => (JSON.parse(init.body).messages[0].quickReply
    ? { status: 400, json: { message: 'The request body has 1 error(s)' } }
    : { status: 200 }));
  line.rememberReplyToken(ADDR, 'rtok-Q');
  const id = await line.sendConfirmation(ADDR, 'card');
  assert.equal(id, 'req-2');
  assert.equal(calls[1].url, 'https://api.line.me/v2/bot/message/reply');
  assert.deepEqual(calls[1].body, { replyToken: 'rtok-Q', messages: [{ type: 'text', text: 'card' }] });
});

test('sendMedia: https jpg/png → image messages; PDFs → link in the text', async () => {
  const calls = fakeFetch();
  await line.sendMedia(ADDR, 'Invoice INV-1', [
    'https://bot.example.com/media/qr.png',
    'https://bot.example.com/media/inv-1.pdf?sig=abc',
    'https://bot.example.com/media/photo.JPG',
  ]);
  assert.deepEqual(calls[0].body.messages, [
    { type: 'text', text: 'Invoice INV-1\nhttps://bot.example.com/media/inv-1.pdf?sig=abc' },
    { type: 'image', originalContentUrl: 'https://bot.example.com/media/qr.png', previewImageUrl: 'https://bot.example.com/media/qr.png' },
    { type: 'image', originalContentUrl: 'https://bot.example.com/media/photo.JPG', previewImageUrl: 'https://bot.example.com/media/photo.JPG' },
  ]);
});

test('sendMedia: more than 5 messages are chunked; http images become links; nothing → null', async () => {
  const calls = fakeFetch();
  const imgs = Array.from({ length: 6 }, (_, i) => `https://x.example.com/${i}.jpg`);
  await line.sendMedia(ADDR, 'many', [...imgs, 'http://x.example.com/plain.png']);
  assert.deepEqual(calls.map((c) => c.body.messages.length), [5, 2]);
  assert.equal(calls[0].body.messages[0].text, 'many\nhttp://x.example.com/plain.png');
  assert.equal(await line.sendMedia(ADDR, '', []), null);
});

test('sendTemplate throws', async () => {
  await assert.rejects(line.sendTemplate(ADDR, 'HX1', {}), /LINE has no message templates; check channel.supportsTemplates/);
});

// ── downloadMedia ────────────────────────────────────────────────────────────────────────────────

function streamOf(chunks, onPull) {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (onPull) onPull();
      if (i < chunks.length) c.enqueue(chunks[i++]); else c.close();
    },
  });
}

test('downloadMedia: happy path, URL, auth header, content-type mapping, token never logged', async () => {
  const seen = [];
  line._setFetchForTests(async (url, init) => {
    seen.push({ url, init });
    const type = url.includes('/77/') ? 'audio/x-m4a' : 'image/jpeg';
    return new Response(Buffer.from('abc'), { status: 200, headers: { 'content-type': type } });
  });
  const img = await line.downloadMedia({ contentType: 'image/jpeg', ref: '66' });
  assert.equal(img.contentType, 'image/jpeg');
  assert.deepEqual(img.bytes, Buffer.from('abc'));
  const aud = await line.downloadMedia({ contentType: 'audio/mp4', ref: '77' });
  assert.equal(aud.contentType, 'audio/mp4');
  assert.equal(seen[0].url, 'https://api-data.line.me/v2/bot/message/66/content');
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(seen[0].init.signal);
  assert.doesNotMatch(out.text(), new RegExp(TOKEN));
});

test('downloadMedia: files keep their declared type', async () => {
  line._setFetchForTests(async () => new Response(Buffer.from('%PDF-1.4'), { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
  const pdf = await line.downloadMedia({ contentType: 'application/pdf', ref: '88' });
  assert.equal(pdf.contentType, 'application/pdf');
});

test('downloadMedia: Content-Length over the cap → rejected before reading', async () => {
  line._setMaxBytesForTests(10);
  let pulled = 0;
  line._setFetchForTests(async () => new Response(streamOf([new Uint8Array(5)], () => { pulled += 1; }), {
    status: 200, headers: { 'content-length': '11', 'content-type': 'image/jpeg' },
  }));
  await assert.rejects(line.downloadMedia({ contentType: 'image/jpeg', ref: '1' }), (err) => err.code === 'MEDIA_TOO_LARGE');
  assert.ok(pulled <= 1, 'body not consumed');
});

test('downloadMedia: streamed body over the cap → rejected', async () => {
  line._setMaxBytesForTests(10);
  line._setFetchForTests(async () => new Response(streamOf([new Uint8Array(6), new Uint8Array(6)]), {
    status: 200, headers: { 'content-type': 'image/jpeg' },
  }));
  await assert.rejects(line.downloadMedia({ contentType: 'image/jpeg', ref: '1' }), (err) => err.code === 'MEDIA_TOO_LARGE');
});

test('downloadMedia: non-200 and malformed refs rejected', async () => {
  line._setFetchForTests(async () => new Response('{"message":"Not found"}', { status: 404 }));
  await assert.rejects(line.downloadMedia({ ref: '1' }), /HTTP 404/);
  line._setFetchForTests(async () => new Response('', { status: 202 }));
  await assert.rejects(line.downloadMedia({ ref: '1' }), /HTTP 202/);
  await assert.rejects(line.downloadMedia({ ref: '../../info' }), /malformed/);
  await assert.rejects(line.downloadMedia({ ref: null }), /malformed/);
});

// ── config.js LINE block ─────────────────────────────────────────────────────────────────────────

function cfgEnv(extra = {}) {
  return {
    DATABASE_URL: 'postgresql://u:pw@db:5432/berpal',
    OPENAI_API_KEY: 'sk',
    TWILIO_ACCOUNT_SID: 'ACtest',
    TWILIO_AUTH_TOKEN: 'tok',
    ERPNEXT_URL: 'https://erp.example.com',
    TWILIO_ENV: 'sandbox',
    TWILIO_WHATSAPP_NUMBER_SANDBOX: 'whatsapp:+14155238886',
    ...extra,
  };
}
const lineErrors = (env) => validateEnv(env).errors.filter((e) => /LINE_/.test(e));

test('config: LINE both or neither', () => {
  assert.deepEqual(lineErrors(cfgEnv()), []);
  assert.deepEqual(lineErrors(cfgEnv({ LINE_CHANNEL_SECRET: 's3cr3t-value', LINE_CHANNEL_ACCESS_TOKEN: 't0ken-value' })), []);
  const onlySecret = lineErrors(cfgEnv({ LINE_CHANNEL_SECRET: 's3cr3t-value' }));
  assert.equal(onlySecret.length, 1);
  assert.match(onlySecret[0], /^LINE_CHANNEL_ACCESS_TOKEN is not set/);
  const onlyToken = lineErrors(cfgEnv({ LINE_CHANNEL_ACCESS_TOKEN: 't0ken-value', LINE_CHANNEL_SECRET: ' ' }));
  assert.equal(onlyToken.length, 1);
  assert.match(onlyToken[0], /^LINE_CHANNEL_SECRET is not set/);
  assert.doesNotMatch(onlyToken[0], /t0ken-value/);
});

// ── health.js line check ─────────────────────────────────────────────────────────────────────────

async function health(env, fetchImpl, query = {}) {
  const handler = createHealthHandler({ db: { query: async () => ({}) }, fetchImpl, env, now: () => 0 });
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ query }, res);
  return res;
}
const HENV = { ERPNEXT_URL: 'https://erp.example.com', TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok' };

test('health: line check present only when configured, with the bearer token', async () => {
  const calls = [];
  const okFetch = async (url, init = {}) => { calls.push({ url, init }); return { ok: true, status: 200 }; };

  const off = await health(HENV, okFetch);
  assert.equal('line' in off.body.checks, false);
  assert.equal(calls.some((c) => c.url.includes('api.line.me')), false);

  const on = await health({ ...HENV, LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 'lt' }, okFetch);
  assert.deepEqual(on.body.checks.line, { ok: true, ms: 0 });
  assert.equal(on.body.status, 'ok');
  const lc = calls.find((c) => c.url === 'https://api.line.me/v2/bot/info');
  assert.equal(lc.init.headers.Authorization, 'Bearer lt');
  assert.ok(lc.init.signal);

  const skipped = await health({ ...HENV, LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 'lt' }, okFetch, { deep: '0' });
  assert.deepEqual(skipped.body.checks.line, { ok: true, ms: 0, skipped: true });
});

test('health: line failing → degraded, fixed-vocabulary detail only', async () => {
  const fetchImpl = async (url) => (url.includes('api.line.me') ? { ok: false, status: 401 } : { ok: true, status: 200 });
  const res = await health({ ...HENV, LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 'lt' }, fetchImpl);
  assert.equal(res.code, 200);
  assert.equal(res.body.status, 'degraded');
  assert.deepEqual(res.body.checks.line, { ok: false, ms: 0, detail: 'HTTP 401' });
});
