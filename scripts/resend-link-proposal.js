/**
 * Re-send a B2B link proposal to the responder. Useful when the original
 * Twilio send was accepted but WhatsApp didn't deliver (sandbox session
 * lapsed, recipient re-joined, etc.) — the linked_transactions row still
 * exists and can be re-proposed without re-creating any ERPNext docs.
 *
 *   node scripts/resend-link-proposal.js <LINK_ID>
 *   node scripts/resend-link-proposal.js 7
 *
 * Only re-sends rows in status='pending_buyer_confirmation' or
 * 'pending_buyer_signup'. Refuses rows that are already confirmed /
 * rejected / cancelled (those would create double-posting hazards).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, init } = require('../src/db');
const twilio = require('../src/twilio-client');

function fmtMoney(n, ccy) {
  return `${ccy} ${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildProposalMessage({ initiatorLabel, initiatedByBuyer, items, currency, totalAmount, paymentContext }) {
  const itemLines = (items || [])
    .map((it) => `• ${it.qty} × ${it.description || ''} @ ${fmtMoney(it.rate, currency)} = ${fmtMoney(it.amount, currency)}`)
    .join('\n');

  let paymentLine = '';
  if (paymentContext?.type === 'cash') {
    paymentLine = initiatedByBuyer
      ? `\nPayment: paid in cash${paymentContext.label ? ` (${paymentContext.label})` : ''}`
      : `\nPayment: received in cash${paymentContext.label ? ` (${paymentContext.label})` : ''}`;
  } else if (paymentContext?.type === 'bank' || paymentContext?.type === 'card') {
    const noun = paymentContext.type === 'card' ? 'card' : 'bank';
    paymentLine = initiatedByBuyer
      ? `\nPayment: paid via ${noun}${paymentContext.label ? ` (${paymentContext.label})` : ''}`
      : `\nPayment: received to ${noun}${paymentContext.label ? ` (${paymentContext.label})` : ''}`;
  } else if (paymentContext) {
    paymentLine = `\nPayment: on credit (no payment yet)`;
  }

  const verb = initiatedByBuyer ? 'bought from you' : 'sold you';
  return (
    `🔗 ${initiatorLabel} says they ${verb}:\n\n` +
    `${itemLines || `Amount: ${fmtMoney(totalAmount, currency)}`}\n` +
    `Total: ${fmtMoney(totalAmount, currency)}${paymentLine}`
  );
}

function safeParseItems(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

(async () => {
  await init();

  const linkId = Number(process.argv[2]);
  if (!linkId || Number.isNaN(linkId)) {
    console.error('Usage: node scripts/resend-link-proposal.js <LINK_ID>');
    console.error('       e.g. node scripts/resend-link-proposal.js 7');
    process.exit(1);
  }

  const r = await query(`SELECT * FROM linked_transactions WHERE id = $1`, [linkId]);
  if (!r.rowCount) {
    console.error(`LINK-${linkId} not found.`);
    process.exit(2);
  }
  const row = r.rows[0];

  if (!['pending_buyer_confirmation', 'pending_buyer_signup'].includes(row.status)) {
    console.error(`LINK-${linkId} is in status='${row.status}' — won't re-send. Resend only applies to pending rows.`);
    process.exit(3);
  }

  // Identify the initiator (whose company name shows in the proposal)
  // and the responder (whose phone we're sending to).
  const initiatedByBuyer = !!row.initiated_by_buyer;
  const initiatorUserId = initiatedByBuyer ? row.buyer_user_id : row.seller_user_id;
  const responderUserId = initiatedByBuyer ? row.seller_user_id : row.buyer_user_id;

  const initiator = (await query(`SELECT id, erpnext_company, display_name FROM users WHERE id = $1`, [initiatorUserId])).rows[0];
  if (!initiator) {
    console.error(`initiator user id=${initiatorUserId} not found`);
    process.exit(4);
  }

  // Responder phone: prefer the bound user's phone, fall back to buyer_phone.
  let responderPhone = row.buyer_phone;
  if (responderUserId) {
    const responder = (await query(`SELECT phone FROM users WHERE id = $1`, [responderUserId])).rows[0];
    if (responder?.phone) responderPhone = responder.phone;
  }
  if (!responderPhone) {
    console.error('no responder phone on the row — cannot re-send.');
    process.exit(5);
  }

  const initiatorLabel = initiator.erpnext_company || initiator.display_name || 'A Berpal user';
  const paymentContext = row.seller_paid_now
    ? { type: row.seller_wallet_type || 'cash', label: row.seller_wallet_label }
    : { type: null };
  const body = buildProposalMessage({
    initiatorLabel,
    initiatedByBuyer,
    items: safeParseItems(row.items),
    currency: row.currency,
    totalAmount: row.total_amount,
    paymentContext,
  });

  console.log(`Re-sending LINK-${linkId} to ${responderPhone}…`);
  console.log('---');
  console.log(body);
  console.log('---');

  const messageSid = await twilio.sendB2BLinkProposal(responderPhone, body);
  if (!messageSid) {
    console.error('send failed (no message_sid returned). Check the [twilio] log lines above for the underlying error.');
    process.exit(6);
  }

  await query(
    `UPDATE linked_transactions
       SET proposal_message_sid = $1, updated_at = $2
     WHERE id = $3`,
    [messageSid, new Date().toISOString(), linkId]
  );

  console.log(`✓ Re-sent LINK-${linkId}. message_sid=${messageSid}`);
  console.log(`If WhatsApp still doesn't show it on B's side, check Twilio Console → Messaging → Logs → ${messageSid} for delivery status.`);
  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
