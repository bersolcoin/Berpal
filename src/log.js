function ts() {
  return new Date().toTimeString().slice(0, 8);
}

function shortPhone(addr) {
  if (!addr) return '?';
  return String(addr).replace(/^whatsapp:/i, 'W');
}

function flatten(body) {
  return String(body || '').replace(/\s*\n\s*/g, ' ⏎ ');
}

function msgIn(phone, body) {
  console.log(`↓ [${shortPhone(phone)}] [${ts()}] ${flatten(body)}`);
}

function msgOut(phone, body, channel) {
  const tag = channel ? ` (${channel})` : '';
  console.log(`↑ [${shortPhone(phone)}] [${ts()}]${tag} ${flatten(body)}`);
}

module.exports = { msgIn, msgOut };
