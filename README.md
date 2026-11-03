# ber-accounting

WhatsApp-first bookkeeping bot for small businesses. Users log transactions in plain language ("paid 850 for lunch", "sold ruby 7.68ct to Jameel Crest Gems for 45000 USD net 30"), the bot extracts the structured fields, shows a confirmation card, and posts the transaction to **ERPNext** as the accounting backend.

> **Status:** all transaction flows post to ERPNext: sales invoices, purchase invoices (bills), payments against either (incl. partial and multi-currency), cash income/expense, wallet transfers, advances given/received and opening balances, with Thai VAT/WHT, multi-line invoices and per-stone stock. Receipt photos/PDFs and voice notes are read before the model sees the message. The bot can send invoices and payment reminders to customers (with a consent gate), and a scheduler sends a morning digest. Everything is tested against an in-memory ERPNext stand-in (`npm test`) and the model's tool choices against the real OpenAI API (`npm run test:llm`); **none of the new features has been run against a real ERPNext instance or a live Twilio sender yet.**

## Architecture

WhatsApp → Twilio webhook → Express (`server.js`, signature-checked) → `src/whatsapp.js` (per-sender queue, chitchat short-circuit, media intake: photos/PDFs → vision scan line, voice notes → transcript, vCards → contact line) → conversation engine (`src/conversation.js`: system prompt + `src/prompt/*` sections, GPT-4o-mini tool loop) → tools (`src/tools/*`) → write side: per-doctype handlers in `src/erp-sync/` POST to ERPNext via `src/erpnext.js`; read side: `src/erp-query/` reads live balances, invoices and stock. Outbound messages to customers go through `src/outreach/` behind a preview → yes gate; scheduled sends (digest, reminders) run from `src/jobs/scheduler.js` inside the same process. Postgres holds identity, conversation state, lookup caches, receipt images awaiting attachment, and job/outreach logs only — **no accounting truth lives in Postgres** (that's all in ERPNext). Multi-tenant model: one shared ERPNext instance with N Companies, one Company per user.

Nothing is posted without a confirmation card. `request_confirmation` builds the card's lines on the server (`src/tools/card.js`; the model copies them verbatim) and signs the draft; when that turn ends, `handle()` stores the signature of the card the user saw in `confirmation_pending`. `save_transaction` on a later turn refuses unless the draft still matches it — re-signing in the save turn doesn't count. The only card-less save is the second half of the missed-sale flow: the back-dated invoice is carded and confirmed like any other draft, and in that same confirm turn the payment that settles it is chained without a second card. If OpenAI fails after something was saved or cancelled in a turn, the draft is reset and the reply says what was saved, so a repeated "yes" can't post twice. Server-only draft keys (`confirmation_*`, `wallet_options`, `outreach_preview`) can't be set by the model. When the bot's last reply listed wallets by number and the user answers with just that number, the server resolves it to the wallet shown on that line (matched by name), and the model can't swap it in that turn; any other bare number is left to the model.

## Features

**Logging transactions.** Type it the way you'd say it: "paid 850 for lunch", "sold ruby 7.68ct to Jameel for 45,000 USD net 30", "got a bill from Acme for 12,000, due in 15 days". The bot fills in what it can, asks only for what's missing (wallet, a new contact's phone, payment terms), shows a card, and posts to ERPNext when you tap Confirm. Questions ("what's outstanding?", "how much does Jameel owe me?", "how much money do I have?") are answered from live ERPNext data.

**Receipts, PDFs and voice notes.** Send a photo or PDF of a receipt or bill and the bot reads the merchant, date, total, VAT and invoice number, then runs the normal flow; when you confirm, the image is attached to the saved ERPNext document (private file). Send a voice note and it's transcribed and handled like a typed message — the reply opens with what it heard. HEIC photos get a "please send as JPEG" reply; stickers are ignored.

**Sending invoices and reminders to customers.** "Send it to Jameel" shows exactly what will go out (recipient, number, text, invoice PDF, PromptPay QR for THB amounts) and sends only after your yes on the very next message. "Remind everyone who's overdue" does the same per customer. With automatic reminders switched on (`set_payment_settings`), customers with invoices overdue or due within 3 days get one reminder message every 3 days at most. Customer numbers come only from the contacts you entered (a shared contact, a typed number, `create_contact`); the bot never copies a phone or email from ERPNext into your contacts.

**Morning digest and schedule.** Every morning (08:00 local by default, change with "send my digest at 7:30") the bot sends your cash position, overdue items, what's due in the next 7 days, and yesterday's totals. Timezone and reminder time are adjustable in chat.

**Thai VAT, withholding tax, line items and stock.** Tell the bot once whether you're VAT-registered. VAT 7% (inclusive or on top) is computed by the bot, never by the model, and shown on the card as Net / VAT / Gross; WHT (1/2/3/5%, PND3/PND53) on bills and cash expenses shows what you actually pay the supplier. Invoices can carry several lines. Naming a stone or SKU ("PA2293") makes it a tracked stock item: buying it receives stock, selling it issues stock and books cost of goods sold, and "what's in stock?" lists what's on hand with its value.

## Stack

- Node.js 20.3+ (native `fetch`, `FormData`, `AbortSignal.any`); developed on Node 26
- Express
- Postgres (developed against Railway-hosted)
- OpenAI Chat Completions API (function calling)
- Twilio WhatsApp Business / Sandbox
- ERPNext (REST API; tested against v14+)
- `frankfurter.app` for ECB reference FX rates

## Prerequisites

- Node.js 20.3 or newer
- A Postgres database (Railway free tier works)
- An ERPNext instance with API access and at least one Company configured
- Twilio account with WhatsApp Sandbox or Business Sender
- OpenAI API key
- [ngrok](https://ngrok.com/download) (or any tunnel) for local webhook exposure

## Setup

```bash
git clone <repo-url>
cd ber-accounting
npm install
cp .env.example .env
# edit .env with your real credentials — see comments in the file
```

Run the database migrations + seed the test user:

```bash
node scripts/migrate.js
```

Start the server:

```bash
npm start
```

In another terminal:

```bash
ngrok http 3000
```

Point your Twilio WhatsApp webhook at `https://<your-ngrok>.ngrok-free.app/webhook` (HTTP POST). To have the server check Twilio's signature locally too, set `PUBLIC_BASE_URL=https://<your-ngrok>.ngrok-free.app` (see Development). In production `PUBLIC_BASE_URL` (or `TWILIO_WEBHOOK_URL`) is required.

## ERPNext setup

The target Company needs (most standard charts already have these):

- **Default accounts** (Company → Default Accounts): Receivable, Payable, Cash, Income, Expense. The bot auto-creates per-currency `Debtors USD`, `Creditors USD`, etc. on first use.
- **Exchange Gain/Loss Account** (Company → Default Accounts). Required for multi-currency settlement; ERPNext posts FX differences there. `node scripts/check-fx-account.js` verifies the multi-currency setup.
- **Tax accounts.** A **Duties and Taxes** group (liability) and a **Tax Assets** group (asset). `Output VAT` and `WHT Payable` are created under Duties and Taxes, `Input VAT` under Tax Assets (or Current Assets if there's no such group), matched by **exact** account name. If the company already has differently named tax accounts (e.g. "ภาษีขาย"), rename them to exactly `Output VAT` / `Input VAT` / `WHT Payable`, otherwise new ones are created alongside.
- **Perpetual inventory** on the Company (v14 default), with Default Inventory Account and Default COGS set, and a warehouse: Stock Settings `default_warehouse` if it belongs to the company, else `Stores - <abbr>` (created with every company), else any leaf warehouse.
- **Stock Settings:** leave **Allow Negative Stock off**. Valuation method is the site's choice (FIFO by default).
- **System Settings → Rounding Method:** keep the default "Banker's Rounding (legacy)" — that's the rounding the bot reproduces for VAT/WHT.
- **Print format** for invoices sent to customers: set `ERPNEXT_INVOICE_PRINT_FORMAT` (else ERPNext's default). `download_pdf` must work for the API user (wkhtmltopdf installed, print permission), and the format should show the letterhead and line items as typed. A Thai full tax invoice also needs the seller's and buyer's tax IDs and branch: set Company `tax_id` and Customer `tax_id` (the bot stores the user's own tax ID in `users.tax_id` but doesn't push it to ERPNext); item rates print net with VAT as a separate line.
- **API user permissions:** the usual accounting doctypes, plus read on Company, Warehouse, Bin, Stock Ledger Entry and Stock Settings; create on Item, Item Group, Account and File (uploads), delete on File (the nightly cleanup).

## WhatsApp templates and the 24-hour window

WhatsApp delivers a free-form business message only if the recipient messaged your number in the last 24 hours. Outside that window Twilio still **accepts** the message and returns a SID; delivery fails later (error 63016), and only the status callback (`POST /twilio/status`, needs `PUBLIC_BASE_URL`) records it. Anything the bot starts — digests, invoices, reminders — therefore needs an approved template in production. Set the content SIDs (and, for outreach, the approved body text so the preview shows the real wording):

| Template | Env var | Variables |
|---|---|---|
| Confirmation card (Quick Reply buttons) | `TWILIO_CONFIRMATION_CONTENT_SID` | the card text — create with `npm run create-template` |
| Morning digest | `TWILIO_DIGEST_CONTENT_SID` | `{{1}}` date (e.g. "Tue 3 Nov"), `{{2}}` body on one line, sections joined by " \| ", ≤ 900 chars. Suggested body: `Your books, {{1}}: {{2}}` |
| Invoice | `TWILIO_INVOICE_CONTENT_SID` (+ `TWILIO_INVOICE_TEMPLATE_TEXT`) | `{{1}}` customer, `{{2}}` amount, `{{3}}` due date, `{{4}}` exactly one PDF URL |
| Payment reminder | `TWILIO_REMINDER_CONTENT_SID` (+ `TWILIO_REMINDER_TEMPLATE_TEXT`) | `{{1}}` customer, `{{2}}` total, `{{3}}` statement ("REF THB x N days overdue (due D); …"); no link variable, no PDFs |

Without a content SID: the digest is sent free-form only if the user wrote in the last 23h (otherwise the run is `skipped`); invoices and reminders go free-form (text + up to 3 PDFs + QR, one attachment per WhatsApp message) and the preview warns about the window. The PromptPay QR always follows as a free-form media message. Variables can't contain newlines or tabs (flattened to spaces). In the sandbox the customer must also have joined the sandbox.

## Jobs

`src/jobs/scheduler.js` ticks every minute inside the web process and runs each `src/jobs/*.job.js` for every active user with ERPNext credentials, in the user's own timezone (`users.timezone`, default `Asia/Bangkok`):

| Job | Default time | Window | Notes |
|---|---|---|---|
| `digest` | 08:00 | 120 min | on/off via `users.digest_enabled`; time via "send my digest at 7:30" |
| `reminders` | 09:00 | 120 min | opt-in (`users.reminders_enabled` via `set_payment_settings`); 15-min budget |
| `cleanup` | 03:00 | 180 min | deletes the public ERPNext Files outreach uploaded, ~2 days after sending |

- **At most once per user/job/day.** A `job_runs` row is claimed (`INSERT … ON CONFLICT DO NOTHING`) before the job runs; another instance or overlapping tick can't double-send. A run is also refused within 20h of the previous one, so a timezone change can't create a second "today".
- **Windows, no catch-up.** A job runs only inside `[time, time + window)` local time. A day missed (server down, deploy at 22:00) is skipped, not caught up.
- **Timeouts.** Each run gets an `AbortSignal` (`deps.signal`) that fires at its `timeoutMs` (default 60s); the run's ERPNext client carries it, so in-flight ERPNext calls are cancelled. JS can't kill the job: the row is marked `failed`/`timeout` at once, and the real result overwrites it when the job settles. Rows left `running` for 30 min (crash) are marked `abandoned` and never re-run.
- **`DISABLE_JOBS=1|true|yes|on`** skips the scheduler on an instance (second web-only instance, local dev). On SIGTERM/SIGINT the server waits up to 10s for the in-flight tick.
- **Status callback.** `POST /twilio/status` (signature-checked against `PUBLIC_BASE_URL + '/twilio/status'`; 403 when `PUBLIC_BASE_URL` or `TWILIO_AUTH_TOKEN` is unset) marks the matching `job_runs` / `outreach_log` row failed on `failed`/`undelivered`. Template and media sends request it automatically when `PUBLIC_BASE_URL` is set; plain `sendText` sends only get it if the callback URL is configured on the Twilio sender.

New jobs export `{ name, defaultTime, window?, timeoutMs?, enabled?(user), run(user, { erp, twilio, now, clock, signal }) }`; see the header of `src/jobs/scheduler.js`.

## Project layout

```
server.js                   Express: POST /webhook, POST /twilio/status, scheduler start/stop
src/
  webhook.js                /webhook handler + X-Twilio-Signature check
  whatsapp.js               phone → user routing, per-sender queue, media + vCard lines, chitchat short-circuit
  conversation.js           LLM tool loop, core system prompt, conversation state
  prompt/                   feature prompt sections (media, outreach, digest, tax/items/stock), appended in filename order
  tools/                    LLM tool definitions + dispatch, one file per tool (index.js = registry)
    validate.js             draft checks shared by request_confirmation / save_transaction; protected draft keys
  erp-sync/                 WRITE side, one file per ERPNext doctype
    index.js                routes a confirmed draft → handler
    sales-invoice.js        invoice_issued
    purchase-invoice.js     bill_received
    payment-entry.js        payment (settles invoices, bills and advances; WHT overpayment guard)
    journal-entry.js        cash income/expense, transfers, advances, opening balances
    taxes.js                VAT/WHT totals and tax rows
    invoice-lines.js        multi-line invoices
    items.js                stock Items, warehouses, stock-on-hand checks
    common.js               account resolution, per-currency party accounts, generic items, rounding
  erp-query/                READ side, one file per query (incl. stock.js)
  media/                    intake (download, vision scan, transcription), blob store, attach-to-ERPNext
  outreach/                 send invoice / reminders: planning, PromptPay QR, phone normalisation, consent gate
  jobs/                     scheduler + *.job.js (digest, reminders, cleanup)
  migrations/               SQL migrations applied by db.migrate()
  counterparties.js         contacts ↔ ERPNext Customer/Supplier (one contact can be both)
  wallets.js                cash/bank/credit-card wallets ↔ ERPNext Accounts
  erpnext.js                thin REST client for ERPNext (timeouts, optional AbortSignal, PDFs, uploads)
  exchange.js               frankfurter.app FX rates
  twilio-client.js          Twilio REST: text, confirmation card, templates, media
  chitchat.js               regex-based pre-LLM filter
  vcard.js                  minimal vCard parser
  users.js, messages.js, db.js, log.js

scripts/
  migrate.js                run pending DB migrations + seed test user
  check-load.js             smoke test: every module loads
  create-confirmation-template.js   register the Twilio Quick Reply card
  check-fx-account.js       verify ERPNext Company multi-currency setup
  list-receivables.js       list all Receivable/Payable accounts with currency
  reset-conversations.js    clear all drafts + chat history (npm run reset)
  ping-db.js                standalone Postgres connectivity test
  show-inv.js <name>        pretty-print an ERPNext Sales Invoice

test/
  fake-erpnext.js           in-memory ERPNext that enforces the validations the bot relies on
  flows.test.js             end-to-end tool flows (Postgres via pg-mem)
  media.test.js, outreach.test.js, jobs.test.js, tax-items.test.js   per-feature tests
  integration.test.js       cross-feature wiring (receipt attach, card signature, webhook signature, …)
  llm-harness.js            scripted conversations against the real OpenAI model (npm run test:llm)
```

Wallets map to ERPNext leaf Accounts (Cash / Bank account types; credit cards are liability
accounts). Contacts become an ERPNext Customer on first invoice/advance-given and a Supplier
on first bill/advance-received. Invoices are referenced by their ERPNext name
(e.g. `ACC-SINV-2026-00004`) everywhere the bot talks about them.

## Development

- **Deploy note (card signatures):** drafts persisted before the signature change hold `confirmation_pending: true` instead of a signature. They can't be saved as they are: the user gets one fresh card (the model re-issues it on their "yes"), then saves normally.

- `npm run dev` — server with `--watch`
- `node scripts/check-load.js` — confirm every module loads (catches syntax/import errors before a deploy)
- `node scripts/ping-db.js` — confirm DB connectivity before debugging server-start issues
- `node scripts/migrate.js` — apply schema changes (idempotent)
- `node scripts/show-inv.js ACC-SINV-2026-00001` — verify an invoice landed in ERPNext correctly
- `npm run reset` — clear every conversation's draft and history
- Set `LOG_MESSAGES=true` in `.env` to persist every WhatsApp message to the `messages` table for debugging
- Set `DISABLE_JOBS=1` locally so a dev server doesn't send digests/reminders
- **Webhook signature:** once `TWILIO_WEBHOOK_URL` or `PUBLIC_BASE_URL` is set, every `POST /webhook` must carry a valid `X-Twilio-Signature` for that exact URL (403 otherwise); a malformed URL stops the server at boot. With neither set, `NODE_ENV=production` refuses every request (403, logged once); any other environment accepts unsigned requests with a loud warning at boot — convenient behind a changing ngrok URL and for curl testing. Behind ngrok set `PUBLIC_BASE_URL` to the current ngrok origin to test the real check.

## Testing

- `npm test` — all unit/flow tests (node:test). No network: ERPNext is `test/fake-erpnext.js`, Postgres is pg-mem, OpenAI and Twilio are stubbed.
- `npm run test:llm` — `test/llm-harness.js` drives scripted WhatsApp conversations through `conversation.handle()` with the **real** OpenAI model (needs `OPENAI_API_KEY` in `.env`; a few cents; 2–4 minutes). ERPNext, Postgres, FX and Twilio stay in memory. Synthetic `[receipt scanned]` / `[voice note]` lines are injected directly (the harness bypasses `whatsapp.js`). `VERBOSE=1` also prints the bot's tool logs. Model output isn't deterministic: treat a failure as "read the transcript", not a red build.

## Known limitations

**Not verified live.** Everything below the core flows has only run against the fake ERPNext and stubbed Twilio/OpenAI. In particular: PDFs sent to the vision model as a Chat Completions `file` part (if the live API rejects it, the user gets "couldn't read that receipt"; remove `application/pdf` from `kindOf()` in `src/media/index.js` to disable), the print format/`download_pdf` path, and real ERPNext stock/tax posting.

**Media**
- Receipt images are kept 7 days; a draft pending longer saves without its attachment. One receipt per draft (several photos produce several scan lines, but the draft holds one `receipt_media_id`). A failed attachment is logged, not retried.
- No "reading your receipt…" message: the user waits 2–5 s for vision, 1–3 s for transcription, and later messages from the same sender queue behind it. The queue is in-memory, per process: several instances would need a DB advisory lock or sticky routing.
- HEIC isn't converted (users are asked to resend as JPEG; WhatsApp normally converts photos itself).
- Scan values, transcripts and vCard fields are flattened/sanitised so they can't fake synthetic lines or keys, but they still reach the model as data. A user can type a fake `[receipt scanned]` line in a caption; it only affects their own draft (attach is user-scoped) and nothing saves without the card.

**Outreach**
- Free-form mode and the 24h window (see above); public Files: the random suffix is the only protection until the nightly cleanup ~2 days later, after which a template's PDF link stops working.
- PromptPay QR only for THB party-account amounts; nothing checks that the PromptPay id is registered.
- The phone calling-code table is small (TH, SG, MY, HK, IN, LK, AE, CN, JP, GB, AU, DE, FR, CH, IL, BE); other countries must use `+`.
- Manual `send_payment_reminder` skips the 3-day dedupe and 5-attempt cap (the user approved that send). The owner isn't told what the reminders job sent.
- Contact search (`syncFromErp`) still links a same-named ERPNext Customer/Supplier to a contact that has no link yet (Customers are shared across tenants, and the link isn't company-scoped). It never imports a phone or email and never changes an existing link.
- After a save the conversation history is cleared, so "send it to Jameel" relies on the model finding the invoice with `query_open_invoices`; with several open invoices it has to ask which.

**Jobs**
- The 20h guard means moving the digest from evening to morning (20:00 → 08:00 next day) skips that one morning.
- Jobs are aborted only cooperatively (`deps.signal`); a Twilio send already in flight completes (the SDK takes no signal).
- "Yesterday" totals are in the company currency only; digest template variables are capped at 900 chars; with more than 47 overdue items the due-soon section shows a count only.
- A database created from a pre-review draft of `040-schedule.sql` / `020-media.sql` needs the one-off ALTERs in the comments of those files; `job_runs.id` created as SERIAL keeps a 32-bit sequence.

**Tax, items, stock**
- VAT/WHT are booked at invoice time for goods and services alike; for services Thai law puts the tax point at payment (an accountant should reclassify unpaid service VAT to "Undue VAT" at month end).
- Customer-side WHT (a customer withholding from your sale) isn't modelled and shows as an underpayment. Remitting WHT has no dedicated flow (log it as a cash expense / JE out of WHT Payable). One WHT Payable account: PND3 vs PND53 is only in the row description; no 50 Tawi certificate, no ERPNext TDS reports.
- Who must withhold (juristic person, ≥ 1,000 THB) is a prompt rule only.
- No opening-stock flow (use a purchase bill), no serial/batch numbers (one Item per stone id, counted in Nos). Item codes ignore separators, so `A-12` and `A1-2` are the same Item. Cancelling a stock invoice isn't supported.
- A stock line whose amount doesn't divide by its qty books the leftover satang to a rounding row (on purchases the stone's valuation can be a few satang under).
- If a site switches Rounding Method to "Banker's Rounding" (half-to-even), its figures can differ from the bot's by a satang.

**Model reliability (gpt-4o-mini).** On the final tree, `npm run test:llm` passed all 99 checks in 2 of the 3 runs that finished. The third failed one check: on the voice-note turn the model called only `list_user_accounts`, skipping `update_draft`, then recovered and saved correctly. One further run stalled for more than 15 minutes on a single OpenAI call and was killed; the OpenAI client now times out after 30 s with one retry (`src/conversation.js`), so a stalled call costs a turn, not the session. The server now covers the misses seen in earlier runs: card lines are built by the server, a wallet number resolves to the wallet as the user saw it in the picker, payment terms imply an invoice or bill, an `item_code` without digits is refused, a payment that skips an open invoice is refused, the "Heard:" echo is added when missing, and the outreach preview is shown verbatim from the tool. What's left is model-side and intermittent: an occasional question before `update_draft`, a wrong category (e.g. 5900 instead of Travel; the card now shows that category, so the user can catch it), or a skipped tool call. The guards (card signature, wallet offers, stock checks, outreach gate) stop these from posting or sending anything wrong, but they can cost the user an extra turn. Treat a harness failure as "read the transcript".

## License

TBD.
