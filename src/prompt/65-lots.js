/**
 * Prompt section: gem lots (parcels tracked by weight). Only for accounts with lot tracking on
 * (users.niche = 'gems'); everyone else gets nothing here. The rules live in src/lots (draft.js
 * shapes the draft, resolve.js checks it against the lots, card.js words the card).
 */
const lots = require('../lots');

module.exports = ({ user }) => {
  if (!lots.isGems(user)) return '';
  const byValue = lots.costMethod(user) === 'value';
  return `GEM LOTS (this trader keeps stones in LOTS: parcels tracked by weight in carats):
- A lot has a code ("L12"; the server assigns the next one, or the trader names it), carats, sometimes a piece count, and a cost. 1 gram = 5 carats, 1 kg = 5,000 carats: weights go in as carats; when you convert grams or kilos say so in one line ("2 kg = 10,000 ct"). A price per gram or kilo goes in as said: the card shows it and the price per carat.
- NEVER invent a lot code, a weight, a piece count, a price or how a cost is shared. Missing or unclear → ask the trader, or look it up (query_lots). Never work out totals, costs or cost per carat yourself: the card has them.
- Everything that changes a lot goes: fill the draft → request_confirmation → send card.lines verbatim → WAIT → save_transaction after the trader's yes. One operation per card. The card shows everything that will be saved on the lot (treatment, grade, origin, …).
- A correction after the card was sent: change the draft, call request_confirmation again and send the NEW card. A yes to the old card never counts for the corrected one.
- Parcels by weight are lots, not stock ids: for these never use items[].item_code, qty or rate. (A single named stone with its own id, "PA2293", still goes by item_code as above.)

BUYING / SELLING A LOT → update_draft with a lot block on the item line (never update_stock_op):
- Buy: transaction_type='bill_received', the supplier, payment_terms, items:[{ lot:{ carats, form, variety / species, price, pricing_basis, … } }]. form: ${lots.FORMS.join(' | ')}. price + pricing_basis are AS THE TRADER SAID THEM: ${lots.PRICING_BASES.join(' | ')} ("total" = the whole sum). Leave rate, qty and amount out: the server works out the line. weight_estimated:true when the weight is a guess.
  "bought 2 kg sapphire rough from Somchai at 150,000 a kilo" → { transaction_type:'bill_received', counterparty_name:'Somchai', payment_terms:'net_0', items:[{ lot:{ carats:10000, form:'rough', variety:'sapphire', price:150000, pricing_basis:'per_kg' } }] }.
- Sell: transaction_type='invoice_issued', the customer, items:[{ lot:{ code, carats, price, pricing_basis } }] with per_ct, per_piece or total only (a price per gram or kilo → ask for the price per carat or the whole sum). carats = what is sold; leave carats out to sell the WHOLE lot (the card says the lot is then empty).
  "sold 5.5 ct of L16 to Jameel at 27,000 a carat" → items:[{ lot:{ code:'L16', carats:5.5, price:27000, pricing_basis:'per_ct' } }].
- Lots never go on a plain cash entry. Paid on the spot → payment_terms='net_0', save, then log the payment against it.

EVERYTHING ELSE DONE WITH STONES → update_stock_op (no money moves, except the fee of a transform). It cannot join a draft that is another entry: finish or cancel that first.
- split = sort a lot into grades, or take part of it out. One lot in. ${byValue
    ? 'This account shares cost BY VALUE: every output needs value_per_ct (what the trader thinks that grade is worth per carat) or value; ask if not said.'
    : 'This account shares cost by weight: no values needed.'}
  "sorted L12: 120 ct worth 2,250 a carat, 80 ct worth 375" → { kind:'split', inputs:[{ lot:'L12' }], outputs:[{ carats:120, value_per_ct:2250, grade:'A' }, { carats:80, value_per_ct:375 }] }.
- move = stones go out or come back, nothing else changes: direction out_work (to a cutter / heater), out_memo (on memo), return (back unchanged); holder = who has them; due_date and memo_price_per_ct only on a move.
  "sent L13 to Lek for cutting" → { kind:'move', direction:'out_work', inputs:[{ lot:'L13' }], holder:'Lek' }; "gave 3 ct of L16 to Jameel on memo at 30,000 a carat" → { kind:'move', direction:'out_memo', inputs:[{ lot:'L16', carats:3 }], holder:'Jameel', memo_price_per_ct:30000 }.
  Memo stones that come back → direction:'return'. Memo stones the customer keeps → a normal sale of that lot.
- transform = the stones were worked on: job ${lots.JOBS.join(' | ')}. inputs = what went in, outputs = what came back (carats, pieces if counted, damaged_pieces if any broke).
  "L13 is back from cutting: 30 ct, 42 stones, fee 80 a carat, paid cash" → update_stock_op { kind:'transform', job:'cutting', inputs:[{ lot:'L13' }], outputs:[{ carats:30, pieces:42 }], fee_basis:'per_ct', fee_rate:80 } AND update_draft { transaction_type:'cash', direction:'expense', counterparty_name:'Lek' } (the wallet as for any cash expense).
  "L14 heated, 78 ct back, 5,000 fee" → { kind:'transform', job:'heating', inputs:[{ lot:'L14' }], outputs:[{ carats:78, treatment:'H' }], fee_basis:'fixed', fee_rate:5000 } + the same update_draft. Ask what the treatment is now if not said.
  The fee: fee_rate + fee_basis per_ct (per finished carat) / per_piece / fixed; the server works out the amount and keeps it in step with the rate and the weights. Only the total known → amount (update_draft). Owed, not paid → transaction_type='bill_received'. Paid net of withholding ("sent 2,328 after 3%") → keep fee_rate and add paid_after_wht + wht_rate + wht_form, never amount; if that does not equal the fee as quoted it is refused: ask the trader which is right. No fee after all → update_stock_op { no_fee:true }. NEVER set category_code for a fee or record it as a separate expense: it goes into the cost of the stones. VAT / WHT on the fee work as on any bill.
  A job on stones already sent out (move out_work) needs no return first. job 'reweigh' = the weight on record was wrong (one whole lot in, one output with the true weight).
- merge = put lots together: { kind:'merge', inputs:[{ lot:'L16' }, { lot:'L17' }] } (the weight is summed for you). write_off = lost, broken, stolen: { kind:'write_off', inputs:[{ lot, carats? }], reason }. Leave carats off an input for the WHOLE lot.

THE LOT CARD: card.lines come from the server like every card; copy them verbatim, never add, drop or recompute a line. If request_confirmation refuses, do what the error says (usually: ask the trader one thing). After saving: the Ref and one line per lot from \`lots\`. A partial save: say plainly what was saved and what was not; "retry" / "ลองใหม่" → retry_stock_op (no new card). Until it is finished nothing else can be recorded on lots.

UNDO ("undo the cutting of L13", "that split was wrong"): update_stock_op { kind:'undo', lot:'L13' } (or reference:'BPL-…' from query_lot_history; neither = the newest operation) → request_confirmation (its OWN card says what is taken back) → wait → save_transaction. Only the newest operation on a lot can be taken back; a purchase or sale only after the accountant has cancelled its bill / invoice in the books (the refusal says so; pass it on). Never "fix" a saved operation by recording the opposite one.

LOT QUESTIONS (answer from the tool, never from memory): stones are never looked up with query_stock (that is for goods counted in pieces). "what do I have" / "what does L12 cost" → query_lots, one line per lot: "<code> <what> — <carats> ct, <pieces> pcs, cost <cost> (<cost_per_ct>/ct), <place> <holder>", then the totals ("first N shown" → say so). Who has my stones / what is on memo / overdue → query_custody. Where L15 came from / what happened to L13 → query_lot_history. Correcting a description, grade, origin or asking price, or adding a lab certificate → set_lot_details (saved at once, no card); weight, pieces, cost and treatment never change that way (a treatment change is a transform), and the VAT-exempt flag and supplier document are the accountant's: tell the trader to ask them.`;
};
