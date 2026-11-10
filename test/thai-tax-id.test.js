/**
 * Thai 13-digit tax id checksum (src/onboarding/thai-tax-id.js) and the accountant-phone
 * normaliser the onboarding uses.
 *
 *   npm test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeThaiTaxId, isValidThaiTaxId, formatThaiTaxId, checkDigit } = require('../src/onboarding/thai-tax-id');
const { normalizeContactPhone } = require('../src/onboarding');
const { parseCountry } = require('../src/onboarding/countries');

test('check digit: weights 13..2 over the first 12 digits, (11 − sum mod 11) mod 10', () => {
  // Commonly cited example ids (0994000165315, 1234567890121).
  assert.equal(checkDigit('099400016531'), 5);
  assert.equal(checkDigit('123456789012'), 1);
  assert.equal(checkDigit('100000000000'), 9); // 1 × 13 = 13 → mod 11 = 2 → 9
  // The edges a naive "11 − x" gets wrong: sum mod 11 = 1 → 10 → 0, and sum mod 11 = 0 → 11 → 1.
  assert.equal(checkDigit('000000000006'), 0); // 6 × 2 = 12 → mod 11 = 1
  assert.equal(checkDigit('000000000000'), 1);
});

test('three ids built by hand from the published rule are accepted; zeros are refused', () => {
  // 1-1111-11111-11-?: sum = 1×(13+12+…+2) = 90; 90 mod 11 = 2; (11 − 2) mod 10 = 9.
  // 3-1005-00000-00-?: 3×13 + 1×12 + 5×9 = 39 + 12 + 45 = 96; 96 mod 11 = 8; 11 − 8 = 3.
  // 0-1055-00000-01-?: 1×12 + 5×10 + 5×9 + 1×2 = 12 + 50 + 45 + 2 = 109; 109 mod 11 = 10; 11 − 10 = 1.
  for (const [id, wrong] of [['1-1111-11111-11-9', '1111111111110'], ['3 1005 00000 00 3', '3100500000008'], ['0-1055-00000-01-1', '0105500000012']]) {
    assert.ok(isValidThaiTaxId(id), id);
    assert.equal(normalizeThaiTaxId(wrong), null, wrong);
  }
  assert.equal(normalizeThaiTaxId('0000000000000'), null);
  assert.equal(normalizeThaiTaxId('0-0000-00000-00-1'), null, 'checksum-valid all-zero number refused');
});

test('valid ids, with or without dashes / spaces / dots', () => {
  for (const raw of ['0994000165315', '0-9940-00165-31-5', '0 9940 00165 31 5', '0.9940.00165.31.5', ' 1234567890121 ', '0105555012348']) {
    assert.ok(isValidThaiTaxId(raw), raw);
  }
  assert.equal(normalizeThaiTaxId('0-9940-00165-31-5'), '0994000165315');
  assert.equal(formatThaiTaxId('0994000165315'), '0-9940-00165-31-5');
});

test('invalid ids: wrong check digit, wrong length, letters, empty', () => {
  for (const raw of ['0994000165316', '0105555012345', '099400016531', '09940001653150', '099400016531X', 'abc', '', null, undefined, '0994-000165315a']) {
    assert.equal(normalizeThaiTaxId(raw), null, String(raw));
  }
});

test('accountant phone → E.164-ish', () => {
  assert.equal(normalizeContactPhone('081 234 5678', 'TH'), '+66812345678');
  assert.equal(normalizeContactPhone('081-234-5678', 'TH'), '+66812345678');
  assert.equal(normalizeContactPhone('+66 81 234 5678', 'TH'), '+66812345678');
  assert.equal(normalizeContactPhone('0066812345678', 'TH'), '+66812345678');
  assert.equal(normalizeContactPhone('66812345678', 'TH'), '+66812345678');
  assert.equal(normalizeContactPhone('812345678', 'TH'), '+66812345678');
  assert.equal(normalizeContactPhone('012-345 6789', 'MY'), '+60123456789');
  assert.equal(normalizeContactPhone('+65 9123 4567', 'TH'), '+6591234567');
  for (const bad of ['call me', '123', '+66 81 abc', '1+2345678', '+1234567890123456', '']) {
    assert.equal(normalizeContactPhone(bad, 'TH'), null, bad);
  }
});

test('country codes and names', () => {
  assert.equal(parseCountry('th'), 'TH');
  assert.equal(parseCountry('Thailand'), 'TH');
  assert.equal(parseCountry('ไทย'), 'TH');
  assert.equal(parseCountry('Viet Nam'), 'VN');
  assert.equal(parseCountry('the philippines'), 'PH');
  assert.equal(parseCountry('AU.'), 'AU');
  assert.equal(parseCountry('US'), null);
  assert.equal(parseCountry(''), null);
});
