const { maskAddress } = require('./channels/address');

// The server log is not the message store (src/messages.js is): addresses are masked to their
// last 4 characters and bodies cut to a glance, so a log leak exposes neither.
const BODY_MAX = 160;

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

function shortPhone(addr) {
  if (!addr) return '?';
  return maskAddress(addr);
}

function flatten(body) {
  const s = String(body || '').replace(/\s*\n\s*/g, ' ⏎ ');
  return s.length > BODY_MAX ? `${s.slice(0, BODY_MAX)}…` : s;
}

function msgIn(phone, body) {
  console.log(`↓ [${shortPhone(phone)}] [${ts()}] ${flatten(body)}`);
}

function msgOut(phone, body, channel) {
  const tag = channel ? ` (${channel})` : '';
  console.log(`↑ [${shortPhone(phone)}] [${ts()}]${tag} ${flatten(body)}`);
}

module.exports = { msgIn, msgOut, BODY_MAX };
