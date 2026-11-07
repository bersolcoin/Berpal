# ber-accounting

WhatsApp-first bookkeeping bot for small businesses. Users log transactions in plain language ("paid 850 for lunch", "sold ruby 7.68ct to Jameel Crest Gems for 45000 USD net 30"), the bot extracts the structured fields, shows a confirmation card, and posts the transaction to **ERPNext** as the accounting backend.

> **Status:** all transaction flows post to ERPNext: sales invoices, purchase invoices (bills), payments against either (incl. partial and multi-currency), cash income/expense, wallet transfers, advances given/received and opening balances, with Thai VAT/WHT, multi-line invoices and per-stone stock. Receipt photos/PDFs and voice notes are read before the model sees the message. The bot can send invoices and payment reminders to customers (with a consent gate), and a scheduler sends a morning digest. Everything is tested against an in-memory ERPNext stand-in (`npm test`) and the model's tool choices against the real OpenAI API (`npm run test:llm`); **none of the new features has been run against a real ERPNext instance or a live Twilio sender yet.**

## Architecture

WhatsApp (Twilio) or LINE → that channel's signed webhook (`src/channels/twilio.js` at `/webhook`, `src/channels/line.js` at `/line/webhook`; mounted by `server.js` for every configured channel) → one normalised inbound message → `src/whatsapp.js` (per-sender queue, onboarding for unknown addresses, chitchat short-circuit, media intake: photos/PDFs → vision scan line, voice notes → transcript, shared contacts → contact line) → conversation engine (`src/conversation.js`: system prompt + `src/prompt/*` sections, GPT-4o-mini tool loop) → tools (`src/tools/*`) → write side: per-doctype handlers in `src/erp-sync/` POST to ERPNext via `src/erpnext.js`; read side: `src/erp-query/` reads live balances, invoices and stock. Every reply goes back over the channel the user's address belongs to (`src/channels/address.js`: `+66…` is WhatsApp, `line:U…` is LINE; `src/channels/index.js` holds the contract). Outbound messages to customers go through `src/outreach/` behind a preview → yes gate, always over WhatsApp (customers are reached by phone number, whatever channel the owner uses); scheduled sends (digest, reminders) run from `src/jobs/scheduler.js` inside the same process. Postgres holds identity, conversation state, lookup caches, receipt images awaiting attachment, and job/outreach logs only — **no accounting truth lives in Postgres** (that's all in ERPNext). Multi-tenant model: one shared ERPNext instance with N Companies, one Company per user.

Nothing is posted without a confirmation card. `request_confirmation` builds the card's lines on the server (`src/tools/card.js`; the model copies them verbatim) and signs the draft; when that turn ends, `handle()` stores the signature of the card the user saw in `confirmation_pending`. `save_transaction` on a later turn refuses unless the draft still matches it — re-signing in the save turn doesn't count. The only card-less save is the second half of the missed-sale flow: the back-dated invoice is carded and confirmed like any other draft, and in that same confirm turn the payment that settles it is chained without a second card. If OpenAI fails after something was saved or cancelled in a turn, the draft is reset and the reply says what was saved, so a repeated "yes" can't post twice. Server-only draft keys (`confirmation_*`, `wallet_options`, `outreach_preview`) can't be set by the model. When the bot's last reply listed wallets by number and the user answers with just that number, the server resolves it to the wallet shown on that line (matched by name), and the model can't swap it in that turn; any other bare number is left to the model.

## Features

**Logging transactions.** Type it the way you'd say it: "paid 850 for lunch", "sold ruby 7.68ct to Jameel for 45,000 USD net 30", "got a bill from Acme for 12,000, due in 15 days". The bot fills in what it can, asks only for what's missing (wallet, a new contact's phone, payment terms), shows a card, and posts to ERPNext when you tap Confirm. Questions ("what's outstanding?", "how much does Jameel owe me?", "how much money do I have?") are answered from live ERPNext data.

**Receipts, PDFs and voice notes.** Send a photo or PDF of a receipt or bill and the bot reads the merchant, date, total, VAT and invoice number, then runs the normal flow; when you confirm, the image is attached to the saved ERPNext document (private file). Send a voice note and it's transcribed and handled like a typed message — the reply opens with what it heard. Formats: JPEG, PNG, HEIC/HEIF (converted to JPEG on intake; if conversion fails the user is asked to resend as JPEG), WebP with a caption, PDF, voice notes, shared contacts; stickers are ignored.

**Sending invoices and reminders to customers.** "Send it to Jameel" shows exactly what will go out (recipient, number, text, invoice PDF, PromptPay QR for THB amounts) and sends only after your yes on the very next message. "Remind everyone who's overdue" does the same per customer. With automatic reminders switched on (`set_payment_settings`), customers with invoices overdue or due within 3 days get one reminder message every 3 days at most. Customer numbers come only from the contacts you entered (a shared contact, a typed number, `create_contact`); the bot never copies a phone or email from ERPNext into your contacts.

**Morning digest and schedule.** Every morning (08:00 local by default, change with "send my digest at 7:30") the bot sends your cash position, overdue items, what's due in the next 7 days, and yesterday's totals. Timezone and reminder time are adjustable in chat.

**Thai VAT, withholding tax, line items and stock.** Tell the bot once whether you're VAT-registered. VAT 7% (inclusive or on top) is computed by the bot, never by the model, and shown on the card as Net / VAT / Gross; WHT (1/2/3/5%, PND3/PND53) on bills and cash expenses shows what you actually pay the supplier. Invoices can carry several lines. Naming a stone or SKU ("PA2293") makes it a tracked stock item: buying it receives stock, selling it issues stock and books cost of goods sold, and "what's in stock?" lists what's on hand with its value.

**Trust layer.** Before each confirmation card the bot checks its own record of what it posted (`src/trust/`, table `trust_fingerprints`): the same receipt photo/PDF posted before (sha256 of the bytes) → "This receipt was already recorded as …"; same amount, currency, counterparty and direction within ±3 days (never the invoice/bill a payment settles) → "Looks similar to …"; plus flags for an amount (not a transfer between your own wallets) over 10× your 90-day median for that direction and above `TRUST_LARGE_AMOUNT_FLOOR` (default 20,000 in the reporting currency), a future or 90+-day-old date, a round cash expense of 10,000 or more, and a first payment to a new payee at or above the floor. Up to three warnings are added to the card under "⚠ Please check before confirming:"; they never block — confirming the card is the override, and the prompt tells the model to cancel instead when you say it's a duplicate. The warnings are part of the card signature, so if they change, the card is re-sent. Every document the bot posts gets an ERPNext Comment "Berpal: posted from WhatsApp, awaiting accountant review" (plus the warnings), and a local `review_status = 'pending'` row. A failed Comment is logged and doesn't fail the save.

**Accountant review queue.** "What's waiting for my accountant?" lists the bot-posted documents nobody has marked reviewed yet, oldest first, one line each (`ACC-JV-2026-00012 · 3 Nov · expense THB 1,200.00 · Foodland ⚠`, the ⚠ meaning the card carried warnings), with "…and N more" past 30. "Mark ACC-JV-2026-00012 reviewed" (or "the accountant checked these: …") sets the local row to `reviewed` (who, when, an optional note) and adds an ERPNext Comment "Berpal: reviewed by owner via whatsapp on 2026-11-07". "All reviewed" is allowed only right after a listing: the tool must be passed the total that listing returned, and if the queue changed in between nothing is marked; the tool hands back the current queue so the bot shows it and asks again with the new total. Nothing here touches the ledger, so there is no confirmation card; a bare "yes" is never a review. The morning digest ends with "Awaiting accountant review: N (oldest 3 Nov)" when the queue is non-empty, but that line alone never triggers a digest. (`src/trust/review.js`, tools `list_review_queue` and `mark_reviewed`.)

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

## Deploying

See [DEPLOY.md](DEPLOY.md): Docker / Docker Compose, Fly.io and Railway, Twilio webhook setup, `GET /health`, backups and rollback. `npm run check:env` validates the environment the way the server does at boot.

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

## Onboarding

A WhatsApp number or LINE user with no `users` row goes through a short signup in chat (`src/onboarding/`). It is a fixed state machine — no LLM call — so an unknown number costs a few queries and the replies are predictable.

1. business name (2–80 characters, at least one letter or digit, no `<` `>` — ERPNext refuses them in a Company name) → 2. country (TH default; `TH/MY/SG/ID/VN/PH/AU` or the name; sets default + reporting currency and timezone) → 3. VAT-registered yes/no → 4. tax ID (Thai: 13 digits with the official check digit, dashes/spaces allowed; elsewhere 5–20 characters) or `skip` → 5. accountant name and phone (optional, `skip`; the phone is normalised to `+<country code>…`) → 6. privacy notice (PDPA: what is stored, where, why, how to delete; the receipt retention it states is `RETENTION_DAYS` from `src/media/store.js`), answered with `I agree` / `agree` / `ตกลง`. A refusal (`no`, `I don't agree`, `ไม่ตกลง` …) ends the signup and deletes the session; anything else re-asks.

Every step accepts `back` and `cancel` (cancel deletes the session; nothing is kept). A blank/media-only message, or the invite code sent again, re-asks the current question. Progress lives in `onboarding_sessions` (`src/migrations/080-onboarding.sql`); a session untouched for 7 days is dropped (its answers were collected before consent). Answers to steps 4–5 (tax ID, accountant) are logged as `[onboarding step N answer]`, never verbatim; logging for registered users is unchanged. On consent the bot inserts the `users` row with `subscription_status = 'pending_provisioning'`, `consent_at`, `consent_version` (`2026-11-pdpa-v2` — bump `CONSENT_VERSION` in `src/onboarding/messages.js` whenever the notice text changes) and `onboarding_source` (`whatsapp` or `invite:<code>`), replies "Thanks — your books are being set up…", and logs `[onboarding] NEW USER pending provisioning: id=… name=…` (phone as the last 4 digits only). Until provisioned, the user gets "Still setting up your books — hang tight." instead of the LLM.

**Who can sign up.** `ONBOARDING_MODE=closed` (the default when `NODE_ENV=production`) answers unknown numbers with an invite-only message unless the message is, or contains as a whole word, one of `ONBOARDING_INVITE_CODES` (comma-separated, trimmed, case-insensitive — `Hi, my code is GEMS` works). `open` (the default elsewhere) lets anyone start. Every unknown number gets at most 20 messages a day (UTC); after that the bot stays silent until the next day.

**Provisioning** (operator, after the log line):

```bash
node scripts/provision-user.js --list-pending
node scripts/provision-user.js --user 12 --dry-run          # prints the plan; no ERPNext call, no DB write
node scripts/provision-user.js --user 12 [--company "Siam Gems Co., Ltd."] [--abbr SG] [--notify]
```

It creates the ERPNext Company if missing (name = the business name unless `--company`; abbreviation derived from the name unless `--abbr` (`U<id>` when the name has no Latin letters, e.g. Thai), made unique; `default_currency` = the user's reporting currency; the country; chart of accounts **"Standard with Numbers"** — the bot's category mapping in `src/erp-sync/common.js` needs the numbered chart), runs the same setup as `smoke-erpnext --preflight --fix` (`scripts/lib/company-setup.js`: tax group and Output VAT / Input VAT / WHT Payable, a second-currency receivable, Stores warehouse, Products item group, GEN-SALE / GEN-PURCHASE), then sets `erpnext_company`, the API credentials, `subscription_status = 'active'` and `subscription_expires_at` = one year out (a re-run on an active user keeps a still-valid expiry). It refuses a Company name another `users` row already points at (case-insensitive) — two users with the same business name would otherwise share one ledger; pass `--company` with a distinct name. `--notify` WhatsApps the user that the books are ready. There is no approved template for it, so it is free-form: delivered only if the user messaged in the last 24 hours (Twilio returns a SID either way; the script says so). Otherwise tell them another way. Re-running is safe; an existing Company with a different currency is refused.

**Pilot mode:** the user row gets the **admin** `ERPNEXT_API_KEY` / `ERPNEXT_API_SECRET`. Those keys reach every Company on the instance — the bot scopes itself to `erpnext_company`, ERPNext does not. Before onboarding users who must be isolated from each other, give each Company its own ERPNext user (User Permission on the Company) and store that user's keys instead.

**Deleting.** A registered user who sends "delete my account" is asked to reply `DELETE` (within 15 minutes; anything else keeps the account). Confirming sets `subscription_status = 'deleted'`, clears the tax ID, accountant details and stored API keys, deletes stored receipts and logged messages, and leaves the ERPNext ledger alone (the accountant keeps it as the bookkeeping record). Later messages get an "account closed" reply.

## WhatsApp templates and the 24-hour window

WhatsApp delivers a free-form business message only if the recipient messaged your number in the last 24 hours. Outside that window Twilio still **accepts** the message and returns a SID; delivery fails later (error 63016), and only the status callback (`POST /twilio/status`, needs `PUBLIC_BASE_URL`) records it. Anything the bot starts — digests, invoices, reminders — therefore needs an approved template in production. Set the content SIDs (and, for outreach, the approved body text so the preview shows the real wording):

| Template | Env var | Variables |
|---|---|---|
| Confirmation card (Quick Reply buttons) | `TWILIO_CONFIRMATION_CONTENT_SID` | the card text — create with `npm run create-template` |
| Morning digest | `TWILIO_DIGEST_CONTENT_SID` | `{{1}}` date (e.g. "Tue 3 Nov"), `{{2}}` body on one line, sections joined by " \| ", ≤ 900 chars. Suggested body: `Your books, {{1}}: {{2}}` |
| Invoice | `TWILIO_INVOICE_CONTENT_SID` (+ `TWILIO_INVOICE_TEMPLATE_TEXT`) | `{{1}}` customer, `{{2}}` amount, `{{3}}` due date, `{{4}}` exactly one PDF URL |
| Payment reminder | `TWILIO_REMINDER_CONTENT_SID` (+ `TWILIO_REMINDER_TEMPLATE_TEXT`) | `{{1}}` customer, `{{2}}` total, `{{3}}` statement ("REF THB x N days overdue (due D); …"); no link variable, no PDFs |

Without a content SID: the digest is sent free-form only if the user wrote in the last 23h (otherwise the run is `skipped`); invoices and reminders go free-form (text + up to 3 PDFs + QR, one attachment per WhatsApp message) and the preview warns about the window. The PromptPay QR always follows as a free-form media message. Variables can't contain newlines or tabs (flattened to spaces). In the sandbox the customer must also have joined the sandbox.

### LINE

LINE is an optional second channel for the bot's own users (`src/channels/line.js`); a LINE user is stored as `line:<userId>` (LINE never shares a phone number). Customer outreach (invoices, reminders) still goes out over WhatsApp, since customers are reached by phone number.

Setup, in the [LINE Developers console](https://developers.line.biz/console/):

1. Create a provider and a **Messaging API** channel (this also creates a LINE Official Account).
2. **Basic settings → Channel secret** → `LINE_CHANNEL_SECRET`. **Messaging API → Channel access token (long-lived)** → issue → `LINE_CHANNEL_ACCESS_TOKEN`. Set both or neither; one alone stops the boot.
3. **Messaging API → Webhook URL** = `<PUBLIC_BASE_URL>/line/webhook`, turn on **Use webhook**, then press **Verify** (LINE posts a signed body with no events; the bot answers 200).
4. In the LINE Official Account Manager (**Response settings**), turn **off** auto-reply messages and the greeting message, so LINE's canned replies don't answer alongside the bot. Adding the bot as a friend counts as a "hi", which starts onboarding; unblocking it does not (the user has talked to the bot before).

Every webhook must carry a valid `X-Line-Signature` (base64 HMAC-SHA256 of the raw body with the channel secret; 403 otherwise; bodies over 1 MB get 413). The bot answers 200 before processing, so LINE's optional webhook redelivery (off by default) rarely triggers. `GET /health` adds a `line` check (`GET https://api.line.me/v2/bot/info` with the access token) when both variables are set.

Limits:

- **Reply vs push.** A reply token is single-use and LINE only guarantees it for one minute; the bot replies with it when it answers within 50 s, else it **pushes** (also when LINE answers "Invalid reply token"). Pushes (and everything the bot starts: digests, "books are ready") count against the Official Account's monthly message quota, which is small on the free plan; past it, pushes fail until the next month or a plan upgrade.
- No message templates or 24-hour window, and no delivery receipts: a message LINE accepted is assumed delivered.
- No contact sharing, no captions on photos (send the photo, then type the details), no location. A video gets the "can't read that kind of file" reply. Photos, voice messages and PDF / JPEG / PNG files are read; the bot can't send files, so invoice PDFs it sends over LINE arrive as links. Long replies are split into 5,000-character messages. Stickers are ignored. Only 1:1 chats; groups and rooms are ignored.
- Confirmation cards use LINE quick-reply buttons (✅ Confirm / ✏️ Edit / ❌ Reject) that send `confirm` / `edit` / `reject`, the words the WhatsApp card's buttons send.

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

New jobs export `{ name, defaultTime, window?, timeoutMs?, enabled?(user), run(user, { erp, channel, twilio, now, clock, signal }) }` (`channel` is the user's own channel from `src/channels`; `twilio` is the legacy alias for the same object; the digest checks `channel.supportsTemplates` and pushes plain text on LINE); see the header of `src/jobs/scheduler.js`.

## Project layout

```
server.js                   Express: POST /webhook, POST /twilio/status, scheduler start/stop
src/
  webhook.js                /webhook handler + X-Twilio-Signature check
  whatsapp.js               phone → user routing, per-sender queue, media + vCard lines, chitchat short-circuit
  onboarding/               in-chat signup state machine, account replies (pending / closed / delete), Thai tax-id checksum, country map
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
  media/                    intake (download, HEIC → JPEG, vision scan, transcription), blob store, attach-to-ERPNext
  outreach/                 send invoice / reminders: planning, PromptPay QR, phone normalisation, consent gate
  jobs/                     scheduler + *.job.js (digest, reminders, cleanup)
  migrations/               SQL migrations applied by db.migrate()
  counterparties.js         contacts ↔ ERPNext Customer/Supplier (one contact can be both)
  wallets.js                cash/bank/credit-card wallets ↔ ERPNext Accounts
  erpnext.js                thin REST client for ERPNext (timeouts, optional AbortSignal, PDFs, uploads)
  exchange.js               frankfurter.app FX rates
  channels/
    index.js                channel contract + registry (forAddress, configured)
    address.js              user addresses: E.164 for WhatsApp, line:<userId> for LINE
    twilio.js               WhatsApp over Twilio: sender, inbound normalisation, media download, webhook
    line.js                 LINE Messaging API: reply/push, quick-reply card, content download, webhook
    line-signature.js       X-Line-Signature HMAC check
  twilio-client.js          thin re-export of the Twilio sender (tests stub it)
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
  smoke-erpnext.js          end-to-end smoke test against a real ERPNext Company (npm run smoke:erpnext)
  lib/smoke-helpers.js      its pure helpers (arg parsing, checks, report), unit-tested
  provision-user.js         create + set up the ERPNext Company for an onboarded user and activate them
  lib/company-setup.js      the --fix setup (tax accounts, warehouse, items) shared with provisioning

test/
  fake-erpnext.js           in-memory ERPNext that enforces the validations the bot relies on
  flows.test.js             end-to-end tool flows (Postgres via pg-mem)
  media.test.js, outreach.test.js, jobs.test.js, tax-items.test.js   per-feature tests
  onboarding.test.js        signup flow, invite gate, rate limit, delete, provision-user, HEIC intake
  thai-tax-id.test.js       tax-id checksum, phone and country parsing
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

### Verifying against a real ERPNext

`npm run smoke:erpnext` (`scripts/smoke-erpnext.js`) runs the bot's own code paths — `wallets.create`, `saveDraft` from `src/erp-sync`, the `src/erp-query` modules, `erp.getPdf` / `uploadFile` — against a **real** ERPNext Company, then fetches every posted document and its GL Entries and checks them (the same figures `test/flows.test.js` and `test/tax-items.test.js` assert against the fake). It reads `ERPNEXT_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET` and `ERPNEXT_COMPANY_DEFAULT` from `.env` (`--company "Name"` overrides); Postgres isn't needed (the cache tables live in pg-mem for the run).

**Use a dedicated test Company** (e.g. "Smoke Test Co", THB, "Standard with Numbers" chart). The flows refuse to run against a Company that has GL Entries the smoke test didn't create unless you pass `--allow-live`. Everything the run creates is named `SMOKE-…` (stock items become `SMOKEPA2293-<abbr>`, following the bot's item-code rule).

```bash
npm run smoke:erpnext -- --preflight          # setup checks only: PASS/WARN/FAIL + a fix hint per line
npm run smoke:erpnext -- --preflight --fix    # also create what the bot would create anyway (tax and per-currency accounts, GEN items, Products group, Stores warehouse)
npm run smoke:erpnext                         # preflight + flows a–l, then asks whether to clean up (TTY)
npm run smoke:erpnext -- --cleanup            # … and cleans up without asking
npm run smoke:erpnext -- --cleanup-only       # cancel + delete what the last run's report lists
```

Each step prints ✔ / ✖ (expected vs actual) or ⚠ for soft checks, and every ERPNext error with its server message — those messages are the point of the run. A JSON report goes to `--report` (default `./smoke-report.json`, git-ignored); the exit code is 1 when any preflight line FAILs or any step/check fails, 2 when refused. `--fix` never changes Company defaults or Settings. Cleanup cancels then deletes payments, invoices, JEs, files, items, parties and wallet accounts in that order; ERPNext keeps cancelled ledger rows, so the SMOKE- masters can only be deleted when Accounts Settings → "Delete Accounting and Stock Ledger Entries on deletion of Transaction" is on (a test-site-only setting; preflight reports it). Otherwise leave them — a re-run reuses them.

## Known limitations

**Not verified live.** Everything below the core flows has only run against the fake ERPNext and stubbed Twilio/OpenAI. In particular: PDFs sent to the vision model as a Chat Completions `file` part (if the live API rejects it, the user gets "couldn't read that receipt"; remove `application/pdf` from `kindOf()` in `src/media/index.js` to disable), the print format/`download_pdf` path, and real ERPNext stock/tax posting.

**Media**
- Receipt images are kept 7 days; a draft pending longer saves without its attachment. One receipt per draft (several photos produce several scan lines, but the draft holds one `receipt_media_id`). A failed attachment is logged, not retried.
- No "reading your receipt…" message: the user waits 2–5 s for vision, 1–3 s for transcription, and later messages from the same sender queue behind it. The queue is in-memory, per process: several instances would need a DB advisory lock or sticky routing.
- HEIC decoding (`heic-convert`, pure JS/wasm) runs in a short-lived `worker_threads` Worker (≈1.6 s for a 12 MP / 3.8 MB HEIC on an M-series Mac; ~100 ms worker start-up). The 15 s timeout terminates the worker, so the CPU is reclaimed and other senders are not stalled; the worker's JS heap is capped at 512 MB.
- Scan values, transcripts and vCard fields are flattened/sanitised so they can't fake synthetic lines or keys, but they still reach the model as data. A user can type a fake `[receipt scanned]` line in a caption; it only affects their own draft (attach is user-scoped) and nothing saves without the card.

**Onboarding**
- Not verified live with real WhatsApp users or a real ERPNext Company creation (`provision-user.js` ran only against the fake ERPNext, which records the Company but does not build its chart).
- Unattached receipt blobs are pruned when any user's next receipt is stored (`src/media/store.js`) and by the nightly `cleanup` job per user (`src/jobs/cleanup.job.js`), so the 7 days the privacy notice states holds on a quiet instance too, give or take the job's 03:00 window.
- "delete my account" keeps `outreach_log` rows (the customers' phone numbers the bot sent invoices/reminders to), alongside the ERPNext ledger they belong to.
- A closed account keeps its `users` row (phone is unique), so the same number can't sign up again without an operator.

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

**Trust layer**
- Only sees what the bot posted (documents entered in ERPNext directly aren't fingerprinted), and only from the day `070-trust.sql` ran: medians need 3+ postings in the last 90 days. "Similar" needs a counterparty, so two identical cash expenses with no counterparty aren't flagged (a re-sent photo still is, by hash).
- "New payee" means no earlier posting to that name and the contact is new (no contact row, or one added in the last 24 h), not strictly "created this turn": that would drop the flag on the confirming turn and change the card's signature.
- The receipt match is an exact sha256 of the stored bytes. WhatsApp re-compresses images, so a photo forwarded again, re-shared from the gallery or re-shot usually has different bytes and is NOT caught by hash (it may still be caught as "similar" when amount, currency and counterparty match). Re-sent PDFs and the same file sent twice are caught. No perceptual hashing yet.
- `trust_warnings` and `receipt_hash` are protected draft keys (`PROTECTED_DRAFT_KEYS`): the model can't set or clear them through `update_draft`, and dropping the warnings changes the card signature, so save_transaction refuses. The card *text* is still the model's (told to copy `card.lines` verbatim), so at the end of a card turn `handle()` appends any ⚠ line the reply left out (`withTrustWarnings`): the user always sees what the signature covers.
- Warnings are worked out when the card is built, not again at save. Fingerprints older than 180 days are pruned when a new one is written (no cleanup-job change), except rows still `pending` review: a queue nobody clears grows with every posting. Rows are small, and the digest line is the nudge.
- The review queue is owner-driven: the accountant doesn't message the bot, so "reviewed" means the owner said so in chat (the ERPNext Comment is the audit trail). Reviewing in ERPNext (resolving the Comment) does not change the local status, and a document deleted in ERPNext is still marked reviewed locally, minus its Comment. "All reviewed" compares counts, so a queue where one document was added and another marked in between still passes.

**Model reliability (gpt-4o-mini).** On the final tree, `npm run test:llm` passed all 99 checks in 2 of the 3 runs that finished. The third failed one check: on the voice-note turn the model called only `list_user_accounts`, skipping `update_draft`, then recovered and saved correctly. One further run stalled for more than 15 minutes on a single OpenAI call and was killed; the OpenAI client now times out after 30 s with one retry (`src/conversation.js`), so a stalled call costs a turn, not the session. The server now covers the misses seen in earlier runs: card lines are built by the server, a wallet number resolves to the wallet as the user saw it in the picker, payment terms imply an invoice or bill, an `item_code` without digits is refused, a payment that skips an open invoice is refused, the "Heard:" echo is added when missing, and the outreach preview is shown verbatim from the tool. What's left is model-side and intermittent: an occasional question before `update_draft`, a wrong category (e.g. 5900 instead of Travel; the card now shows that category, so the user can catch it), or a skipped tool call. The guards (card signature, wallet offers, stock checks, outreach gate) stop these from posting or sending anything wrong, but they can cost the user an extra turn. Treat a harness failure as "read the transcript".

## License

TBD.
