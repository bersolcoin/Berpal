# Lane A: media intake (receipt photos, PDFs, voice notes)

Revised after two reviews. Fixed in this lane: B1, B2, B3 (download side), S1–S5, S7–S11, S13, the nits, and the five re-review residuals (streamed size cap, no per-boot FK DDL, stricter `cleanText`, per-model expiring fallback cache, expanded deferred list). Deferred to the integrator: S6, S12, B3 (signature side) and the items in "Integrator: deferred items" below.

## What was built

| File | Purpose |
|---|---|
| `src/whatsapp.js` | Handles each sender's messages in arrival order (S13). Different users still run concurrently. Calls `media.intake(user, raw, body)` after the chitchat check, then does one of three things: says nothing (`silent`), sends `reply` and stops, or appends the transcript and scan lines to the body. If `conversation.handle` throws, it deletes the blobs stored for that message. vCards now download through the guarded downloader (B3). |
| `src/media/index.js` | `intake()` handles each item on its own (S1). Allowlist (S10): `image/jpeg`, `image/png`, `application/pdf` → scan. `image/webp` → scan only with a caption; a lone webp is treated as a sticker and ignored silently. `image/heic`/`heif` → a clear "send as JPEG" reply, or a marker line if there's other content. `audio/*` → transcribe. A failed item becomes a `[receipt could not be read]` / `[voice note could not be transcribed]` marker as long as a caption or another item remains. Otherwise the user gets one plain reply (scan failed / too large / voice failed / HEIC / unsupported), and the model never gets an empty message. `discard(userId, ids)` deletes blobs from a failed turn. |
| `src/media/vision.js` | `scanDocument()` calls gpt-4o-mini with a strict `json_schema` response format and `detail: 'auto'`, and passes the user's local today (`user.timezone`, default Asia/Bangkok) (S4). The prompt says total means the amount payable incl. service charge and tip, never cash tendered or change (S9). `validateScan()` re-checks everything locally (B2): finite numbers, total ≥ 0, 0 ≤ confidence ≤ 1, 0 ≤ tax_rate ≤ 100, valid enums, 3-letter currency. Dates must be `YYYY-MM-DD`; Buddhist-era years (> 2400) have 543 subtracted, and impossible dates are dropped. String fields must actually be strings (anything else becomes null). `cleanText` strips brackets, braces, every C0/C1 control character (`\p{Cc}`, which includes newlines and tabs), U+2028/2029, and bidi overrides and isolates (U+202A–202E, U+2066–2069). New field `vat_claimable` (false for an abbreviated Thai tax invoice, ใบกำกับภาษีอย่างย่อ). `formatScanLine()` emits `[receipt scanned] {json}`, so a value can't forge a key. `currency` is always present, with an explicit `null` when it's unknown. Logs show which fields were read, never their values. |
| `src/media/transcribe.js` | Uses `MEDIA_TRANSCRIBE_MODEL` (default `gpt-4o-mini-transcribe`). Falls back to `whisper-1` only when `err.code === 'model_not_found'` or the error is a 404 whose message mentions "model" (S8). That decision is cached per model name for 1 hour: changing `MEDIA_TRANSCRIBE_MODEL` takes effect immediately, and a model enabled later gets retried after the hour. Logs transcript length only. |
| `src/media/download.js` | `isTwilioMediaUrl()` accepts only https on `api.twilio.com` or `*.twilio.com`, with no userinfo and no explicit port. Anything else is refused before any request (B3). Downloads time out via `AbortSignal.timeout(15000)`. The body is read chunk by chunk, and the request is aborted as soon as it passes `MEDIA_MAX_BYTES` (default 20 MB), so a missing or false Content-Length can't make it buffer more than the cap. A declared Content-Length over the cap aborts before any of the body is read. `MEDIA_MAX_BYTES` is parsed when the module loads: zero, a negative number, a non-integer or NaN throws, so a typo fails at boot instead of disabling the cap. |
| `src/media/openai-client.js` | Lazy client with `{ timeout: 30000, maxRetries: 1 }` (S3). Tests swap it out with `_setClientForTests(stub)`. |
| `src/media/store.js` | `saveBlob(userId, …)`, `getBlob(userId, id)` and `deleteBlob(userId, id)`. Every query is scoped to `id = $1 AND user_id = $2`, and `userId` is required (B1). `saveBlob` deletes only blobs older than 7 days (S7). |
| `src/media/attach.js` | `attachToDoc(erp, { userId, mediaId, doctype, docname })` requires `userId` and scopes the blob lookup to that user (B1). It uploads through `erp.uploadFile({ buffer, filename, contentType, isPrivate: true, doctype, docname })` (S11) and deletes the blob only after ERPNext accepts the file. It returns `{ name, file_url }`, returns `null` if no such blob exists for that user, and throws if the upload fails (the blob is kept). |
| `src/prompt/20-media.js` | Covers the JSON scan line, `receipt_media_id` (only if `media_id` is present; never invent or reuse one), currency null → user's default, `vat_claimable:false` → book the gross amount with no input VAT, receipt → cash/expense, invoice or bill → `bill_received`, low confidence → ask, the failure markers, and voice-note echo. |
| `src/migrations/020-media.sql` | `media_blobs` table, with the FK set to `ON DELETE CASCADE` in the `CREATE` (S7). Nothing touches the FK on later boots, so there's no per-deploy lock. I did not use a `DO $$` block that checks `pg_constraint.confdeltype`, because pg-mem has no plpgsql and the migration would break every test file that runs `db.migrate()`. Only a database that ran the first, pre-review draft of this file lacks the cascade; the one-off `ALTER` to fix it is in a comment in the file. A test checks the file has no `DROP`/`ALTER` outside comments. |
| `test/media.test.js` | 30 tests, including every fix above. |

Example of what `conversation.handle` receives for a captioned photo:

```
coffee with client
[receipt scanned] {"media_id":12,"type":"receipt","merchant":"Starbucks","date":"2026-11-02","total":185,"currency":"THB","vat_amount":12.1,"vat_rate":7,"vat_claimable":true,"paid_by":"credit_card","items":"2 lattes","confidence":0.93}
```

Other keys that can appear: `invoice_no` and `due`. `media_id` is left out when storing the image failed (S2). A voice note arrives as `[voice note] <flattened transcript>`.

## Integrator: deferred items (exact changes)

### S6a. `src/tools/update-draft.js`: add the property

`execute` already merges every argument into the draft, so only the schema changes.

```js
      receipt_media_id: {
        type: 'number',
        description: 'media_id from the latest "[receipt scanned] {…}" line. Set it whenever the draft comes from a scan so the image is attached to the saved ERPNext document. Never invent one.',
      },
```

### S6b. Clear a stale receipt_media_id on a new scan

A draft must not keep an older receipt's id once a new photo arrives. In `conversation.handle`, right after `applyDeterministicReplies(draft, userMessage)`:

```js
  // A new scan replaces any receipt previously attached to the draft; the model re-sets it from the new line.
  if (/^\[receipt scanned\] /m.test(userMessage || '')) delete draft.receipt_media_id;
```

### S6c. `src/tools/save-transaction.js`: attach after save, and require the confirmed card

`ctx.draft` is cleared right after the save, so read the id **before** `saveDraft`. `userId` is required: `attachToDoc` refuses blobs that belong to someone else.

```js
const { attachToDoc } = require('../media/attach');
// …inside execute, before the try block (next to the existing confirmation_pending check):
  // The receipt must be the one on the card the user confirmed: request_confirmation stores
  // confirmation_sig. If the draft changed after the card (signature differs), refuse and re-card.
  // (cardSignature lives in request-confirmation.js — export it and include receipt_media_id in it.)
  if (ctx.draft.confirmation_sig && ctx.draft.confirmation_sig !== cardSignature(ctx.draft)) {
    return { ok: false, error: 'The draft changed after the confirmation card. Call request_confirmation again.' };
  }
// …inside the try block:
    const mediaId = ctx.draft.receipt_media_id;
    const saved = await saveDraft(ctx.user, getErp(ctx), ctx.draft);
    ctx.saved = saved;
    …
    if (mediaId) {
      // The transaction is already posted; a failed attachment must not turn the save into an error.
      try {
        await attachToDoc(getErp(ctx), { userId: ctx.user.id, mediaId, doctype: saved.doctype, docname: saved.erpnext_name });
      } catch (err) {
        console.error(`[tools] receipt attach failed (media ${mediaId}):`, err.message);
      }
    }
```

`saveDraft` returns `{ erpnext_name, doctype }`.

### S12. `applyDeterministicReplies` and voice notes

`CONTACT_SKIP_RE` and the wallet `skip` regex are anchored (`^\s*skip\s*$`), so a spoken "skip" arrives as `[voice note] Skip.` and never matches. In `conversation.handle`, pass the message with the prefix removed:

```js
  applyDeterministicReplies(draft, String(userMessage || '').replace(/^\[voice note\] /, ''));
```

Keep the prefix on the message itself, which the LLM still needs.

### B3. Validate `X-Twilio-Signature` in `server.js`

The media URL allowlist stops credentials going to a foreign host, but a forged webhook can still pretend to be any registered user. In the `/webhook` handler, before `res.send(EMPTY_TWIML)`:

```js
const twilio = require('twilio');
// …
    const signature = req.get('X-Twilio-Signature') || '';
    // Must be the exact public URL Twilio calls (behind ngrok/proxy, the configured URL, not req.host).
    const url = process.env.TWILIO_WEBHOOK_URL || `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    if (!twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body)) {
      console.warn('[webhook] rejected request with invalid Twilio signature');
      return res.status(403).send('invalid signature');
    }
```

Add `TWILIO_WEBHOOK_URL` to `.env.example`, and consider `app.set('trust proxy', true)` on Railway. Skip the check only when `TWILIO_SKIP_SIGNATURE=true`, for local curl testing.

### (a) Export `cardSignature` from `src/tools/request-confirmation.js`

S6c needs it. Add `cardSignature` to that file's `module.exports`, and include `receipt_media_id` in the fields it hashes. Otherwise swapping the receipt after the card won't change the signature.

### (b) Discard the draft's blob on cancel and reset

When a draft is dropped without saving, delete its receipt now instead of leaving it for the 7-day purge. In `cancel_transaction` (`src/tools/cancel-transaction.js`), and wherever a conversation or draft is reset (`resetConversation`, `scripts/reset-conversations.js`), before the draft is cleared:

```js
const mediaIntake = require('../media');
if (ctx.draft.receipt_media_id) await mediaIntake.discard(ctx.user.id, [ctx.draft.receipt_media_id]);
```

`discard` is scoped to the user and never throws.

### (c) `conversation.handle()` must always return `{ text, isConfirmation }`

When `OPENAI_API_KEY` is missing, and on the OpenAI-error path, `handle()` returns a bare string. `whatsapp.js` destructures `{ text, isConfirmation }` from the result, so `text` ends up `undefined` and **the user gets no reply at all**. Both paths need to return `{ text: '<message>', isConfirmation: false }`. This applies to every voice note and receipt too, since they all go through `handle()`.

### (d) `.env.example`

Add `MEDIA_MAX_BYTES`, `MEDIA_TRANSCRIBE_MODEL` and `TWILIO_WEBHOOK_URL` (block below).

## Env vars to add to `.env.example`

```
# Voice-note transcription model (falls back to whisper-1 if this one isn't enabled on the project)
MEDIA_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
# Max size of an inbound photo/PDF/voice note, bytes (default 20 MB)
MEDIA_MAX_BYTES=20971520
```

```
# Exact public URL Twilio posts to (used for X-Twilio-Signature validation, see B3)
TWILIO_WEBHOOK_URL=https://<your-domain>/webhook
```

`MEDIA_MAX_BYTES` must be a positive integer or the server fails to boot. Existing vars this lane also uses: `OPENAI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`.

## PDFs

PDFs are sent to gpt-4o-mini as a Chat Completions `file` part (base64 data URL), with no new dependencies. **This was tested only against a stub.** If the live API rejects it, the user gets the plain "couldn't read that receipt" reply. To disable PDFs, remove `application/pdf` from `kindOf()` in `src/media/index.js`.

## Known limitations

- **Retention.** Blobs older than 7 days are purged. If a draft stays pending longer than that, its receipt is lost: the transaction still saves (`attachToDoc` returns `null`), just with no attachment.
- **No "reading your receipt…" message.** The user waits 2–5 s for vision, 1–3 s for transcription. While that runs, later messages from the same sender queue behind it.
- **The queue is per process.** It lives in memory, so running several server instances would need a DB advisory lock or a sticky route.
- **One receipt per draft.** Several photos produce several scan lines, but the draft holds a single `receipt_media_id`.
- **HEIC isn't converted.** Users are asked to resend as JPEG. WhatsApp normally converts photos itself.
- **Prompt injection.** Scan values and transcripts are flattened, and scan values are JSON-encoded, so they can't fake synthetic lines or keys. They still reach the LLM as data, and nothing is saved without the confirmation card. A user can still type a fake `[receipt scanned] …` line in a caption. That only affects their own draft, since attach is user-scoped. The pre-existing vCard line is not sanitised: vCard fields go in verbatim, and its log line prints them.
- **pg-mem quirks.** It mangles non-ASCII bytes in BYTEA parameters, so tests use ASCII payloads; real `pg` is fine. It also can't re-run `CREATE TABLE IF NOT EXISTS` with a REFERENCES clause on an existing table, which tests never do.
