/**
 * Pre-LLM short-circuit for obvious chitchat.
 * Saves API tokens by handling greetings, thanks, and help requests with canned replies.
 *
 * Patterns are deliberately tight — only match when the entire message is chitchat,
 * not when a chitchat-y word appears in real intent (e.g. "ok save it" ≠ "ok").
 */

const GREETING_REPLIES = [
  "Hi! Tell me what you bought, sold, paid, or got billed for — or ask things like \"what's outstanding?\"",
  "Hey there. Log a transaction or ask about your books — what would you like to do?",
  "Hello! Ready when you are. Log something or ask a question.",
  "Hi! What's the move — new transaction or check something on your books?",
  "Hey 👋 — log a transaction or pull up some numbers, your call.",
];

const THANKS_REPLIES = [
  "Anytime.",
  "Glad to help.",
  "No problem.",
  "Sure thing.",
  "You got it.",
  "Happy to.",
];

const FAREWELL_REPLIES = [
  "Talk soon.",
  "See you later.",
  "Catch you next time.",
  "Bye for now.",
];

const HELP_REPLIES = [
  `I help you log accounting transactions and check your books — all by chat.

Log examples:
• "paid 500 for lunch"
• "sold pa2293 to tall mike for 100k net 30"
• "got a bill from supplies for 5000 net 15"
• "tall mike paid me 100k"

Check examples:
• "what's outstanding?"
• "how much does tall mike owe me?"
• "what's due this week?"

Just type naturally — I'll figure it out.`,
];

const PATTERNS = [
  // Greetings — pure greeting only, optional trailing punctuation/emoji
  {
    regex: /^(hi|hello|hey|hola|yo|sup|sawadee|good\s*(morning|afternoon|evening|night))\W*$/i,
    replies: GREETING_REPLIES,
  },
  // Thanks
  {
    regex: /^(thanks?|thank\s*you|thx|tysm|ty|appreciate(d)?|appreciate\s*it|much\s*appreciated)\W*$/i,
    replies: THANKS_REPLIES,
  },
  // Farewells
  {
    regex: /^(bye|goodbye|see\s*ya|see\s*you|later|ttyl|cya|good\s*night)\W*$/i,
    replies: FAREWELL_REPLIES,
  },
  // Help / capability questions
  {
    regex: /^(help|\?|what\s*(can|do)\s*you\s*do|what\s*do\s*you\s*offer|how\s*(do|does)\s*(i|this)\s*(use|work)?|how\s*to\s*use|menu|commands)\W*\??$/i,
    replies: HELP_REPLIES,
  },
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Returns a canned reply string if the body is recognized chitchat, otherwise null.
 * If null, the caller should proceed to the LLM.
 */
function tryMatch(body) {
  if (!body) return null;
  const trimmed = String(body).trim();
  if (!trimmed) return null;
  for (const p of PATTERNS) {
    if (p.regex.test(trimmed)) return pickRandom(p.replies);
  }
  return null;
}

module.exports = { tryMatch };
