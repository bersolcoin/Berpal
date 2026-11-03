# Lane D — Thai tax, line items, stock

## What was built

| Area | Where |
|---|---|
| VAT 7% on sales invoices, purchase bills, cash income/expense | `src/erp-sync/taxes.js`, `sales-invoice.js`, `purchase-invoice.js`, `journal-entry.js` |
| User's own VAT registration | `src/migrations/061-tax-settings.sql`, `src/tools/set-tax-settings.js` |
| WHT (1/2/3/5%, PND3/PND53) on purchase bills and cash expenses | `src/erp-sync/taxes.js`, payment guard in `payment-entry.js` (called from `validate.js`) |
| Multi-item invoices (`draft.items`) | `src/erp-sync/invoice-lines.js`, `src/tools/validate.js`, `update-draft.js` |
| Stock Items per SKU / stone id, stock moved by invoices | `src/erp-sync/items.js`, `src/migrations/060-items.sql` |
| Stock query | `src/erp-query/stock.js`, `src/tools/query-stock.js` |
| Prompt rules | `src/prompt/60-tax-items.js`, plus small edits to the INVOICE / BILL RULES and confirmation-card paragraphs in `src/conversation.js` |
| Tests | `test/tax-items.test.js` (expected values are worked out by hand, not taken from the code); `test/fake-erpnext.js` |

## Design decisions

### Rounding
`round2` in `src/erp-sync/common.js` (and `r2` in the fake) ports Frappe's `flt(x, 2)` using the default "Banker's Rounding (legacy)" method: `Math.round(Number((n*100).toFixed(8)))/100`. It first pre-rounds to 8 decimal places to remove float noise, then rounds an exact half up. The old `+ Number.EPSILON` version rounded half-satang values down. For example:
- WHT on 1,234.50 × 3%: the old code gave 37.03, ERPNext gives 37.04.
- VAT on 30.50: the old code gave 2.13, ERPNext gives 2.14.

If a site switches System Settings → Rounding Method to "Banker's Rounding" (half to even), its results differ from the bot's: for example 0.105 rounds to 0.10 there and 0.11 here. Keep the legacy default.

### VAT: the bot computes every figure and posts net rates plus an Actual VAT row
- **Amount:** `draft.amount` is the figure the user stated. With `tax_inclusive` it is the gross, otherwise the net.
- **Pure calculation:** `computeTotals(draft)` returns net, VAT, gross, WHT and due, plus each line's net and gross, without touching ERPNext. Each row's stated amount is `flt(qty × rate)`.
  - Inclusive: VAT = `flt(G × 7/107)` on the **document** gross G, and net = G − VAT. Backing VAT out per unit was wrong for qty > 1: 100 × 1.00 gave 7.00 VAT instead of the legal 6.54.
  - Exclusive: VAT = `flt(net × 7%)`.
  - Line amounts on the other basis are `flt(line × factor)`, with the last line taking the remainder, so the lines always add up to the document totals.
- **Posting:** each item row carries its **line net** (or its line gross when the VAT isn't claimable; see below). VAT is a `charge_type: 'Actual'` row with `tax_amount` set to the bot's figure.
  - ERPNext stores unit rates to 2 decimals, so a line amount may not divide evenly by its qty. In that case:
    - An untracked line is posted as qty 1 at the line amount, with the description "100 × pearl bead".
    - A stock line keeps its real qty, because the stock level must move by it. Its rate is rounded down, and a "Rounding" GEN row carries the leftover satang (less than qty × 0.01). On a purchase that row goes to the bill's expense account, so the stone's valuation can be under by those few satang.
  - I chose the Actual VAT row because ERPNext's inclusive maths changed between versions:
  - v14 from August 2024 and v15 compute the VAT as `flt(0.07 × Σ flt(amountᵢ/1.07))` and push the left-over cent to `grand_total_diff`, which posts to Round Off.
  - For 119 gross, ERPNext would post VAT 7.78 plus 0.01 to Round Off, while the card shows 7.79.
  - With an Actual row, the posted net, VAT, grand total and outstanding equal the card on every version.
  - The fake now models current ERPNext's inclusive behaviour (`grand_total_diff` to Round Off), and a test shows it, so a regression to `included_in_print_rate` would be caught.
- **Card:** `request_confirmation` returns `totals` {net, vat, gross, vat_rate, vat_claimable, wht, wht_rate, wht_form, payable_to_counterparty}. `base_amount` is the gross.
- **Rounded total:** `disable_rounded_total=1` is now set on **every** invoice. Without it, ERPNext rounds the outstanding to whole baht and the difference goes to Round Off.
- **Tax accounts** are matched by **exact** `account_name`. A `LIKE` match would pick up "Undue Input VAT", and a test covers that decoy.
  - An existing leaf account is used whatever its `account_type`.
  - A **group** with that name raises a clear error.
  - Missing accounts are created as `account_type: 'Tax'`:
    - Output VAT and WHT Payable go under **Duties and Taxes** (liability).
    - **Input VAT goes under Tax Assets**, or Current Assets if there is no Tax Assets group. It is an asset (ภาษีซื้อ).
  - The per-process memos are cleared when a save fails.

### Who may charge or claim VAT
- `users.vat_registered`: 1 = registered, 0 = not registered, NULL = never asked. It is set by `set_tax_settings({vat_registered, tax_id?})`.
- **Unknown status:** if a draft has `tax_rate > 0` and the status is NULL, `request_confirmation` tells the model to ask "Are you VAT-registered?" once.
- **Not registered:**
  - `tax_rate` on `invoice_issued` or cash income is refused. Under Revenue Code s.86/13, a non-registrant must not issue tax invoices.
  - On purchases and cash expenses the VAT is **not claimable**: the gross goes to expense.
- **Registered but the receipt is an abbreviated tax invoice** (`vat_claimable: false`, set by the media lane's scanner): also not claimable.
- **How non-claimable VAT is posted:**
  - On a bill, item rows are posted at **gross** and there is no VAT row. A stone is therefore valued at gross: under TAS 2 / TFRS for NPAEs, purchase tax you can't recover is part of inventory cost. Service lines carry the VAT in their expense.
  - On a cash Journal Entry the VAT is folded into the expense line.
  - WHT is still the bot's Actual row on the **pre-VAT** net; a test covers 10,700 posted with 300 WHT.
- The prompt keys VAT on the **user's** own registration, never on the counterparty's.

### WHT: an Actual Deduct tax row, not Tax Withholding Category
I considered two options:
1. **Tax Withholding Category + `apply_tds`.** This needs a category document per rate, rate rows per fiscal year, an account per company, and a link to the supplier. It also brings India's threshold and cumulative logic. On a fresh company over REST that is a lot of setup, and the result depends on supplier history.
2. **A Purchase Taxes and Charges row**: `add_deduct_tax: 'Deduct'`, `charge_type: 'Actual'`, `tax_amount` = `flt(net × rate)` computed by the bot, account **WHT Payable**, `description: 'WHT 3% (PND53)'`. **I chose this one.**
   - It works over plain REST on any company, and the deduction is visible on the bill.
   - It lowers `grand_total`, so the outstanding (what the supplier is owed) is gross − WHT.
   - GL: Dr expense net, Dr Input VAT, Cr WHT Payable, Cr Creditors (gross − WHT).
   - I used Actual rather than 'On Net Total' because with non-claimable VAT the item rows are posted at gross, so ERPNext's `net_total` includes the VAT, and that is not the WHT base.

What option 2 does not give you:
- No ERPNext TDS reports.
- No 50 Tawi certificate.
- One WHT Payable account. PND3 and PND53 are distinguished only by `wht_form` in the row description, so filings have to be split from the description.

Draft rules for WHT:
- Allowed rates are 1, 2, 3 and 5. `wht_rate: 0` clears WHT.
- `wht_form` is required whenever a rate is set.
- `paid_after_wht` (for example "transferred 9,700 after 3%") is grossed up in `applyDefaults`. It is re-derived on every call, so changing the rate recomputes it. It tries the closed form, then up to ±0.05 either side.
  - Not every figure is reachable: with 7% VAT and 3% WHT, no amount leaves exactly 10,000.27.
  - When there is no exact match, the amount is cleared and the card error offers the nearest reachable paid figure, the difference, and the amount that produces it.
  - `update_draft` with a new `amount` (and no `paid_after_wht` in the same call) drops the stale `paid_after_wht`; `paid_after_wht=0` also clears it.

Who must withhold (the payer is a juristic person) and the 1,000 THB per-payment threshold are **prompt rules only**. The bot does not know whether the user is a company, and threshold exceptions such as contract aggregation exist.

Payment: the overpayment guard now runs in `readinessError` (`whtOverpaymentError`). It fetches the parent bill and refuses an amount above the outstanding before the card goes out, so the card always shows the correct payable. `save_transaction` re-runs the same check.

Remitting WHT to the Revenue Department has no dedicated flow. It can be logged as a cash expense or Journal Entry out of WHT Payable.

### Line items
- `draft.items = [{description, qty, rate, item_code?}]`. The amount must equal Σ `flt(qty×rate)`. If the amount is omitted it is computed.
- **Rejected:**
  - Rates with more than 2 decimals (ERPNext rounds the rate first, so 3 × 33.333 would post 99.99).
  - Non-integer qty (UOM Nos has `must_be_whole_number=1`; the fake enforces this too).
  - rate ≤ 0.
  - Rows without a description or code.
- A line whose posted amount or unit rate rounds to 0.00 is refused (for example a 0.01 line after VAT is backed out, or 29 × 0.01 stock pieces with VAT included). ERPNext rejects a zero-rate stock row.
- Rows without `item_code` use GEN-SALE / GEN-PURCHASE. A draft with no `items` still posts one generic row.

### Stock
- **Item codes:** codes are normalised with `NFKC` (so full-width ｐａ２２９３ folds to PA2293), upper-cased, and reduced to letters, marks and digits (`\p{L}\p{M}\p{N}`). So `pa2293`, `PA-2293` and `pa 2293` are the same Item, while Thai ids such as ทับทิม01 and ไพลิน01 stay distinct. Thai vowels and tone marks are combining marks, which is why marks are kept.
  - Because separators are dropped, `A-12` and `A1-2` map to the **same** Item. The code as typed is kept at the start of `item_name`, so printouts and the stock query still show it.
  - Codes containing `/` are refused.
  - The ERPNext Item is named `PA2293-<abbr>`, because Items are global across Companies and this site is multi-tenant.
  - `item_cache` maps the user's code to the ERPNext name.
- **Item settings:** `is_stock_item=1`, `stock_uom='Nos'`, `item_group='Products'` (created if missing).
- **Invoices with stock lines** set `update_stock=1` and a warehouse on each row.
  - Purchases receive stock at the line net when the VAT is claimable, and at gross when it isn't.
  - Sales issue at valuation, and perpetual inventory books **Dr COGS / Cr Stock In Hand**. The bot sets the row's `expense_account` to the account mapped from code 5000.
- **Valuation method:** ERPNext's Stock Settings default valuation method is **FIFO**. The fake uses moving average, which gives identical results here because each stone is a single unit bought once. Real ERPNext will apply FIFO, or whatever method the site has set.
- **Warehouse:** Stock Settings `default_warehouse` if it belongs to this company, else `Stores - <abbr>`, else any leaf warehouse of the company.
- **Selling more than is available** is refused at confirmation, and again at save:
  - Available means the **lowest running balance from the posting date through every later Stock Ledger Entry**. This is the same rule ERPNext and the fake apply.
  - A test covers the dip case: bought at day−10, sold at day−5, bought again at day−1. A new sale dated day−7 is refused both by the bot's check and by the fake.
  - Entries are sequenced like ERPNext: posting date, then posting time, then creation. The new sale is placed at the current time, because the bot sends no posting_time and ERPNext defaults it to now. The fake does the same.
- **Allow Negative Stock:** a short sale passes only if the item already has a valuation rate. Real ERPNext raises "Valuation Rate Missing" for an item that was never valued, even with negative stock allowed, and the fake now raises the same error.
- **Cash drafts:** a stock line on a cash draft is rejected; use an invoice or bill with net_0, then a payment.
- **`query_stock`:** reads stock levels scoped to the company's warehouses (Bin has no company field) and returns rows, total value and `unknown_item` / `not_in_stock` messages.
- **Multi-currency Journal Entries:** `buildRows` absorbs the satang lost in conversion on the largest company-currency line. ERPNext recomputes a foreign line's base from amount × rate, so only a rate-1 line can take the difference. A test scans 200 USD amounts at 36.4123.

## ERPNext setup a real company needs
- **Chart of accounts:** a **Duties and Taxes** group (liability) and a **Tax Assets** group (asset). The standard charts have both. Output VAT, Input VAT and WHT Payable are created automatically if missing. If the company already has differently named tax accounts (e.g. "ภาษีขาย"), rename them to exactly `Output VAT` / `Input VAT` / `WHT Payable`; otherwise new accounts are created alongside them.
- **Perpetual inventory** on the Company (v14 default), with Default Inventory Account and Default COGS set. A `Stores - <abbr>` warehouse must exist; it is created with every company.
- **Stock Settings:** leave Allow Negative Stock off. The valuation method is the site's choice (FIFO by default).
- **System Settings → Rounding Method:** keep the default "Banker's Rounding (legacy)". This is the rounding the bot reproduces.
- **Print format:** a Thai full tax invoice needs the seller's and buyer's tax IDs and branch. Set Company `tax_id` and Customer `tax_id`; the bot stores the user's own tax ID in `users.tax_id` but does not push it to ERPNext. Use a custom "Tax Invoice / ใบกำกับภาษี" print format. Item rates print net, with VAT as a separate line. A qty > 1 line whose amount doesn't divide evenly prints as "N × description" at the line total.
- **API user permissions:** read access on Company, Warehouse, Bin, Stock Ledger Entry and Stock Settings; create access on Item, Item Group and Account.
- **Env vars:** none.

## Known limitations
- **Tax point for services:** for services, Thai VAT and WHT are due when payment is made, not when the invoice is issued. Until then the VAT should sit in an "Undue Output/Input VAT" account. The bot books VAT at invoice time for both goods and services. An accountant should reclassify unpaid service VAT at month end, or this needs to be implemented later as an undue-VAT account moved on payment.
- **Customer-side WHT:** when a customer withholds tax from your sale (creditable WHT), it is not modelled and would show as an underpayment.
- **Opening stock:** there is no flow for stones held before the bot was used (a Stock Reconciliation). The workaround is a purchase bill.
- **Serial / batch numbers:** none. Each stone id is one Item counted in Nos; carats belong in the description.
- **Cancelling a stock invoice:** `cancel-transaction` belongs to another lane and was not touched.
- **Fake vs real ERPNext:** the fake rejects a tax row whose `account_head` is not a Tax / Chargeable / Income / Expense type. Real ERPNext's server-side `validate_account_head` only checks the company and that the account is not a group; the type rule lives in the UI link filter. The fake is deliberately stricter.
- **Not verified live:** none of this has been run against a real ERPNext instance, only the fake in `npm test`.
