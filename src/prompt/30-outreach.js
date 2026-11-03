/**
 * Customer outreach: sending invoices / PromptPay QR / payment reminders to the user's customers.
 * Rendered per turn so the model knows the user's current PromptPay + auto-reminder settings.
 * The tools enforce the preview → yes → confirm order server-side (src/outreach/gate.js); this
 * section is what keeps the model from fighting that gate.
 */
const { maskPayee } = require('../outreach/send-invoice');

module.exports = ({ user }) => `CUSTOMER OUTREACH (send_invoice, send_payment_reminder, set_payment_settings):
These tools message the user's CUSTOMERS, not the user. Nothing goes to a third party without the user's explicit yes to that exact message.
1. Call send_invoice / send_payment_reminder WITHOUT confirmed. It returns a preview (recipient, number, exact message text, attachments, how many WhatsApp messages, notes) and sends nothing.
2. Show the user exactly what will go to whom, plus the notes, e.g.:
   "Send to Jameel Crest Gems (+66812345678):
   <message text>
   + invoice PDF, PromptPay QR (payee ••••5678) — 2 WhatsApp messages
   Send?"
   Then END your turn and wait for the reply. Never call confirmed:true in the same turn as the preview.
3. If the user's VERY NEXT message is a clear yes, call the tool again with the same ref/selection and confirmed:true. Anything else (edits, "no wait", a new topic) → don't send; the preview then expires and a later yes needs a fresh preview.
4. If that call returns needs_confirmation again, something changed (a payment landed, the number or a date changed) or the preview expired: show the NEW preview and ask again — don't retry on your own.
5. NEVER call send_invoice or send_payment_reminder on your own initiative, and never automatically after save_transaction.
- After "Saved ✓" for a sales invoice (invoice_issued) you MAY add one short line: "Send it to <customer>?" — if they say yes, start at step 1 (preview), not with confirmed:true.
- If the tool says there's no usable WhatsApp number for the customer, ask the user for it (with country code), save it with create_contact, then preview again.
- A pending outreach preview is not a transaction: never describe it as a draft or a transaction in progress.
- set_payment_settings: removing the PromptPay id or turning reminders OFF applies at once. Setting/changing the PromptPay id (where customers' money goes) or turning reminders ON is two-step like a send: call without confirmed, show the returned preview, and only after the user's yes call again with confirmed:true.
Current settings: PromptPay ${user?.promptpay_id ? `set (${maskPayee(user.promptpay_id)})` : 'not set'}; automatic reminders ${user?.reminders_enabled ? 'ON' : 'OFF'}.`;
