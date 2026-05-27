# Berpal — TODO

Living roadmap. Tick `[x]` as items complete. Order top-down by priority.
Both Claude and you can read and update this file across sessions.

---

## 🚧 In progress

_(nothing right now — pick from "Upcoming" below)_

---

## 🧪 Just landed — needs end-to-end test

### B2B link — credit-sale regression (post-direction-aware refactor)
Both directions verified live for the paid_now case (2026-05-27). Credit
case (no payment at time of post) hasn't been re-exercised since the
refactor — should land just the invoice on each side, no PE, no todo.

- [ ] Seller-init credit: `"sold 1ct sapphire to SS & co for $500 net 30"`
      → SI on A, proposal to B, Accept → PI on B, no todo, no PE
- [ ] Buyer-init credit: `"bought 1ct sapphire from SS & co for $500 net 30"`
      → PI on A, proposal to B, Accept → SI on B, no todo, no PE

### Multi-wallet pick path
Auto-resolve and 0-wallet (ask + create + opening-balance) paths both
work. The "responder has 2+ matching wallets" numbered-list path
hasn't been exercised yet.

- [ ] Set up a second cash/bank wallet on B for the test
- [ ] Run a paid-now link → confirm numbered prompt + index reply path
      (e.g. "1" or "2") → confirm name-match reply path ("HSBC")

### Failsafe layers 2 + 3 (cache freshness)
Layer 1 (in-proposeLink phone-lookup fallback) is live. Layers 2 + 3
would prevent the stale-cache miss before it happens.

- [ ] Layer 2: opportunistic `linkCounterparty` on the early-return paths
      in `customer.js` and `supplier.js` (cache-hit branches) so phone→user
      links self-heal on every contact touch
- [ ] Layer 3: on `provisionTenant`, sweep `counterparty_cache` for rows
      with the new user's phone and back-fill `linked_user_id` (so older
      tenants instantly "wake up" to the new user)
- [ ] One-shot backfill script for existing orphan cache rows

---

## 📋 Upcoming

### 1. Multi-step onboarding with business-type capture ✅
**Why**: Tailor the UI to what the user actually does. Service businesses don't need an Inventory tab. ERPNext is always provisioned with `enable_perpetual_inventory: 1` so `business_type` is a pure UX flag — togglable later with zero ERPNext migration.

- [x] Update `provisionTenant`: always set `enable_perpetual_inventory: 1` on the new Company (regardless of business_type)
- [x] Add `business_type` column to `users` table (enum: `service` / `product` / `both`)
- [x] Add other onboarding columns: `entity_type`, `nature_of_business`, `tax_id`, `address_line1/2`, `city`, `state_province`, `postal_code`
- [x] Refactor `/onboarding` into 3 steps in one page (client state, no extra routes):
  - [x] Step 1: business type + entity type + business name + nature
  - [x] Step 2: country + currency + tax id + address (structured)
  - [x] Step 3: your name + email + cash wallet + 0..N banks (with opening balances)
  - [x] Back / Continue navigation with progress indicator
- [x] Pass full payload to `/api/onboarding` → persist all fields in same UPSERT
- [x] `getAppContext()` returns business_type + all onboarding fields alongside user
- [x] Surface `business_type` + new fields on `/settings` (read-only display; editable later in #8)
- [x] Reusable `CountryPicker` (flag dropdown for non-phone use) + `CurrencyPicker`
- [x] IP-detected country + auto-suggested default currency by country
- [x] Cash + bank accounts auto-created in ERPNext as part of provisioning
- [x] Opening balance JEs posted automatically when non-zero (FX-aware for non-default-currency wallets)

### 2. Conditional inventory + services menu ✅
- [x] Pass `business_type` from layout into `Shell.js`
- [x] Hide `/inventory` nav link when `business_type === 'service'`
- [x] Hide `/services` nav link when `business_type === 'product'`
- [x] `both` (and legacy null) show both
- [x] Added `scripts/set-business-type.js` for seeding test users

### 3. Inventory + Services pages (read-only, ERPNext-backed) ✅
- [x] New query helper `src/erp-query/items-list.js` — wraps ERPNext `Item` + `Bin`
- [x] New query helper `src/erp-query/item-detail.js` — header + bins per warehouse + Stock Ledger Entries + invoice appearances
- [x] `/inventory` list page (paginated 50/page, sticky stock column)
- [x] `/inventory/[code]` detail page (stock per warehouse, recent movements, sold/bought on)
- [x] `/services` list page (mirror of /inventory but non-stock)
- [x] `/services/[code]` detail page (header + recent invoice appearances)
- [ ] Search by code/name (URL `?q=`) — deferred to filters pass (#6)
- [ ] **Multi-tenancy note**: ERPNext Item is site-global, not company-scoped. All users currently see all items. Will need User Permissions or per-company Item Group during provisioning to fix.

### 4. Bot awareness of business_type ✅ (partial)
- [x] Bot reads `business_type` at conversation init (already in users via `SELECT *`)
- [x] Prompt rules conditional on business_type — service users not asked
      for SKU/qty; product users expected to provide item code + qty + rate;
      both = infer per transaction
- [ ] Replace `GEN-SALE` placeholder Item with real per-SKU Items from
      inventory for product/both (so /inventory populates from sales)
- [ ] `lookup_item` tool (parallel to `lookup_counterparty`) for product/both

### 5. Remaining ERPNext doctype handlers ✅
- [x] Transfer JE (`direction='transfer'`) — DR dst / CR src, same-currency
      only for v1, voucher_type='Bank Entry'
- [x] Advance Payment Entry (`advance_given` / `advance_received`) — Payment
      Entry with no references[]; sits as unallocated on the party ledger
- [x] Bot tool fields added: `party_type`, `transfer_destination_account_code`,
      `transfer_destination_wallet_name`
- [x] Dispatcher cases wired in `src/erp-sync/index.js`

### 6. Filters + pagination on more list pages ✅ (high-value done)
- [x] `/transactions` filters: `?type=`, `?from=`, `?to=`, `?q=` via reusable
      TransactionFilters component (URL-state, debounced, preserved on paginate)
- [x] `/contacts` search: reusable SearchBox component, `?q=` filters
      name/phone/email
- [ ] `/customers`, `/suppliers` — same SearchBox pattern (lower priority
      since /contacts is now canonical)
- [ ] `/expenses` — usually a short list, can skip until needed
- [ ] `/accounts/[name]` ledger — paginate (currently capped at 200 entries)

### 7. Live OTP delivery (Meta approval pending)
- [ ] Twilio Content Template `berpal_otp_v3` — confirm Meta approved it
- [ ] Flip `TWILIO_ENV=live` in `.env` (gating in `src/auth/otp.js` handles the rest automatically)
- [ ] Update `/login` page hint copy to remove sandbox-join instructions

### 8. Editing (write-side web)
**Why**: Bot is primary write path, but web edits cover edge cases (fix wrong customer name, delete bad entry, etc.)

- [ ] `/customers/[name]/edit` — name, group, contact
- [ ] `/suppliers/[name]/edit` — same
- [ ] Delete/void transactions
- [ ] Confirm modal pattern (reusable)

### 9. Deploy + production hardening
**URL architecture (decided 2026-05-18)**: subdomain-per-app. Berpal lives at
`berpal.ber.fun` (or `app.ber.fun` if we want to keep berpal.com elsewhere).
Apex `ber.fun` reserved for a marketing/landing page. Future apps get their
own subdomains. Zero code changes needed — no Next.js basePath gymnastics.

- [ ] Deploy web + bot to Railway (or Vercel for web, Railway for bot)
- [ ] DNS: A record / CNAME for `berpal.ber.fun` → deployment target
- [ ] Set `APP_URL=https://berpal.ber.fun` in production env
- [ ] Set Twilio WhatsApp webhook URL to `https://berpal.ber.fun/api/webhook`
- [ ] Stable webhook URL means we can finally retire ngrok for live testing
- [ ] `SESSION_SECRET` rotation strategy
- [ ] Error monitoring (Sentry or equivalent)
- [ ] Log retention policy (no chat content in prod logs)
- [ ] Health-check endpoint
- [ ] Audit for any localhost-baked assumptions (done once 2026-05-18 — clean.
      Only `whatsapp.js` had a placeholder URL, now env-driven via `APP_URL`)

### 10. Commit hygiene
- [ ] Group the big uncommitted blob into clean commits before next major feature:
  - [ ] Web app scaffold (Next 16 + Tailwind + auth + layout)
  - [ ] Web dashboard pages
  - [ ] Purchase Invoice + supplier handlers
  - [ ] Opening Balance JE + wallet auto-creation
  - [ ] Helper scripts (provision.js, check-erpnext-perms.js, etc.)

---

## ✅ Done

### Web app foundation
- [x] Next.js 16 + React 19 + Tailwind v3 setup (v4 ditched — Turbopack/lightningcss on Windows is fragile)
- [x] App Router with `(app)` route group for authenticated shell
- [x] Auth: OTP via WhatsApp (sandbox) with bcrypt-hashed codes, 10min TTL, rate limits
- [x] iron-session cookies (`berpal_session`)
- [x] `/login` with country picker (libphonenumber-js + ipapi.co IP geo) → OTP step
- [x] `/onboarding` single-step form → `provisionTenant`
- [x] Smart `/` router (session-aware redirect)
- [x] Sidebar shell with mobile hamburger drawer + active-link highlight
- [x] Logout

### Tenant provisioning
- [x] `provisionTenant`: ERPNext Company + User + API keys + FX account + Postgres user row, idempotent on phone
- [x] Interactive CLI `scripts/provision.js`

### Dashboard read-only pages
- [x] `/dashboard` — Cash/AR/AP stats (default currency headline w/ ~approx prefix, per-currency breakdown with flag rows), recent activity
- [x] `/transactions` — list with paginated 50/page (URL `?page=N`)
- [x] `/transactions/[doctype]/[name]` — detail with line items / refs / accounts per doctype
- [x] `/wallets` — Cash/Bank/CC accounts with balances
- [x] `/expenses` — operating expenses only (COGS correctly excluded)
- [x] `/accounts` — chart of accounts tree
- [x] `/accounts/[name-or-number]` — ledger with running balance (URL accepts account_number or full name)
- [x] `/customers` + `/customers/[name]` — list with AR + detail
- [x] `/suppliers` + `/suppliers/[name]` — list with AP + detail
- [x] `/settings` — profile + business + WhatsApp bot info

### Shared components
- [x] `Shell` (sidebar + mobile drawer + active highlight)
- [x] `PageHeader`, `Card`, `Empty`
- [x] `TransactionsTable` (shared by dashboard + /transactions)
- [x] `Pagination` (modular: basePath + query props)
- [x] `Flag` (flag-icons SVG sprites)
- [x] `format.js` helpers (money, compactMoney with k/m, date, friendlyAccountName, accountUrl, etc.)
- [x] FX cache (`convertToBase` with React.cache, uses frankfurter.app)

### Polish
- [x] Mobile-responsive sidebar (hamburger drawer)
- [x] Active-page highlight in sidebar
- [x] Horizontally-scrollable tables with sticky right value column + left padding
- [x] Text ellipsis-truncation on long names (no wrapping)
- [x] Stat card breakdown rows: flag + currency code + amount, sorted with default currency first
- [x] Approximation prefix `~` when multi-currency totals are converted
- [x] Compact format for big numbers (`$1.5k`, `฿1.5m`) above 10k threshold

### ERPNext doctype handlers
- [x] Sales Invoice (write + read, FX-aware, per-currency Debtor auto-creation)
- [x] Purchase Invoice
- [x] Payment Entry (Receive + Pay, with invoice allocation; ERPNext handles FX gain/loss natively)
- [x] Journal Entry (cash income/expense, `buildJournalTitle` multi-currency aware)
- [x] Opening Balance JE
- [x] Auto per-currency wallet creation for Payment Entry
- [x] Counterparty cache + fuzzy short-name resolution

### Query helpers
- [x] `open-invoices`, `balance-with-counterparty`, `cash-bank-balance`, `counterparty-details`
- [x] `recent-transactions` (+ count for pagination), `account-ledger` (+ resolveAccountParam)
- [x] `customer-list` (with AR), `supplier-list` (with AP), `accounts-list`, `expense-summary`

### Other
- [x] `business_type` UX renaming: Invoice / Purchase / Expense / Receipt / Payment / Cash (was Bill / Journal)
- [x] Cost of Goods Sold filtered out of `/expenses`

### B2B linked transactions — bidirectional flow (Phase 2, refactored 2026-05-27)
Both sale-initiated AND purchase-initiated linking work end-to-end with
Twilio Quick Reply buttons and inline wallet pick. Schema-symmetric:
`seller_*` columns always refer to the SI side, `buyer_*` to the PI
side, and `initiated_by_buyer` flag drives every direction-specific
branch. See `memory/project_b2b_bidirectional_link.md` for the
architecture map.

- [x] Schema: `linked_transactions` table with direction flag + payment
      context (`seller_payment_account_code`, `seller_wallet_label`,
      `seller_wallet_type`) + Twilio MessageSid columns
- [x] Twilio Content Template `b2b_link_proposal` (Accept / Decline
      quick-reply buttons) — replaces the old "yes LINK-N" text fallback
      (text still works for sandbox, but is no longer in the prompt body)
- [x] `proposeLink` takes a clean initiator/responder signature, persists
      direction, sends template, stores outbound MessageSid
- [x] `tryHandleLinkCommand` routes button replies via
      `OriginalRepliedMessageSid` against `proposal_message_sid` (works
      across multiple pending links for the same buyer)
- [x] `confirmLink` branches by direction — creates a PI mirror on
      seller-init Accept, or an SI mirror on buyer-init Accept; both
      paths share the same wallet-pick follow-up
- [x] Wallet-pick state machine (`src/links/buyer-wallet-pick.js`):
      auto-posts the PE when exactly one matching wallet exists, asks
      inline when 0 or 2+ — wording flips correctly ("paid from" vs
      "received to") and PE direction matches (expense vs income)
- [x] 0-wallet path: bot asks for bank/wallet name, creates the leaf via
      shared `resolveWalletAccount`, then mirrors the `create_wallet` UX
      by asking for an opening balance — books via shared
      `recordOpeningBalance` if > 0
- [x] Fallback `unrecorded_link_payment` todo enqueued whenever the PE
      didn't post atomically; auto-deleted when the inline pick succeeds
- [x] `/todos/[id]` resolver also posts the payment (existing kind, works
      on both directions)
- [x] Failsafe layer 1: in-`proposeLink` phone-based lookup that catches
      stale `counterparty_cache.linked_user_id` rows
- [x] Name normalization (`src/links/name-match.js`) — `&` ↔ `and` +
      lower + whitespace; applied in LLM-time `_counterparty_known`
      check, customer/supplier fuzzy cache, and ERPNext `&`↔`and` swap
      retry on fallback queries
- [x] Initiator gets a "✅ Your invoice/purchase X with <party> was
      accepted/declined" WhatsApp notification (party name, no "their
      ref" noise)
- [x] Server-canned save reply (bypasses LLM rendering): the
      `save_transaction` tool attaches `_saved_reply` and the loop
      short-circuits — fixed `Saved ✓\nInvoice: X\nPayment: Y` format
      every time, immune to BLUFF false-positives
- [x] Sidebar Todos badge updates dynamically after resolve (server
      `revalidatePath` + client `router.refresh()`)
- [x] Helper scripts: `create-b2b-link-template.js`,
      `resend-link-proposal.js`, `claim-pending-by-phone.js`,
      `inspect-linked-transactions.js`

---

## 💡 Ideas / parking lot

_(not committed to building — capture and forget until they re-surface)_

- Dark mode — follow `prefers-color-scheme` automatically (Tailwind's `dark:`
  variant + a small ThemeProvider). Design tokens in globals.css already use
  CSS custom properties so a `:root.dark { … }` block can swap them cleanly.
  Per-user override (Light / Dark / System) in /settings later.
- P&L view (Revenue → COGS → Gross Profit → Operating Expenses → Net Profit) — would be a real first "report"
- Balance Sheet view
- Cash-flow forecast view (based on open invoices + due dates)
- Customer statement PDF (send via WhatsApp)
- Multi-warehouse-aware bot prompts ("which warehouse?" only when >1 exists)
- Recurring transactions / templates
- Tax handling (VAT/GST per region)
- ERPNext webhook → bot for sync-back when user edits via ERPNext UI directly
- Audit log table for who-edited-what (compliance)
- Self-serve invite users to the same Company (multi-user per tenant)
- Backup/export (CSV download of any list page)
