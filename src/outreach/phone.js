/**
 * Customer phone → Twilio WhatsApp address (whatsapp:+E164), strictly.
 *
 * A wrong guess here sends someone's invoice (and a payment QR) to a stranger, so anything
 * ambiguous is refused with a reason the model can relay, instead of being "fixed up":
 *   +E.164             "+66 81 234 5678", "+44 (0)20 7946 0018"
 *   00-prefixed        "0066812345678"
 *   national with 0    "081-234-5678" — only for the USER's own country (users.country)
 * Bare digits without + / 00 / 0 are refused: we can't tell a country code from a local number.
 */

// Country → calling code, for national-format (leading 0) numbers. Unknown country → refuse.
const CALLING_CODES = {
  TH: '66', SG: '65', MY: '60', HK: '852', IN: '91', LK: '94', AE: '971', CN: '86', JP: '81',
  GB: '44', AU: '61', DE: '49', FR: '33', CH: '41', IL: '972', BE: '32',
};
// Codes whose national trunk prefix is 0, so "+66 0812…" really means "+66 812…".
const TRUNK_ZERO = new Set(Object.values(CALLING_CODES));

function refuse(raw, why) {
  return { ok: false, error: `Can't use phone "${raw}": ${why}` };
}

function normalizePhone(raw, country = 'TH') {
  if (raw == null || !String(raw).trim()) return { ok: false, error: 'no phone number' };
  const original = String(raw).trim();
  let s = original.replace(/^whatsapp:/i, '');
  if (/ext|[a-z]/i.test(s)) return refuse(original, 'has an extension or letters — give just the mobile number');
  s = s.replace(/\(0\)/g, '').replace(/[\s\-.()]/g, '');
  if (!/^\+?\d+$/.test(s)) return refuse(original, 'contains characters that are not part of a phone number');

  // "+0…" isn't a country code; it's a local number with a stray +.
  if (s.startsWith('+0')) return refuse(original, "'+' must be followed by a country code, not 0");
  let digits;
  if (s.startsWith('+')) digits = s.slice(1);
  else if (s.startsWith('00')) digits = s.slice(2);
  else if (s.startsWith('0')) {
    const cc = CALLING_CODES[String(country || '').toUpperCase()];
    if (!cc) return refuse(original, `local format, and I don't know the calling code for country ${country || '(unset)'} — give it with +<country code>`);
    digits = cc + s.slice(1);
  } else {
    return refuse(original, 'no country code — give it as +<country code> <number>');
  }

  // "+66 0812345678": drop the national trunk 0 that people keep after the country code.
  for (const cc of TRUNK_ZERO) {
    if (digits.startsWith(`${cc}0`)) {
      digits = cc + digits.slice(cc.length + 1);
      break;
    }
  }

  if (digits.startsWith('66') && !/^66[689]\d{8}$/.test(digits)) {
    return refuse(original, 'not a Thai mobile number (+66 then 9 digits starting 6, 8 or 9)');
  }
  if (digits.length < 8 || digits.length > 15) return refuse(original, 'wrong length for an international number');
  return { ok: true, e164: `+${digits}`, address: `whatsapp:+${digits}` };
}

module.exports = { normalizePhone, CALLING_CODES };
