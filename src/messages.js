const { query } = require('./db');

function isLoggingEnabled() {
  return String(process.env.LOG_MESSAGES || '').toLowerCase() === 'true';
}

async function log(userId, conversationId, direction, body, rawPayload = null) {
  if (!isLoggingEnabled()) return;
  if (!userId) return;

  const now = new Date().toISOString();
  await query(
    `INSERT INTO messages (user_id, conversation_id, direction, body, raw_payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      userId,
      conversationId || null,
      direction,
      body || null,
      rawPayload ? JSON.stringify(rawPayload) : null,
      now,
    ]
  );
}

async function logIncoming(userId, conversationId, body, raw) {
  return log(userId, conversationId, 'in', body, raw);
}

async function logOutgoing(userId, conversationId, body) {
  return log(userId, conversationId, 'out', body, null);
}

module.exports = { logIncoming, logOutgoing, isLoggingEnabled };
