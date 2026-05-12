/**
 * Minimal vCard parser. Handles the fields WhatsApp typically sends in shared contacts:
 * FN (formatted name), N (structured name), TEL, EMAIL, ORG.
 *
 * Not a full RFC 6350 implementation — just enough for our use case.
 */
function parseVCard(text) {
  const result = { name: null, phone: null, email: null, org: null };
  if (!text) return result;

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const tagPart = line.slice(0, colonIdx);
    const val = line.slice(colonIdx + 1).trim();
    const tagBase = tagPart.split(';')[0].toUpperCase();

    if (tagBase === 'FN' && !result.name) {
      result.name = val;
    } else if (tagBase === 'N' && !result.name) {
      // N format: family;given;additional;prefixes;suffixes
      const parts = val.split(';');
      const family = (parts[0] || '').trim();
      const given = (parts[1] || '').trim();
      const fullName = [given, family].filter(Boolean).join(' ');
      if (fullName) result.name = fullName;
    } else if (tagBase === 'TEL' && !result.phone) {
      // Strip any whitespace; keep + sign
      result.phone = val.replace(/\s+/g, '');
    } else if (tagBase === 'EMAIL' && !result.email) {
      result.email = val;
    } else if (tagBase === 'ORG' && !result.org) {
      // ORG can have semicolon-separated org units; take the first
      result.org = val.split(';')[0].trim();
    }
  }
  return result;
}

module.exports = { parseVCard };
