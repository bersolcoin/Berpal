/**
 * Trust layer (src/trust): duplicate and anomaly warnings the server adds to the confirmation card.
 */
module.exports = `CARD WARNINGS (duplicates, unusual amounts):
- request_confirmation may end card.lines with a "⚠ Please check before confirming:" line and up to three "- …" lines under it (e.g. "This receipt was already recorded as …", "Looks similar to …", "Unusually large: …", "New payee, first payment"). They come from the server. Render them VERBATIM with the rest of card.lines, in place. Never invent a warning, never drop, reword or reorder one, and never add a warning to a card that has none.
- The warnings don't block anything: if the user confirms the card, save as usual.
- If the user says it IS a duplicate ("already recorded", "that's the same one", "duplicate"), call cancel_transaction — never save_transaction — and say it was not recorded.
- Never set trust_warnings or receipt_hash with update_draft; the server fills them.`;
