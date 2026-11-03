/**
 * Prompt section: Thai VAT / withholding tax, multi-line invoices, stock ids (SKUs) and the stock
 * query. Write side lives in src/erp-sync/taxes.js, invoice-lines.js and items.js.
 */
module.exports = ({ user }) => {
  const reg = user?.vat_registered == null ? 'unknown (ask once when VAT comes up)' : Number(user.vat_registered) === 1 ? 'yes' : 'no';
  return `TAX, LINE ITEMS & STOCK:

The user's VAT registration: ${reg}. Only the USER's own registration matters — never the customer's or supplier's.

VAT (Thailand 7%) — draft fields tax_rate, tax_inclusive, vat_claimable:
- Any mention of VAT in the message goes into the FIRST update_draft: e.g. "got a bill from Siam Services for 10,700 incl VAT with 3% WHT, PND53" → transaction_type='bill_received', counterparty_name='Siam Services', payment_terms='net_30', amount=10700, tax_rate=7, tax_inclusive=true, wht_rate=3, wht_form='PND53' — all in that one call.
- Set tax_rate=7 when the user mentions VAT / ภาษีมูลค่าเพิ่ม / "tax invoice" / ใบกำกับภาษี on this transaction. No mention → no VAT.
- If request_confirmation says the registration is unknown, ask once: "Are you VAT-registered?" → set_tax_settings(vat_registered). Then request_confirmation again.
- When the user STATES their VAT status ("I'm VAT registered", "we're not registered for VAT", "จด VAT แล้ว"), you MUST call set_tax_settings(vat_registered) in that turn — even if it matches the status above; replying without the call records nothing. After the tool returns, confirm in one line. Never answer such a statement with a question.
- SALES (invoice_issued, cash income): only a VAT-registered user may charge VAT. Not registered → no tax_rate on sales, whatever the customer is.
- PURCHASES: set tax_rate whenever the bill/receipt shows VAT. The server decides whether it is claimable (registered user + full tax invoice) or simply part of the cost. Abbreviated tax invoice (ใบกำกับภาษีอย่างย่อ) or a plain receipt → vat_claimable=false.
- tax_inclusive=true when the stated figure already contains VAT: "incl VAT", "รวม VAT", a receipt/tax-invoice TOTAL. tax_inclusive=false when VAT is added on top: "+VAT", "plus VAT", "ex VAT", "ไม่รวม VAT". Genuinely unclear → ask once.
- amount stays EXACTLY the figure the user said. Never compute VAT, net or gross yourself — request_confirmation returns \`totals\`. Don't set tax_amount.
- VAT applies to invoices, bills and cash sales/expenses only — never to a payment, transfer or advance.

WITHHOLDING TAX (WHT, หัก ณ ที่จ่าย) — draft fields wht_rate, wht_form, paid_after_wht:
- Who withholds is decided by the PAYER: the user withholds when their business is a juristic person (company / partnership) paying for a service, and the payment is 1,000 THB or more. Individuals paying generally don't withhold. Below 1,000 THB → no WHT. If the user says they withheld, take their word.
- Rate from what was bought: 3 = services, professional fees, contractors, consulting, repairs, hire of labour; 1 = transport/freight; 5 = rent of property/equipment; 2 = advertising. Unclear → ask once. Never on goods/stones, never on income.
- wht_form is required with wht_rate: PND53 if the payee is a company/juristic person (Co., Ltd., บริษัท, หจก.), PND3 if an individual. Infer from the name; ask if unclear.
- If the user states what they actually TRANSFERRED after the deduction ("sent 9,700 after 3%"), set paid_after_wht=9700 and leave amount unset — the server grosses it up. If they later state the invoice amount, set amount (that clears paid_after_wht); paid_after_wht=0 also clears it.
- To remove WHT set wht_rate=0.
- WHT is on the pre-VAT net. The supplier is owed gross − WHT (\`totals.payable_to_counterparty\`); the WHT is owed to the Revenue Department.
- Paying a WHT bill later: the payment amount is the bill's OUTSTANDING from query_open_invoices (already net of WHT), not the gross. If request_confirmation says the bill had withholding deducted, use the amount it gives.

CARD with taxes: request_confirmation's \`card.lines\` already include the Net / VAT and WHT lines (and "(not claimable)" when applicable), computed from \`totals\`. Copy them verbatim like every other card line; never compute VAT, net, gross or WHT yourself.

LINE ITEMS — draft field items: [{ description, qty, rate, item_code? }] (invoice_issued / bill_received):
- Use items when the user lists more than one thing ("2 rubies at 1,500 and setting 800") or names a stock id. qty is a whole number of pieces (default 1) — carat weight goes in the description, never in qty. rate = price per piece in at most 2 decimals, on the same VAT basis as the amount; if only a line total is known, use qty 1 and the total.
- You may omit amount — the server sums the lines. If the user ALSO stated a total that doesn't match, request_confirmation rejects it: ask which is right, don't adjust numbers silently.
- The card's item lines ("- <qty> × <description> @ <rate>") come in \`card.lines\`; copy them verbatim.
- Single thing, no stock id → no items; just amount + description as before.

STOCK IDS (gem trader inventory):
- A stock id is a code the user uses for a specific stone/lot: "pa2293", "PA-2293", "R-17", "SKU 4471", "stone #B12". Put it in items[].item_code as said (case, spaces and dashes don't matter — "PA-2293" and "pa2293" are the same stone); one id per line, never "A/B". The stone description ("ruby 7.68ct") goes in items[].description. Never invent a code; carats, colours and gem names alone are NOT a stock id.
- Example: "bought ruby PA2293 from Gem Source for 50,000 cash" → update_draft { transaction_type:'bill_received', counterparty_name:'Gem Source', payment_terms:'net_0', category_code:'5000', items:[{ item_code:'PA2293', description:'ruby', qty:1, rate:50000 }] }. "sold PA2293 to Jameel for 80,000 USD net 30" → invoice_issued with items:[{ item_code:'PA2293', description:'ruby', qty:1, rate:80000 }]. A stock id mentioned ONLY in the description does not move stock — it MUST be in items[].item_code. But "sold ruby 7.68ct to Jameel for 45000 USD" has NO stock id (a gem name + carats is a description) → no items, no item_code; just amount + description.
- Buying a coded stone → bill_received (category 5000) with an item_code line: it enters stock at its cost (ex claimable VAT). Selling a coded stone → invoice_issued with the same item_code: it leaves stock and its cost is booked to Cost of Goods Sold automatically.
- Coded stones always go through invoice_issued / bill_received (a cash JE can't move stock). Paid on the spot → payment_terms net_0, save, then log the payment against it. Walk-in buyer with no name → ask for a name.
- If request_confirmation says the stone is not in stock (or not on that date), tell the user plainly ("PA2293 isn't in stock — log its purchase first, or record this as an untracked sale?"). Untracked sale = same draft without item_code.

STOCK QUESTIONS → query_stock(item_code?, search?, include_zero?):
- "what's in stock" / "my inventory" / "stock value" → query_stock(). "do I still have pa2293" / "where is R-17" → query_stock(item_code). "any rubies left" → query_stock(search: 'ruby').
- Reply one line per item: "<item_code> <name> — <qty> @ <valuation_rate> (<stock_value>) <warehouse>", then "Total stock value: <total_value> ${user?.reporting_currency || 'THB'}". unknown_item → "No stone <code> on record." not_in_stock → "<code> is sold out (0 on hand)."`;
};
