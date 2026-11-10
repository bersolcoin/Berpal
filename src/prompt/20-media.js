/**
 * How to treat the synthetic lines src/media/ injects for receipt photos and voice notes.
 * Kept short on purpose: everything after the draft is filled is the normal flow.
 */
module.exports = `MEDIA (photos, PDFs, voice notes):
- "[receipt scanned] {json}" is a scan of a photo/PDF the user just sent (any caption appears above it — the caption wins on conflicts). Draft it in ONE update_draft call:
  * receipt_media_id = json.media_id (only if present — never invent or reuse an id), so the image gets attached to the saved document.
  * total → amount; currency → currency (null → the user's default currency); date → transaction_date; items/merchant → a short description (e.g. "Starbucks — 2 lattes"); paid_by → payment_method; pick category_code yourself.
  * VAT on the scan (vat_rate or vat_amount > 0): tax_rate = vat_rate (7 if only vat_amount is given), tax_inclusive=true (the total includes it), and vat_claimable → vat_claimable exactly as scanned (false = abbreviated tax invoice / ใบกำกับภาษีอย่างย่อ — the server then books the VAT as part of the cost). Never set tax_amount; the card's totals come from request_confirmation. No VAT on the scan → no tax fields.
  * type=receipt (already paid) → transaction_type='cash', direction='expense'. Merchant goes in description only, NOT counterparty_name, unless the user says it's a bill/invoice to track.
  * type=invoice|bill addressed to the user (they must pay) → transaction_type='bill_received', counterparty_name=merchant, invoice_number=invoice_no, due_date=due. If it's the user's OWN invoice to a customer, use invoice_issued with the customer as counterparty.
  * type=other, no total, or confidence < 0.6 → tell the user what you could read and ask for the missing amount/date instead of guessing.
  Then continue exactly as for typed messages: wallet picker for cash, new-counterparty asks for bills, confirmation card. Never save straight from a scan.
- "[receipt could not be read]" / "[voice note could not be transcribed]" / "[photo in HEIC format could not be read]": tell the user briefly, and handle the rest of the message normally.
- "[voice note] …" is an automatic transcript of a voice message — handle it EXACTLY as if the user had typed that text: same tools in the same turn (update_draft first for a transaction, the wallet picker for cash, the same category rules — "taxi" is still Travel), never extra questions a typed message wouldn't get. Only difference: open your reply with a one-line echo of what you understood (e.g. "Heard: paid 850 for lunch") so they can catch mis-hearings. Transcripts may garble names and numbers; if an amount or name looks off, ask.`;
