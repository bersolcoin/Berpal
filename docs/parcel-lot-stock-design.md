# Parcel and lot stock: design for review

**Status:** draft for review. Nothing in this document is built.
**Date:** 10 November 2026
**Basis:** the research report `reports/Gem cutting process and open data.md` (in the parent folder) and the code on branch `feat/complete-erpnext-flows`.
**Checked by:** two independent reviewers, one against the ERPNext v14 source, one against the Berpal code, the research notes and the arithmetic. Their findings are folded in. Nothing here has been run on a live ERPNext.

## 1. What this adds

Today the bot knows a stone only as "one piece with a code". This design lets a gem trader keep parcels the way the trade works: buy rough by weight, sort it, send it to a cutter, get back less weight in better stones, put stones out on memo, and sell by the carat. Cost follows the stones through every step, so the profit on each sale is right.

It is the first niche module on top of the general ledger. A user who has not switched it on sees no change at all.

**Terms used below**

- **Batch:** ERPNext's way of tracking separate lots of one item, each with its own quantity and cost.
- **Stock Entry:** an ERPNext document that changes stock without a sale or purchase. A **Repack** is the kind that takes some stock out and puts different stock in at the same total value.
- **Bin:** ERPNext's running total of one item in one warehouse.
- **Test double:** the fake ERPNext the automated tests run against.
- **Notified dealer:** a gem dealer registered with the Revenue Department under the VAT exemption for uncut stones.
- **HS code:** the customs classification number for a kind of goods.
- **Satang:** one hundredth of a baht.

## 2. Decisions for you

These are the choices that shape the build. Each has my recommendation. Sections 4 to 11 give the detail behind them.

| # | Decision | Recommendation | Main alternative and why I did not pick it |
|---|---|---|---|
| 1 | Where piece counts, stone attributes, lineage and custody live | In Berpal's own database. ERPNext holds carats and money only. | Custom fields inside ERPNext. Done properly that needs a custom ERPNext app installed on every site, which changes between ERPNext versions and raises a licensing question (ERPNext is GPL, so an app built on it may have to be published under the same licence). |
| 2 | How lot tracking is switched on | A per-user niche setting (`gems`). Existing coded stones keep working as they are. No migration of old stock. | Turn it on for everyone. That would put carat questions in front of users who sell coffee. |
| 3 | How lots map to ERPNext items | Two items per company, "rough" and "cut", measured in carats. Each lot is a Batch of one of them. The cost: ERPNext's own reports cannot break stock down by species; Berpal's can. | One item per species or per stone. That multiplies items for no accounting benefit, because cost is tracked per batch. |
| 4 | How contract cutting is booked | A transfer out, then a "came back cut" entry that adds the cutter's fee to the cost of the cut stones. | ERPNext Subcontracting. It is the textbook route but needs a bill of materials (a recipe of inputs per output), a service item, a purchase order and two more documents per job. |
| 5 | When the cutter's fee must be known | When the stones come back, in the same message. A fee that arrives later is a second-phase feature. | Allow late fees from day one. ERPNext v14 and v15 cannot add cost to a stock entry afterwards (the research says v16 can). A workaround exists for v14 (a stock reconciliation that revalues the batch) but it has only been read in the source, not run. |
| 6 | How cost is shared when a lot is sorted into grades | One method per user, chosen once: by the value the trader puts on each grade (recommended), or by weight. | Choose per sort. The Revenue Department expects one valuation method applied consistently, so switching between them is a risk. Always by weight is simpler but misstates profit (worked example in section 6). |
| 7 | How custody appears in ERPNext | Three warehouses per company: in hand, out for work, out on memo. Who holds each lot is kept in Berpal. | One warehouse per cutter and broker. Warehouses would multiply with every new contact. |
| 8 | Build order | A proof on a real ERPNext first, then four phases (section 12). | Build against the test double only. Several ERPNext behaviours here are too important to assume. |

Questions only you can answer are in section 13.

## 3. What exists today

- One ERPNext Item per stock code, named `<CODE>-<company abbr>`, unit `Nos`, whole pieces only ([items.js](../src/erp-sync/items.js)).
- Carat weight is free text in the description. The prompt forbids putting it in quantity ([60-tax-items.js](../src/prompt/60-tax-items.js)).
- Stock moves only through sales and purchase invoices with "update stock", in one warehouse ([invoice-lines.js](../src/erp-sync/invoice-lines.js)).
- `query_stock` reads piece counts and value from ERPNext Bins ([stock.js](../src/erp-query/stock.js)).
- There are no batches, no stock entries, no parcels, no yield, no custody and no memo.
- Nothing cancels a posted ERPNext document. The cancel tool only discards an unsaved draft.

All of that stays. Lot mode sits beside it.

## 4. The model in three ideas

**Lot.** A lot is any group of stones the trader treats as one thing: a kilo of rough, a parcel of 36 calibrated sapphires, or a single certified stone (a lot of one piece). Every lot has a weight in carats, which is the controlled figure. It has a piece count when the pieces have been counted; rough is often not counted, so the count may be empty.

**Operation.** Lots change only through a small set of operations. Each one names its input lots and output lots, so the full family tree of any stone can be read back.

| Operation | What happens | Example message |
|---|---|---|
| Buy | A new lot enters stock | "Bought 200 ct blue sapphire rough from Somsak, 300,000 cash" |
| Sell | All or part of a lot leaves stock | "Sold 5.5 ct from L16 to Mr Lee at 27,000 per carat" |
| Split | One lot becomes several with no weight lost (sorting, picking) | "Sorted L12: 120 ct cutting grade, 80 ct low grade" |
| Merge | Several lots become one (the trade's "mixing") | "Mix L20 and L21 into one parcel" |
| Transform | Cutting, sawing, heating, recutting or a plain re-weigh: weight changes, and form or treatment may change | "L13 back from Lek: 30 ct, 42 pieces, fee 80 per carat" |
| Move | The lot goes to, or returns from, someone else's hands | "Sent L13 to Lek for cutting" |
| Write off | Stones lost, broken or stolen | "One stone from L16 broke, 0.8 ct" |

**Custody.** A lot at the cutter, the burner, the lab or a broker is still the trader's stock. Sending it out is a move, never a sale. Memo out is a move with a price and a due date attached.

One rule keeps custody simple: **a lot is in one place with one holder at a time.** Sending out part of a lot, or getting part of it back, splits it first. The bot makes that split itself at the lot's cost per carat, unless the trader says the part is a different grade. Two cutters may each hold lots in the same "out for work" warehouse; Berpal knows who has which.

## 5. Where each fact lives

| Fact | Lives in | Why |
|---|---|---|
| Carats on hand per lot, and their value | ERPNext (Batch quantity and the stock ledger) | This is the accounting figure; the balance sheet reads it |
| Cost of goods sold on each sale | ERPNext | Posted automatically by the invoice |
| Pieces per lot | Berpal database | ERPNext cannot hold two quantities on one stock line |
| Form, species, shape, size, colour, clarity, origin, treatment, grade | Berpal database (a readable summary is also written into the Batch description) | No such fields on an ERPNext Batch |
| Family tree (which lots came from which) | Berpal database | ERPNext allows one parent per batch; merges need several |
| Who holds a lot, since when, due back when, memo price | Berpal database | ERPNext only knows the warehouse |
| Asking price, bottom price | Berpal database | Not accounting data |
| Stones held for others (memo in) | Berpal database only | They are not the trader's stock, so they must not appear in ERPNext |

Two ledgers can drift apart. Section 10 covers how that is prevented and detected.

### ERPNext objects

- **Items.** `GEM-ROUGH-<abbr>` (rough and preforms) and `GEM-CUT-<abbr>` (faceted, cabochon, bead). Unit: Carat, which ships with ERPNext and accepts fractions. Both are created batch-tracked with first-in-first-out valuation; ERPNext does not let either be changed once the item has transactions, which is why old piece-coded items cannot simply be converted.
- **Batch.** One per lot, named `<LOTCODE>-<abbr>`, because batch names, like item names, are shared across every company on the site.
- **Warehouses.** `Stores - <abbr>` (exists today), plus `Out for work - <abbr>` and `Out on memo - <abbr>`, created the first time they are needed.

The rough and cut split roughly follows the customs line between unworked stones (HS 7103.10, which also covers simply sawn or roughly shaped stones, so preforms probably belong there; unconfirmed) and worked ones. It is not the tax line. The Thai exemption turns on whether a stone is faceted, and a cabochon is worked for customs but not faceted. Tax treatment therefore reads the form on the lot record, never the item.

| Operation | ERPNext document |
|---|---|
| Buy | Purchase Invoice with update stock (today's path, plus a batch on the line) |
| Sell | Sales Invoice with update stock, batch on the line, quantity in carats |
| Split, merge | Stock Entry of type Repack, with the value of each output set by Berpal |
| Transform | Stock Entry of type Repack, with the fee as an additional cost. It can take the rough straight from "out for work" and put the cut stones into "in hand", so no separate return move is needed. |
| Move | Stock Entry of type Material Transfer |
| Write off | Stock Entry of type Material Issue, to a stock loss expense account |
| Memo in | None until the stones are bought |

Weight lost in cutting needs no entry of its own. The rough goes out at its full cost, fewer carats come in carrying that whole cost, and the cost per carat rises. That is how the trade thinks about it.

## 6. Cost rules, with one parcel followed end to end

Figures are shown to the whole baht.

| Step | Lot | Carats | Pieces | Cost | Cost per carat |
|---|---|---|---|---|---|
| Buy rough for 300,000 | L12 | 200.00 | not counted | 300,000 | 1,500 |
| Sort, cutting grade (trader values it at 3,000/ct) | L13 | 120.00 | not counted | 270,000 | 2,250 |
| Sort, low grade (valued at 500/ct) | L14 | 80.00 | not counted | 30,000 | 375 |
| L13 goes to the cutter | L13 | 120.00 | | 270,000 | no change |
| L13 comes back cut, fee 80/ct on 30 ct = 2,400 | L15 | 30.00 | 42 | 272,400 | 9,080 |
| Sort cut stones, top (valued at 25,000/ct) | L16 | 8.00 | 6 | 175,742 | 21,968 |
| Sort cut stones, commercial (valued at 5,000/ct) | L17 | 22.00 | 36 | 96,658 | 4,394 |
| L16 goes out on memo at 28,000/ct, 14 days | L16 | 8.00 | 6 | 175,742 | no change |
| Broker sells 4 stones, 5.50 ct, at 27,000/ct | L16 | 2.50 left | 2 left | 54,919 left | 21,968 |

The sale brings in 148,500 against a cost of 120,823, a profit of 27,677. The cutting yield, 30 of 120 carats or 25%, is stored against the cutter.

The rules behind the table:

1. **Buying.** The lot's cost is what was paid, in company currency. The trader may state a price per carat, per gram, per kilo, per piece or a total; the bot stores which and works out the rest. One gram is five carats.
2. **Splitting by value.** When a lot is sorted into grades, cost is shared in proportion to the value the trader puts on each grade. L13 was valued at 360,000 and L14 at 40,000, so L13 takes 90% of the 300,000. A user set to "by weight" is never asked for values.
3. **Why this matters.** Shared by weight, every cut stone from L15 would cost 9,080 per carat. The memo sale would then show a profit of 98,560, and the commercial lot would sit in the books at 9,080 per carat against a market price of 5,000. The profit would be booked early and the loss would surface later.
4. **One method per user.** The method is set once (decision 6) and used for every split. For a "by value" user the bot always needs a figure. When the trader sells the best stones out of a parcel and does not say what the rest is worth, the proposed fallback is: the picked stones are valued at their sale price and the rest at the parcel's current cost per carat. That fallback is my proposal, not trade practice; an accountant should also weigh the by-product method, where low grades are carried at what they will fetch and the main grade takes the remainder.
5. **Transforming.** All the cost of the input goes to the output, plus the fee. Fee bases: per finished carat, per piece, a fixed sum, or a mix. If a cut produces several outputs, such as cut stones and saleable offcuts, rule 2 shares the cost. Rough that comes back uncut is a move back at its original cost, not part of the cut, so it takes none of the fee and does not distort the yield. Stones that break in cutting or heating stay in the cost of the survivors, like any other weight loss, unless the trader asks for a write-off.
6. **Single stones** carry their own cost, because each is its own lot. **Parcels** carry an average cost per carat.
7. **Fees.** The cutter's bill is recorded as a normal bill or cash payment, with VAT and withholding tax handled by the existing rules. It posts to a holding account ("Expenses Included In Valuation", number 5118 in ERPNext's standard chart), and the transform entry moves it from there into stock. Only the part of the fee the trader cannot reclaim goes into stock: VAT that can be claimed stays in the VAT account, and withholding changes what is paid, not the cost. Nothing reaches the profit and loss statement until the stones sell.
8. **Rounding.** On a split, merge or transform Berpal sets each output's value itself, so outputs always add up exactly to inputs plus fees; the last line takes any remainder (to the satang, L16 is 175,741.94 and L17 is 96,658.06). A purchase is different: ERPNext rounds the price per carat to two decimals, so a lot bought for a round total at an awkward weight (50,000 for 12.37 ct) enters stock a few satang away from what was paid. The difference goes to the rounding line that exists today, and ERPNext's figure is the lot's cost. Today's rounding code assumes whole quantities and needs a new rule for carats.

## 7. The lot record

Stored in a new `lots` table in Berpal's database.

| Group | Fields |
|---|---|
| Identity | code (the trader's own, or assigned as `L` plus a number), ERPNext item and batch names, status (open, closed) |
| Quantity | carats, whether the weight is estimated, pieces (may be empty), ownership (owned, held for someone else) |
| Description | form (rough, preform, cut, cabochon, bead), species and variety, shape, size or calibrated size, colour, clarity (simple four-step scale), origin, house grade (free text) |
| Treatment | treatment code (none, H, H-FH, H-D, H-GF, FF-O, LGH, unknown) and who stated it (seller, lab, self) |
| Buying terms | purchase unit, pricing basis, supplier, whether a supplier document is attached, whether the lot qualifies for the VAT exemption (section 11) |
| Prices | asking per carat, bottom per carat, currency |
| Certificates | lab, report number, date, stated weight, link to the lab's page, scan (separate table, one lot may have several) |

Behaviour tied to these fields:

- The treatment codes are one lab's report categories (Lotus Gemology), used as a starting list. They are not a trade standard and the list can change.
- A treatment code passes to every descendant lot. Heating is a transform whose output carries the new code. Merging lots with different treatments marks the result as mixed and warns first.
- Recutting a stone with a diffused or filled treatment (H-D, H-GF, FF-O, LGH) warns first, because recutting can remove the treated layer or open the filling.
- A recut or re-weigh keeps the stone's code and its batch. Its weight and size are replaced, and any attached certificate is marked out of date because the report states the old weight. If the live proof shows ERPNext will not take the same batch out and back in one entry (section 12, point 5), the batch gets a new name behind the scenes and the trader's code still stays.
- A lot cannot be saved without a weight, because ERPNext stock is in carats. An estimate is accepted and marked as one; the first proper weighing corrects it with a re-weigh.
- Only form, carats and one of species or a description are required to create a lot. The bot never blocks a purchase for missing colour or clarity.

Three more tables: `lot_ops` (one row per operation: kind, yield, fee, status, reference, the ERPNext document names), `lot_op_lines` (the input and output lots of each operation, with carats, pieces, damaged pieces and value) and `lot_custody` (one row per trip out: who, why, carats and pieces out, date out, due date, memo price, what came back, what sold).

## 8. Checks the bot makes before saving

All thresholds below are proposals to be tuned with real traders. None comes from a published rule.

- **Weight cannot appear from nowhere.** Outputs of a split must add up to the input within a weighing tolerance (proposed: 0.05 ct or 0.5%, whichever is larger, and never more than 2 ct). A difference inside the tolerance is recorded; outside it, the bot asks. The only tolerance in the research is one cutter's 2%.
- **Yield is shown, never enforced.** After a transform the card states the yield. It is flagged, not blocked, when it looks unusual for that kind of job:

  | Job | Flag when | What the research says |
  |---|---|---|
  | Cutting from rough | yield below 5% or above 50% | 15 to 33% is typical; some material runs as low as 2 to 6% |
  | Recutting | more than 40% lost | losses of 1 to 35% |
  | Sawing, heating, preform to cut | more than 15% lost | sawing loses about 5% a pass; no figure for the others |

  The trader's own history replaces these hints once there is enough of it.
- **Pieces.** For counted lots, pieces out plus damaged pieces must equal pieces in on a split. On a cut, the count may change freely.
- **Nothing leaves that is not there.** A sale, move or cut cannot take more carats than the lot holds. Today's shortfall check knows one warehouse and no batches, so this is a new check, not an extension.
- **Dates.** An operation cannot be dated before the last operation on its input lot.
- **Memo sale to a different buyer or price** than the memo slip is allowed, with the difference shown on the card.
- **A stone lost while out** can be written off, or charged to the holder at the memo price as a sale. The research suggests the holder normally owes the stated value, but on anecdotal evidence only.

## 9. How it looks in chat

Every operation goes through the gate that exists today: the bot fills a draft, the server builds the card, the user confirms, and only then is anything saved. The gate is reused; much of what sits behind it is not, because today's draft, checks and card all assume a transaction with an amount and a counterparty. A split, a move or a merge has neither. The table below lists what has to change.

A cut coming back would read like this:

```
User: L13 back from Lek. 30 ct, 42 pcs. He charged 80 a carat, paid cash.

Bot:  Cut returned
      From: L13 blue sapphire rough, 120.00 ct (with Lek since 2 Nov)
      To:   L15 blue sapphire cut, 30.00 ct, 42 pcs
      Yield: 25.0%
      Fee:  2,400.00 THB (80 x 30.00 ct), cash, no VAT, no withholding
      Cost: 272,400.00 THB = 9,080.00 per ct
      [Confirm] [Reject]
```

Questions the trader can ask: what is in stock (by species, form or place), what is out and with whom, which memos are overdue, where a stone came from, and what yield each cutter delivers. The daily digest gains two lines: memos past their due date and lots out for work longer than expected.

### Changes to the code

| Area | Change |
|---|---|
| User setting | New `users.niche` column. Empty means the general ledger; `gems` turns this module on. Asked at onboarding or set later in chat. A second setting holds the cost-sharing method. |
| Prompt | New section `65-lots.js`, rendered only for `gems` users. Section 60, which today tells every user that quantities are whole pieces and that withholding never applies to stones, becomes conditional. |
| Tools | New: `update_stock_op` (drafts a split, merge, transform, move or write-off), `query_lots`, `query_custody`, `query_lot_history`, `set_lot_details`. `request_confirmation` and `save_transaction` are reused. The tool list becomes per-user, and tool execution checks the niche too; today any tool name the model sends is run. |
| Draft and validation | Invoice and bill lines gain an optional `lot` block (code, form, carats, pieces, pricing basis). Lot lines accept fractional carats; other lines keep today's whole-number rule. Validation today requires an amount, a currency and a direction on every draft; stock operations need their own rules. |
| Confirmation checks | The signature that ties a confirmation to a draft covers the amount and counterparty today. For stock operations it must cover lots, carats, pieces and values. |
| Card | New layouts for each operation, built by the server like today's. Today there is one layout, built around money. |
| Saving | Routing to ERPNext today accepts only the existing transaction types and one document per save (plus a chained payment). Stock operations add new types and fixed sequences of documents (section 10). |
| ERPNext sync | New `src/lots/` module: batch and warehouse resolution, the stock entry builders, cost sharing, the per-batch shortfall check, the holding and stock loss accounts. Invoice line building learns the batch and the carat unit. The gem items need their own creation path. |
| Stock questions | `query_stock` today adds up every warehouse and unit into one total. It must report pieces and carats separately and say what is out. An invoice may carry old piece-coded lines and lot lines together. |
| Review queue | Holds one row per posted document today. It needs a second kind of entry for a stock difference. |
| Database | Migration `100-lots.sql`: `lots`, `lot_ops`, `lot_op_lines`, `lot_custody`, `lot_certificates`. |
| Model limits | The bot runs on a small model with 600 output tokens and 10 tool calls per turn. A sort into many grades may not fit; limits and model choice need testing on real messages. |
| Tests | The ERPNext test double values stock by moving average today. It learns Batch, Stock Entry, per-batch cost and per-batch quantities. New unit, flow and chat-harness cases per phase. |

## 10. Keeping the two ledgers in step

1. Each operation is written to `lot_ops` as pending, with a unique reference, before ERPNext is called.
2. Every ERPNext document of the operation carries that reference and its step number in its remarks, the only standard field that can be searched for it. The search is a text match, not an exact lookup. A dedicated reference field would be exact; whether one can be added over the API without installing an app is not yet known (section 12, point 8).
3. On success the row is marked posted and the lot figures are updated in one database transaction. If ERPNext refuses, the row is marked failed and no lot changes.
4. If the process dies between steps, the next start looks up each pending reference in ERPNext and either completes or voids the row.
5. A nightly job compares carats per lot in Berpal with the batch quantity in ERPNext, and checks that the holding account is empty when no operation is half done. Any difference goes into the review queue. ERPNext is the authority on carats and value, Berpal on pieces.

### One confirmation, several documents

Today one confirmation saves one document, with one exception (an invoice and its payment). Several stock operations need more:

| The trader confirms | Documents, in order |
|---|---|
| Cut returned with a fee | The fee bill or payment, then the transform |
| Best stones picked from a parcel and sold | The split, then the sales invoice |
| Part of a lot sent out | The split, then the move |
| A stone held on memo from someone else is sold | The purchase from its owner, then the sales invoice |

The card shows everything the confirmation will save. The documents post in the fixed order above. If one fails, the later ones do not run, the operation is marked partial, the user is told what was and was not saved, and a retry resumes from the failed step. There is no automatic reversal. A fee that has posted while its transform has not shows up as a balance in the holding account, which the nightly check reports.

### Undo

Undo is new work. Today the bot can discard an unsaved draft; nothing in the code cancels a posted ERPNext document. Lot operations need it more than invoices do, because a mistyped weight carries into everything downstream. The design: cancel the operation's ERPNext documents in reverse order and reverse its lot rows, allowed only while no output lot has any later operation of any kind (sold, cut, moved, merged or sent on memo). Later operations must be undone first, newest first.

## 11. Tax and compliance

The research found the rules but could not confirm several current rates, and it read the Thai sources through machine translation. Everything unconfirmed is therefore a setting with no default, not a hard-coded rule, and this whole section needs an accountant before phase 4 is built.

| Item | Design | Status of the underlying fact |
|---|---|---|
| Tax profile | Three choices at onboarding for `gems` users: individual, registered dealer using the Royal Decree 311 exemption, VAT-registered without it | **Our own reading** of Revenue Department pages. The three-way split is not a sourced rule. |
| Which stock is exempt | Each lot carries an "exempt" flag set at purchase. The exemption covers only stones imported under the notification or bought from a notified dealer. | From Revenue Department sources |
| Buyer status | Each counterparty can be marked as a notified dealer. An exempt sale to anyone else shows a warning on the card. | From Revenue Department sources |
| Goods and materials report | Monthly export from the operations table with the seven required columns: date, document number, type, kind, quantity, unit weight, unit value | Columns from Revenue Department sources; exact layout needs an accountant's eye |
| Delivery note between dealers | Print format from a sale or a memo | From Revenue Department sources |
| Purchase with no supplier document | Always allowed. A "document attached" flag lets the accountant list the exposure. | Matches how rough is bought |
| Withholding on uncut stones bought from individuals | A rate the user or accountant sets | **Not confirmed.** 1% is documented only for 2013 and 2014. |
| Cash sale of 2,000,000 baht or more; customer total reaching 100,000 baht | Optional reminders, off by default | **Not confirmed** for sole traders who are natural persons |
| VAT rate | Uses the existing tax setting | **Needs checking now.** The 7% extension the research found ran to 30 September 2026. This affects today's VAT code too, not only this design. |
| Individuals' relief for uncut stones (Royal Decrees 617 and 618) | The bot notes when a cut moves stock outside the relief | **Not confirmed as current.** A 2016 start date was found; no end date. |

What this means for today's code: onboarding stores VAT registration as yes or no, the tax treatment has no way to say "registered but exempt", and the prompt says withholding never applies to goods or stones. All three change in phase 4.

## 12. Build plan

| Phase | Contents | Size | Depends on |
|---|---|---|---|
| 0. Proof on a real ERPNext | A script that runs each document in section 5 against a live v14 site and checks the points in the list below | Small | ERPNext credentials in `.env`, the same blocker as the pending smoke test |
| 1. Lots in and out | Niche switch, per-user prompt and tools, lot record, buy and sell by the carat with pieces, carat rounding, single stones as lots, `query_lots`, the pending-then-posted bookkeeping | Medium | Phase 0 |
| 2. Sorting and cutting | Stock operations without money (validation, confirmation checks, cards, routing), split, merge, transform with fees, cost sharing, yield, lineage, write-off, several documents per confirmation, undo | Large; the biggest phase and a candidate to split in two | Phase 1 |
| 3. Custody and memo | Out for work, memo out with due dates and close-out, memo in, overdue lines in the digest, nightly comparison | Medium | Phase 2 |
| 4. Tax and paperwork | Tax profile, exempt flag, buyer status, goods and materials report, delivery note, certificates | Medium | Phase 1; answers from an accountant |

Each phase follows the method used so far: build, tests, an independent review, fixes, then it comes to you.

A reviewer has read the ERPNext v14 source for every mechanism this design relies on, and each one is supported there (details in section 15). Reading is not running. Phase 0 runs them on a live site and must show:

1. A sale from one batch is costed at that batch's own rate, not an item-wide average.
2. A Repack takes the value Berpal sets on each output line, and input and output values balance to the satang.
3. An additional cost on a Repack raises the output's value and clears the holding account.
4. A lot can be moved to the memo warehouse and sold from there.
5. A recut can be posted as the same batch going out heavier and coming back lighter.
6. A stock reconciliation can add a late fee to a batch's value (the workaround in decision 5).
7. The same calls work on v15, where batch lines need one extra flag and a new setting can allow negative batch stock (it must stay off).
8. Whether a reference field can be added over the API without an app, which would make the lookup in section 10 exact.

## 13. Open questions

**For you**

1. Do you have one or two traders who would walk us through their real books and memo slips? No published source describes how small Thai traders actually keep records, so the wording of cards, the thresholds in section 8 and the default memo period are educated guesses until someone shows us.
2. How do your target users number parcels and stones today? The design accepts their own codes and otherwise assigns `L` plus a number.
3. Which tax profile do the first users have? It decides whether phase 4 is urgent or can wait.
4. Is an accountant available to check section 11 and the cost-sharing method in decision 6?
5. For decision 6: should "by value" be the default for new gem users, with "by weight" as the opt-out, or the other way round?

**Left out on purpose**

- Jewellery and mounted stones, pairs and sets as linked lots, stones co-owned with a partner, price guides, automatic lab report lookups, write-downs when market value falls below cost, several branches or safes, label printing, and converting old piece-coded stock into lots. Each can follow later without changing this model. Co-owned stones appear as a standard feature in gem trade software, so that one is likely to be asked for early.

## 14. Sources for the mapping

- ERPNext feature availability by version, and the two open-source apps used as pattern references (`Gurukrupa-Export/jewellery-erpnext`, which wraps a Repack in a "Gemstone Conversion" document, and `efeone/aumms`, which keeps a parallel ledger): `research_notes/Gem cutting process and open data/repos_formats_and_schemas.md`.
- Trade practice, yields, memo terms and Thai tax rules: the research report named at the top. No code is copied from either app; this design builds no ERPNext app at all.

## 15. Build notes from the ERPNext source check

For whoever builds this. Each point was read in the `version-14` source; none has been run yet.

- **Batch cost.** A new Batch gets batch-wise valuation only when the item's valuation method is not Moving Average, so the two gem items set FIFO explicitly. Cost is averaged per batch per warehouse.
- **Setting output values on a Repack.** Each output row must carry `set_basic_rate_manually: 1`, `basic_rate` and `basic_amount`. Without `basic_amount` the value is ignored, and an additional cost then falls into the difference account instead of stock. Left to itself ERPNext shares cost by weight.
- **Difference and loss accounts.** Any value difference on a stock entry posts to the row's `expense_account`. Set it and a cost centre on every row: Stock Adjustment (5119 in the standard chart) for repacks, a stock loss account for write-offs. The default is not reliable.
- **Additional costs** spread over the output rows in proportion to their value and credit the account named on the cost row (5118).
- **Batch on document lines.** v14 reads `batch_no` on the line. v15 needs `use_serial_batch_fields: 1` as well; v14 ignores that flag, so always send it.
- **Batch names** are unique across the whole site and a batch has one parent link only, which is why lineage lives in Berpal.
- **Quantity per batch and place:** `erpnext.stock.doctype.batch.batch.get_batch_qty` (batch, optional warehouse).
- **Shortfalls.** With negative stock off, ERPNext refuses any move that takes a batch below zero in a warehouse. Berpal submits documents directly, so this arrives as a raw error; the bot's own check in section 8 must run first.
- **Transfers** between warehouses that share one stock account create no accounting entries, only stock ledger rows. That is expected.
- **Invoice rounding with fractional carats.** Today's `splitLine` in `invoice-lines.js` spreads rounding assuming whole quantities. Lot lines need their own rule.
- **Item creation.** `resolveItem` in `items.js` creates `Nos` items without batches. The gem items need a separate creation path.
