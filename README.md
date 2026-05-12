# ber-accounting

WhatsApp-first bookkeeping bot for small businesses. Users log transactions in plain language ("paid 850 for lunch", "sold ruby 7.68ct to Jameel Crest Gems for 45000 USD net 30"), the bot extracts the structured fields, shows a confirmation card, and posts the transaction to **ERPNext** as the accounting backend.

> **Status:** active development. Sales-invoice and cash-journal flows work end-to-end against ERPNext. Purchase-invoice, payment-entry (settlement), and transfer/opening-balance journals are next. The codebase is mid-refactor toward a modular `erp-sync/` + `erp-query/` + `tools/` layout — expect churn.

## Architecture (one paragraph)

WhatsApp → Twilio webhook → Express (`server.js`) → conversation engine (`src/conversation.js`) → OpenAI GPT-4o-mini with a tool-use loop → write side: per-doctype handlers POST to ERPNext via `src/erpnext.js`; read side: queries hit ERPNext for live balances. Postgres holds identity, conversation state, and lookup caches only — **no accounting truth lives in Postgres** (that's all in ERPNext). Multi-tenant model: one shared ERPNext instance with N Companies, one Company per user.

## Stack

- Node.js 18+ (uses native `fetch`)
- Express
- Postgres (developed against Railway-hosted)
- OpenAI Chat Completions API (function calling)
- Twilio WhatsApp Business / Sandbox
- ERPNext (REST API; tested against v14+)
- `frankfurter.app` for ECB reference FX rates

## Prerequisites

- Node.js 18 or newer
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

Point your Twilio WhatsApp webhook at `https://<your-ngrok>.ngrok-free.app/webhook` (HTTP POST).

## ERPNext setup notes

Before the bot can post invoices, the target Company in ERPNext needs:

- **Default Receivable / Payable / Cash / Income / Expense accounts** set (Company → Default Accounts tab). The bot auto-creates per-currency `Debtors USD`, `Creditors USD`, etc. on first use.
- **Exchange Gain/Loss Account** set (Company → Default Accounts). Required for multi-currency settlement; ERPNext posts FX diffs there automatically.

Run `node scripts/check-fx-account.js` to verify your Company's multi-currency setup.

## Project layout

```
src/
  server.js                 Express + /webhook
  whatsapp.js               phone → user routing, vCard parsing, chitchat short-circuit
  conversation.js           LLM tool loop + prompt (being refactored — see below)
  erpnext.js                thin REST client for ERPNext
  exchange.js               frankfurter.app FX rates
  twilio-client.js          REST API for Twilio (template + plain text)
  chitchat.js               regex-based pre-LLM filter
  vcard.js                  minimal vCard parser
  counterparties.js         find-or-create cache
  users.js, messages.js, db.js, log.js

scripts/
  migrate.js                run pending DB migrations + seed test user
  create-confirmation-template.js   register the Twilio Quick Reply card
  check-fx-account.js       verify ERPNext Company multi-currency setup
  list-receivables.js       list all Receivable/Payable accounts with currency
  ping-db.js                standalone Postgres connectivity test
  show-inv.js <name>        pretty-print an ERPNext Sales Invoice
  dedupe-wallets.js         find/clean duplicate user wallets
```

The `src/` tree is **being broken apart**. Target structure:

```
src/
  erp-sync/                 WRITE side, one file per ERPNext doctype handler
  erp-query/                READ side, one file per query type
  tools/                    LLM tool definitions + dispatch, one file per tool
  conversation.js           shrinks to LLM loop + prompt only
  …                         everything else stays
```

## Development

- `node scripts/ping-db.js` — confirm DB connectivity before debugging server-start issues
- `node scripts/migrate.js` — apply schema changes (idempotent)
- `node scripts/show-inv.js ACC-SINV-2026-00001` — verify an invoice landed in ERPNext correctly
- Set `LOG_MESSAGES=true` in `.env` to persist every WhatsApp message to the `messages` table for debugging

## License

TBD.
