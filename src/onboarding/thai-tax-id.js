/**
 * Thai 13-digit tax id (เลขประจำตัวผู้เสียภาษีอากร — the same number as a national id for a
 * person, or the juristic-person id for a company). The 13th digit is a mod-11 check digit:
 *
 *   sum   = Σ digit[i] × (13 − i)   for i = 0..11   (weights 13, 12, …, 2)
 *   check = (11 − sum mod 11) mod 10
 *
 * Users type it with dashes or spaces ("0-1055-55012-34-5"), so formatting is stripped first.
 */

/** Digits only, or null when anything but digits / dashes / spaces / dots was typed. */
function stripFormatting(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || /[^\d\s\-.]/.test(s)) return null;
  return s.replace(/\D/g, '');
}

function checkDigit(first12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
  return (11 - (sum % 11)) % 10;
}

/** The 13 digits when `raw` is a valid Thai tax id (formatting allowed), else null. */
function normalizeThaiTaxId(raw) {
  const digits = stripFormatting(raw);
  if (!digits || digits.length !== 13) return null;
  // 000000000000 + check digit 1 passes the checksum but is no one's number.
  if (/^0{12}/.test(digits)) return null;
  return checkDigit(digits) === Number(digits[12]) ? digits : null;
}

function isValidThaiTaxId(raw) {
  return normalizeThaiTaxId(raw) != null;
}

/** "0105555012345" → "0-1055-55012-34-5" (the way it is printed on Thai tax documents). */
function formatThaiTaxId(digits) {
  const d = String(digits || '');
  if (!/^\d{13}$/.test(d)) return d;
  return `${d[0]}-${d.slice(1, 5)}-${d.slice(5, 10)}-${d.slice(10, 12)}-${d[12]}`;
}

module.exports = { normalizeThaiTaxId, isValidThaiTaxId, formatThaiTaxId, checkDigit };
