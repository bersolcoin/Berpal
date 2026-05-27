/**
 * Pending-TODOs facade. Triggers across the app enqueue rows here;
 * the bot and the web /todos page both read + resolve from here.
 *
 * Each TODO kind lives in src/todos/kinds/<kind>.js and exports:
 *   {
 *     kind: 'unknown_item_purchase',
 *     bot_resolvable: true,
 *     web_resolvable: true,
 *     buildPrompt(payload): string   // what the bot says when listing
 *     resolve(user, erp, payload, userInput): Promise<{ok, ...}>
 *                                    // called when the user supplies the
 *                                    // answer (via bot or web form)
 *   }
 *
 * The shape stays tiny on purpose — every new TODO kind is just one
 * file + a registry line.
 */

const { query } = require('../db');
const { ts } = require('../log');

const KINDS = {
  unknown_item_purchase: require('./kinds/unknown-item-purchase'),
  unrecorded_link_payment: require('./kinds/unrecorded-link-payment'),
};

/**
 * Insert a TODO. Idempotent via the unique index on
 * (user_id, kind, related_name) — duplicate triggers on the same
 * source doc just no-op. payload is JSON-stringified.
 */
async function createTodo({ userId, kind, payload, relatedDoctype = null, relatedName = null }) {
  const def = KINDS[kind];
  if (!def) throw new Error(`unknown TODO kind: ${kind}`);

  const prompt = def.buildPrompt(payload);
  const now = new Date().toISOString();
  const r = await query(
    `INSERT INTO todos
       (user_id, kind, payload_json, related_doctype, related_name,
        bot_resolvable, web_resolvable, bot_prompt, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      userId,
      kind,
      JSON.stringify(payload || {}),
      relatedDoctype,
      relatedName,
      def.bot_resolvable ? 1 : 0,
      def.web_resolvable ? 1 : 0,
      prompt,
      now,
    ]
  );
  if (r.rowCount) {
    console.log(`• [todos] [${ts()}] enqueued kind=${kind} user_id=${userId} related=${relatedName || '-'} id=${r.rows[0].id}`);
    return r.rows[0].id;
  }
  return null; // already existed
}

/**
 * List a user's TODOs. `botOnly` filters to bot_resolvable=true (what
 * the WhatsApp side surfaces when the user asks "any todos?").
 */
async function listTodos(userId, { botOnly = false, limit = 50 } = {}) {
  const r = await query(
    `SELECT id, kind, payload_json, related_doctype, related_name,
            bot_resolvable, web_resolvable, bot_prompt, created_at
       FROM todos
      WHERE user_id = $1
        ${botOnly ? 'AND bot_resolvable = 1' : ''}
      ORDER BY id ASC
      LIMIT $2`,
    [userId, limit]
  );
  return r.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    payload: safeParse(row.payload_json),
    related_doctype: row.related_doctype,
    related_name: row.related_name,
    bot_resolvable: !!row.bot_resolvable,
    web_resolvable: !!row.web_resolvable,
    bot_prompt: row.bot_prompt,
    created_at: row.created_at,
  }));
}

async function getTodo(userId, todoId) {
  const r = await query(
    `SELECT id, kind, payload_json, related_doctype, related_name,
            bot_resolvable, web_resolvable, bot_prompt, created_at
       FROM todos
      WHERE id = $1 AND user_id = $2
      LIMIT 1`,
    [todoId, userId]
  );
  if (!r.rowCount) return null;
  const row = r.rows[0];
  return {
    id: row.id,
    kind: row.kind,
    payload: safeParse(row.payload_json),
    related_doctype: row.related_doctype,
    related_name: row.related_name,
    bot_resolvable: !!row.bot_resolvable,
    web_resolvable: !!row.web_resolvable,
    bot_prompt: row.bot_prompt,
    created_at: row.created_at,
  };
}

/**
 * Run the kind-specific resolver, then delete the row on success.
 * Returns whatever the resolver returns ({ok, ...}). On ok=false, the
 * row stays so the user can try again.
 */
async function resolveTodo({ user, erp, todoId, userInput }) {
  const todo = await getTodo(user.id, todoId);
  if (!todo) return { ok: false, error: `TODO ${todoId} not found` };
  const def = KINDS[todo.kind];
  if (!def) return { ok: false, error: `unknown TODO kind: ${todo.kind}` };

  const result = await def.resolve(user, erp, todo.payload, userInput || {});
  if (result?.ok) {
    await query(`DELETE FROM todos WHERE id = $1 AND user_id = $2`, [todoId, user.id]);
    console.log(`• [todos] [${ts()}] resolved id=${todoId} kind=${todo.kind} user_id=${user.id}`);
  }
  return result;
}

async function deleteTodo(userId, todoId) {
  await query(`DELETE FROM todos WHERE id = $1 AND user_id = $2`, [todoId, userId]);
}

function safeParse(s) {
  try {
    return JSON.parse(s) || {};
  } catch {
    return {};
  }
}

module.exports = { createTodo, listTodos, getTodo, resolveTodo, deleteTodo, KINDS };
