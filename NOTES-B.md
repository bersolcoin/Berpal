# Lane B: customer outreach (invoices, PromptPay QR, payment reminders)

## What was built

| File | What |
|---|---|
| `src/erpnext.js` | Every request has a 30s timeout (`AbortSignal.timeout`). It is combined via `AbortSignal.any` with an optional caller `signal`: `_fetch(method, path, body, { signal })`, `getPdf(…, { format, signal })`, `uploadFile({ …, signal })`. `getPdf` returns a `Buffer` (via `_fetchBinary`) and throws unless the body starts with `%PDF-`. `uploadFile` does a multipart upload and returns `{ file_url, name }`. HTML is stripped from error text. |
| `src/twilio-client.js` | `sendMedia(to, text, mediaUrls[])` returns `{ sids, errors:[{ index, code, message }] }`. It sets a status callback when `PUBLIC_BASE_URL` is set. `sendTemplate` is another lane's and was not touched. |
| `src/outreach/promptpay.js` | EMVCo PromptPay payload (`buildPayload`, `parseTarget`, `crc16`) and `renderPng` (qrcode). |
| `src/outreach/phone.js` | `normalizePhone(raw, country)`: strict E.164 normalisation (rules below). |
| `src/outreach/gate.js` | Server-side consent gate: `storePreview`, `verify`, `clearPreview(ctx, tool)`, `planHash`. |
| `src/outreach/send-invoice.js` | Read-only planning: `planInvoice` and `planReminders` (one message per customer). `deliver` does render, upload, send and log. Also `listOpenReceivables`, `customerRemindedWithin`, `customerAttempts`, `localToday`, `maskPayee`. |
| `src/tools/send-invoice.js` | `send_invoice { ref, confirmed }` |
| `src/tools/send-payment-reminder.js` | `send_payment_reminder { ref \| counterparty_id \| scope:'overdue'\|'due_soon', confirmed }`. Max 20 invoices per call. |
| `src/tools/set-payment-settings.js` | `set_payment_settings { promptpay_id?, reminders_enabled?, confirmed? }` |
| `src/prompt/30-outreach.js` | Preview, end the turn, then `confirmed:true` only on the user's very next message. If the confirm call returns a new preview, show it and ask again. Never auto-send after `save_transaction`. After "Saved ✓" the model may offer "Send it to <customer>?". A preview is not a transaction. Settings are shown with the payee masked. |
| `src/migrations/030-outreach.sql` | `users.promptpay_id`, `users.reminders_enabled` (default 0), and `outreach_log` with `customer`, `sent_local_date`, `files`, `message_sid` plus indexes. |
| `src/jobs/reminders.job.js` | Daily reminders, per customer. Exports `enabled(user)`. |
| `src/jobs/cleanup.job.js` | Nightly deletion of the public Files that outreach uploaded. |
| `test/outreach.test.js` | 45 tests (20/20 consecutive runs pass). The consent flows run through the real `conversation.handle()` with a scripted OpenAI stub. |
| `package.json` | Adds the `qrcode` dependency. |

## Consent gate (with `src/conversation.js`)
1. **Preview.** A call without `confirmed:true`, or one that fails verification, stores `draft.outreach_preview = { preview_id, tool, args, plan_hash, to, body, attachments, refs, created_at }`. It is stored unarmed. `preview_id` is a random UUID per preview; conversation.js identifies previews by it, because two previews can share a `created_at` millisecond.
2. **Arming.** `conversation.js` arms the preview when the turn ends. It deletes the preview if the next turn ends with that same preview still pending. A confirm is therefore only possible on the user's **very next** message; "no wait" followed by "ok send" needs a new preview. A re-preview (new `preview_id`) re-arms for one more turn.
3. **Forgery blocked.** `outreach_preview` is a protected draft key: it is stripped from `update_draft` and hidden from the prompt's CURRENT DRAFT, so the model cannot forge an armed preview (tested).
4. **Confirm.** `confirmed:true` needs all of the following:
   - the preview's `tool` equals this tool;
   - `armed === true`;
   - the preview is at most 30 minutes old;
   - the hash of the plan recomputed from live data (recipient, body, attachments, refs) equals `plan_hash`.

   The hash also covers the **full PromptPay payee id** (the preview only shows ••••1234), so two ids with the same last 4 digits still count as a change. For settings, it binds the full new id. If any check fails, the call stores a new unarmed preview and returns it with the reason.
5. **After send, or when nothing is sendable.** The preview is deleted. That covers a send, and also a ref that is no longer sendable (for example now paid).

## Send flow
1. **Load and validate the invoice.** It must belong to the same company (another tenant's invoice gets "not found"). It must be submitted, not `is_return`, and have `outstanding_amount > 0`.
2. **Find the phone.** The phone comes only from **this user's `counterparty_cache`**, matched by `erpnext_customer`. It never uses ERPNext `Customer.mobile_no`, because Customers are shared across tenants.
3. **Normalise the phone.** Accepted forms:
   - `+E.164`;
   - a `00` prefix;
   - a national number starting with `0`, using the user's `users.country` (an unknown country is refused).

   It strips `(0)`, spaces, dashes, dots and brackets, and drops a trunk 0 after the country code. It refuses `+0…`, extensions or letters, and bare digits. Thai numbers must be `+66` followed by 9 digits starting with 6, 8 or 9.
4. **Label amounts.** Amounts use `party_account_currency || currency`. The QR is added only when that is THB, and its amount is the THB total.
5. **Reminder content.** One message per customer lists each invoice with "N days overdue (due D)", "due today" or "due in N days". These labels are computed from `due_date` against the user's local date: `deps.clock.date` in the job, `users.timezone` (default Asia/Bangkok) in the tools.
6. **WhatsApp carries one attachment per message.**
   - **Free-form:** text plus up to **3 PDFs** plus the QR. Each attachment is its own WhatsApp message. With more than 3 invoices, the refs are listed in the text and only the QR is attached.
   - **Template mode** (content SID set and `twilio.sendTemplate` exists):
     - **Invoice:** one template, `{{1}}` customer, `{{2}}` amount, `{{3}}` due date, `{{4}}` **exactly one** PDF URL.
     - **Reminder:** one statement template, `{{1}}` customer, `{{2}}` total, `{{3}}` statement ("REF THB x N days overdue (due D); …"), with no PDFs.
     - **QR:** in both cases it follows as a free-form media message.
7. **Preview content.**
   - **Body:** the exact free-form text. In template mode it is the approved wording from `TWILIO_*_TEMPLATE_TEXT` with values substituted, or else it states plainly that the approved template will be used with the listed values.
   - **Recipient** and number.
   - **Attachments:** listed, with the QR shown as "PromptPay QR for THB X → payee ••••1234".
   - **`whatsapp_messages`:** how many WhatsApp messages will go out.
   - **Notes:** that the PDF shows line-item descriptions, the one-attachment-per-message rule, and in free-form mode the 24-hour warning.
8. **Deliver.** The phone is validated during planning and checked again in `deliver` before anything is uploaded. PDFs and the QR are then uploaded as public ERPNext Files with a 64-bit random suffix.
9. **Log.** Each invoice gets its own `outreach_log` row, with `customer`, `status` (`sent`, `partial` or `failed`) and `error` (`code: message`). The row also records `message_sid` (first SID), `sent_local_date` and `files`.

## PromptPay derivation (tested)
- **CRC check value.** The CRC is CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF). It is pinned by the standard check value `crc16("123456789") = 29B1`.
- **Reference vector.** Our output is byte-identical to the promptpay-qr README example: `000-000-0000`, amount 4.22 gives `…54044.226304E469`.
- **Targets.** A mobile number becomes `0066` + 9 digits under tag 01. A 13-digit id uses tag 02; this takes precedence over the "0066" mobile heuristic. A 15-digit id uses tag 03.
- **Point of initiation.** `11` for a static QR, `12` when an amount is set.
- **Amount.** Tag 54 is `toFixed(2)`. NaN, negative, non-numeric and ≥ 1e13 amounts throw.
- **Tests.** The tests parse the TLV of the payload used for the PNG and check the uploaded PNG equals `renderPng(payload)`.

## Env vars to add to `.env.example`
- `ERPNEXT_INVOICE_PRINT_FORMAT`: optional. The Print Format for invoice PDFs. Unset means ERPNext's default.
- `TWILIO_INVOICE_CONTENT_SID`: optional. Approved invoice template: `{{1}}` customer, `{{2}}` amount, `{{3}}` due date, `{{4}}` PDF URL.
- `TWILIO_INVOICE_TEMPLATE_TEXT`: optional. That template's approved body with `{{n}}` placeholders (`\n` allowed), used in the preview.
- `TWILIO_REMINDER_CONTENT_SID`: optional. Approved reminder template: `{{1}}` customer, `{{2}}` total, `{{3}}` statement. It has no link variable.
- `TWILIO_REMINDER_TEMPLATE_TEXT`: optional. The reminder template's approved body, used in the preview.
- `PUBLIC_BASE_URL`: shared with the status-callback lane.

## Scheduler interface implemented
- **`reminders.job.js`.** It exports `{ name: 'reminders', defaultTime: '09:00', timeoutMs: 15 min, enabled(user), run(user, deps) }`.
  - **Opt-in.** `enabled = !!Number(user.reminders_enabled)`, so turning it on works the same day. `run` also returns `{ skipped: true, note: 'reminders disabled' }` when it is off.
  - **Inputs.** `deps = { erp, twilio, now, clock, signal? }`. `clock.date` drives "today", the labels and the window. `signal` is passed to the ERPNext calls inside `deliver` (PDF render and uploads).
  - **Timeout.** When `signal` is aborted, the loop stops before the next customer, and a delivery cut off mid-render or mid-upload is not counted as a failure. The result is `aborted: true` and the note says "stopped early". The Twilio SDK accepts no AbortSignal, so **a send already in flight completes** and is logged.
  - **Selection.**
    1. Take open receivables due on or before `clock.date + 3`, queried directly with no 50-row cap.
    2. Group them by customer.
    3. Skip a customer if any **attempt** to them has `sent_local_date > today − 3`. An attempt is a reminder row with a `message_sid` (any status, so undelivered 63016 messages count) **or** a synchronous Twilio rejection with no SID (`error` matching `/^\d{5}:/`, e.g. 21211). Failures before Twilio (PDF or upload errors) are not attempts and are retried the next day. A reminder on day D blocks D, D+1 and D+2; the next can go on D+3.
    4. Skip a customer who already has 5 attempts about their current invoices; those customers are reported in `capped`. An attempt is counted per message: by SID, or by `sent_at` for rejections. This stops a bad number from being retried, with fresh uploads, every 3 days forever.
    5. Then cap the run at 50 customers.
  - **Sending.** Each customer is planned and delivered in its own try/catch.
  - **Return value.** `{ sent (invoices), messages, skipped, failed, note: 'sent N, skipped N, failed N[; …cap…]', failures?, capped? }`.
- **`cleanup.job.js`.** It exports `{ name: 'cleanup', defaultTime: '03:00', window: 180, run }` and runs for every user.
  - It deletes ERPNext `File` docs listed in `outreach_log.files` for rows more than 2 days old, then sets `files = NULL`. File names are kept when a delete fails, so the next run retries.
  - It returns `{ deleted, failed, note }`, or `{ skipped: true, note: 'nothing to clean' }`.

## For the integrator
- **Root cause of the wrong-phone risk, in `src/counterparties.js` (not my file).** `syncFromErp` upserts `phone = COALESCE(EXCLUDED.phone, counterparty_cache.phone)`. That lets an ERPNext `mobile_no`, possibly from another tenant's same-named Customer, **overwrite the phone the user entered**. Outreach trusts only `counterparty_cache`, so this should be `COALESCE(counterparty_cache.phone, EXCLUDED.phone)`. Ideally it should also not pull Customers that aren't linked to this user's company.
- **Status callbacks.** The status-callback route can `UPDATE outreach_log SET status='failed', error=… WHERE message_sid = $1`. Only the first SID is stored, which is the text-carrying message (or the template).
- **Draft state flag (N8).** A draft holding only `outreach_preview` still makes conversation state `'extracting'`. The outreach preview texts never mention a transaction, the prompt says a preview is not a transaction, and my tools clear their preview when nothing is sendable. The state flag itself is `conversation.js`'s.

## Known limitations
- **Free-form mode and the 24-hour window.** Free-form is used when template SIDs are not set. WhatsApp only delivers a business-initiated free-form message if the customer messaged this number in the last 24 hours; otherwise Twilio **accepts it and returns a SID**, and delivery fails later (63016). The preview warns about this. Template mode avoids it, but the QR follow-up is still free-form. In the sandbox the customer must also have joined the sandbox.
- **Public files.** The random suffix is the only protection until the nightly cleanup, which runs about 2 days after the send. In template mode the PDF link in the message stops working after that.
- **Print format.** This assumes `download_pdf` works for the API user (wkhtmltopdf installed, print permission) and that the chosen format shows the letterhead and the line items as typed.
- **PromptPay.** Only a THB party-account amount gets a QR. Nothing checks that the PromptPay id is registered.
- **Phones.** The calling-code table is small (TH, SG, MY, HK, IN, LK, AE, CN, JP, GB, AU, DE, FR, CH, IL, BE). Other countries must use `+`.
- **Manual reminders.** `send_payment_reminder` skips the dedupe and the cap, because the user explicitly approved that send.
- **Owner not notified.** The owner isn't told what the job sent. The digest could read `outreach_log`.
