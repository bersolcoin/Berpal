/**
 * Countries the in-chat onboarding accepts. `name` is the ERPNext Country name (used when the
 * Company is provisioned), `currency` becomes both default_currency and reporting_currency,
 * `callingCode` turns a local accountant number ("081 234 5678") into E.164.
 */
const COUNTRIES = {
  TH: { name: 'Thailand', currency: 'THB', callingCode: '66', timezone: 'Asia/Bangkok', aliases: ['thailand', 'thai', 'ไทย', 'ประเทศไทย'] },
  MY: { name: 'Malaysia', currency: 'MYR', callingCode: '60', timezone: 'Asia/Kuala_Lumpur', aliases: ['malaysia'] },
  SG: { name: 'Singapore', currency: 'SGD', callingCode: '65', timezone: 'Asia/Singapore', aliases: ['singapore'] },
  ID: { name: 'Indonesia', currency: 'IDR', callingCode: '62', timezone: 'Asia/Jakarta', aliases: ['indonesia'] },
  VN: { name: 'Vietnam', currency: 'VND', callingCode: '84', timezone: 'Asia/Ho_Chi_Minh', aliases: ['vietnam', 'viet nam'] },
  PH: { name: 'Philippines', currency: 'PHP', callingCode: '63', timezone: 'Asia/Manila', aliases: ['philippines', 'the philippines'] },
  AU: { name: 'Australia', currency: 'AUD', callingCode: '61', timezone: 'Australia/Sydney', aliases: ['australia'] },
};

const DEFAULT_COUNTRY = 'TH';

/** "th", "Thailand", "ไทย" → "TH"; null when not one of the supported countries. */
function parseCountry(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/[.!]+$/, '').replace(/\s+/g, ' ');
  if (!s) return null;
  const upper = s.toUpperCase();
  if (COUNTRIES[upper]) return upper;
  for (const [code, c] of Object.entries(COUNTRIES)) {
    if (c.aliases.includes(s)) return code;
  }
  return null;
}

function countryInfo(code) {
  return COUNTRIES[String(code || '').toUpperCase()] || null;
}

module.exports = { COUNTRIES, DEFAULT_COUNTRY, parseCountry, countryInfo };
