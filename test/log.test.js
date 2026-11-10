const { test } = require('node:test');
const assert = require('node:assert/strict');
const log = require('../src/log');

/** Run fn with console.log captured; returns the captured lines. */
function capture(fn) {
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    fn();
  } finally {
    console.log = realLog;
  }
  return lines;
}

test('log: addresses are masked to their last 4 characters, LINE keeps its prefix', () => {
  const [wa] = capture(() => log.msgIn('whatsapp:+66812345678', 'hi'));
  assert.match(wa, /^↓ \[…5678\] \[\d\d:\d\d:\d\d\] hi$/);
  assert.doesNotMatch(wa, /66812345678/);
  const [line] = capture(() => log.msgOut('line:U4af4980629abcd', 'ok', 'onboarding'));
  assert.match(line, /^↑ \[line:…abcd\] \[\d\d:\d\d:\d\d\] \(onboarding\) ok$/);
  const [none] = capture(() => log.msgIn(null, 'x'));
  assert.match(none, /^↓ \[\?\]/);
});

test('log: bodies are flattened and cut to 160 characters', () => {
  const [flat] = capture(() => log.msgOut('+66812345678', 'line one\n  line two\n\nline three'));
  assert.ok(flat.endsWith('line one ⏎ line two ⏎ line three'), flat);
  const exact = 'a'.repeat(log.BODY_MAX);
  const [kept] = capture(() => log.msgIn('+66812345678', exact));
  assert.ok(kept.endsWith(`] ${exact}`), 'exactly 160 characters is not cut');
  const [cut] = capture(() => log.msgIn('+66812345678', `${exact}TAIL`));
  assert.ok(cut.endsWith(`] ${exact}…`), cut);
  assert.doesNotMatch(cut, /TAIL/);
});
