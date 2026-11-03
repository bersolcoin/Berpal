/**
 * Thai PromptPay QR payloads (EMVCo Merchant-Presented QR, Thai QR Payment profile).
 *
 * A payload is a flat list of TLV fields: 2-digit tag, 2-digit decimal length, value.
 *   00 payload format indicator   "01"
 *   01 point of initiation        "11" static (payer types the amount) | "12" one-off with amount
 *   29 merchant account (PromptPay), nested TLV:
 *        00 AID "A000000677010111"
 *        01 mobile   — 13 digits: country code 66, leading 0 dropped, left-padded with 0s
 *                      (0812345678 → 0066812345678)
 *        02 national / tax id — 13 digits
 *        03 e-wallet id       — 15 digits
 *   58 country "TH"
 *   53 currency "764" (ISO 4217 numeric for THB)
 *   54 amount, 2 decimals (only when fixed)
 *   63 CRC-16/CCITT-FALSE over the whole string INCLUDING the "6304" tag+length, 4 uppercase hex
 *
 * Field order follows the widely deployed promptpay-qr reference implementation (58 before 53)
 * so our payloads are byte-identical to what Thai banking apps already accept from it.
 */
const QRCode = require('qrcode');

const AID_PROMPTPAY = 'A000000677010111';
const TARGET_TAG = { mobile: '01', tax_id: '02', ewallet: '03' };

function tlv(tag, value) {
  const v = String(value);
  return `${tag}${String(v.length).padStart(2, '0')}${v}`;
}

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final XOR. */
function crc16(str) {
  let crc = 0xffff;
  for (const byte of Buffer.from(str, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Classify + normalise a PromptPay id. Length decides the type, as PromptPay itself does:
 * 15 digits → e-wallet, 13 → national/tax id, otherwise a mobile number.
 *   returns { type, value } or null if it can't be a PromptPay id.
 */
function parseTarget(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  if (digits.length === 15) return { type: 'ewallet', value: digits };
  // 13 digits is always a national/tax id — even "0066…", which is also the mobile wire format.
  // An id typed as the user's own mobile is never 13 digits, so precedence costs nothing.
  if (digits.length === 13) return { type: 'tax_id', value: digits };
  // Mobile: accept 0812345678, 66812345678, +66 81 234 5678, +66 0812345678.
  let local = null;
  if (/^0\d{9}$/.test(digits)) local = digits.slice(1);
  else if (/^66\d{9}$/.test(digits)) local = digits.slice(2);
  else if (/^660\d{9}$/.test(digits)) local = digits.slice(3);
  if (!local) return null;
  return { type: 'mobile', value: `0066${local}` };
}

/**
 *   target: mobile number, 13-digit national/tax id, or 15-digit e-wallet id
 *   amount: optional fixed amount in THB → dynamic (12) QR; omitted → static (11) QR
 */
function buildPayload(target, { amount = null } = {}) {
  const t = parseTarget(target);
  if (!t) throw new Error(`invalid PromptPay id: ${target}`);
  let hasAmount = false;
  let amountStr = null;
  if (amount != null && amount !== '') {
    const n = typeof amount === 'number' ? amount : /^\s*\d+(\.\d+)?\s*$/.test(String(amount)) ? Number(amount) : NaN;
    if (!Number.isFinite(n) || n < 0) throw new Error(`invalid PromptPay amount: ${amount}`);
    // toFixed switches to exponent notation from 1e21; refuse long before that.
    if (n >= 1e13) throw new Error(`PromptPay amount too large: ${amount}`);
    amountStr = n.toFixed(2);
    // Tag 54 is at most 13 chars (EMVCo); anything longer is a garbage amount, not a payment.
    if (amountStr.length > 13) throw new Error(`PromptPay amount too large: ${amount}`);
    hasAmount = n > 0;
  }
  const fields = [
    tlv('00', '01'),
    tlv('01', hasAmount ? '12' : '11'),
    tlv('29', tlv('00', AID_PROMPTPAY) + tlv(TARGET_TAG[t.type], t.value)),
    tlv('58', 'TH'),
    tlv('53', '764'),
  ];
  if (hasAmount) fields.push(tlv('54', amountStr));
  const body = `${fields.join('')}6304`;
  return body + crc16(body);
}

/** PNG bytes of the QR for a payload. Medium error correction + margin so phone cameras lock on fast. */
function renderPng(payload) {
  return QRCode.toBuffer(payload, { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 512 });
}

module.exports = { buildPayload, parseTarget, crc16, renderPng, tlv };
