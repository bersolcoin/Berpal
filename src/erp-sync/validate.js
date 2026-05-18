/**
 * Central draft validator.
 *
 * Architecture: the LLM is a data-extraction layer; the server owns workflow.
 * Every write tool calls validateDraft and returns its result. The LLM's job
 * is to act on what the server says is needed — not to follow its own
 * memorized "you MUST X before Y" rules.
 *
 * Each entry in `needs[]` is one missing/insufficient piece of the draft:
 *   - field            which draft key is missing
 *   - priority         lower = ask/fix first (0 = transaction_type, 1 = core,
 *                      2 = identity, 3 = derived)
 *   - needs_user_input true  → the bot CANNOT fill this; ASK the user using
 *                              ask_user text verbatim (with conversational framing)
 *                      false → the bot CAN fix this by calling another tool
 *   - ask_user         literal text to relay to the user (only when needs_user_input)
 *   - examples         short suggestion to append for clarity
 *   - instruction      what to do when needs_user_input is false (e.g. "call
 *                      fetch_exchange_rate(...)" or "infer from message")
 *
 * The handler exposes ready_to_confirm / ready_to_save booleans so callers
 * don't have to inspect the array.
 */

function validateDraft(draft, user) {
  const needs = [];
  const tt = draft.transaction_type;

  // ── 0. Classification ────────────────────────────────────────────────
  if (!tt) {
    needs.push({
      field: 'transaction_type',
      priority: 0,
      needs_user_input: false,
      instruction: 'Classify the user message and call update_draft with transaction_type set to one of: cash | invoice_issued | bill_received | payment.',
    });
    // Without a type we can't validate the rest meaningfully.
    return summarize(needs);
  }

  // ── 1. Universals (apply to every type) ──────────────────────────────
  if (!draft.amount) {
    needs.push({
      field: 'amount',
      priority: 1,
      needs_user_input: true,
      ask_user: 'How much was the transaction?',
    });
  }
  if (!draft.currency) {
    needs.push({
      field: 'currency',
      priority: 1,
      needs_user_input: false,
      instruction: `If the user stated a currency explicitly use it; otherwise default to ${user.default_currency || 'THB'} and mark "(assumed)" in the confirmation summary.`,
    });
  }
  if (!draft.transaction_date) {
    needs.push({
      field: 'transaction_date',
      priority: 1,
      needs_user_input: false,
      instruction: "Default to today's date in ISO format (YYYY-MM-DD).",
    });
  }
  if (!draft.direction) {
    needs.push({
      field: 'direction',
      priority: 1,
      needs_user_input: false,
      instruction: 'Derive from transaction_type: invoice_issued → income; bill_received → expense; cash from verb ("paid"=expense, "received"=income); payment from settlement context.',
    });
  }

  // ── 2. Per-type identity fields (typically user input) ───────────────
  if (tt === 'invoice_issued' || tt === 'bill_received') {
    if (!draft.counterparty_name) {
      needs.push({
        field: 'counterparty_name',
        priority: 2,
        needs_user_input: true,
        ask_user: tt === 'invoice_issued' ? 'Who did you sell to?' : 'Who sent the bill?',
      });
    }
    if (!draft.payment_terms && !draft.due_date) {
      needs.push({
        field: 'payment_terms',
        priority: 2,
        needs_user_input: true,
        ask_user: 'Was it cash now or on terms (e.g. net 30, in 7 days)?',
      });
    }
    // Capture phone when creating a NEW counterparty. Server-side flag
    // _counterparty_known is set by update_draft after the cache lookup.
    // Phone is the seed for the viral on-boarding loop: if Jameel later
    // signs up to the service via this phone, we can offer to import the
    // mirror set of transactions as his purchases in one click.
    if (
      draft.counterparty_name &&
      draft._counterparty_known === false &&
      !draft.counterparty_phone &&
      !draft.counterparty_contact_skipped
    ) {
      needs.push({
        field: 'counterparty_phone',
        priority: 2,
        needs_user_input: true,
        // Two short lines — primary ask + alternative. The LLM may further
        // soften with a "Got it —" preamble. Country code inference is in
        // the prompt rules.
        ask_user: `What's ${draft.counterparty_name}'s WhatsApp number?\nOr share their contact with me.`,
      });
    }
  }

  if (tt === 'payment') {
    if (!draft.parent_invoice_ref) {
      needs.push({
        field: 'parent_invoice_ref',
        priority: 2,
        needs_user_input: false,
        instruction:
          'Find which invoice this settles. Call query_open_invoices(direction=' +
          (draft.direction === 'income' ? "'receivable'" : "'payable'") +
          ", counterparty_search=<counterparty name>). If 1 match → set parent_invoice_ref. If multiple → present them to the user with bullets (no numbers), wait for reply, then set. If 0 → ask the user which invoice or whether to log the underlying sale first.",
      });
    }
    if (!draft.payment_account_code) {
      needs.push({
        field: 'payment_account_code',
        priority: 2,
        needs_user_input: false,
        instruction: "Pick from user words: default '1000' (Cash); 'bank/transfer/wire/wired/deposited' → '1100'; 'card/credit card/visa/mastercard/amex' → '2100'.",
      });
    }
  }

  if (tt === 'cash') {
    if (!draft.payment_account_code) {
      needs.push({
        field: 'payment_account_code',
        priority: 2,
        needs_user_input: false,
        instruction: "Pick from user words: default '1000' (Cash); 'bank/transfer/wire' → '1100'; 'card' → '2100'.",
      });
    }
  }

  // ── 3. Category code (derived for non-transfers) ─────────────────────
  if (tt !== 'payment' && draft.direction !== 'transfer' && !draft.category_code) {
    needs.push({
      field: 'category_code',
      priority: 3,
      needs_user_input: false,
      instruction:
        'Pick the closest category from the chart. Decision order: (1) "purchase"/"bought goods"/"inventory"/"stock"/"parcel" → 5000 (COGS). (2) clear keyword match → that category. (3) income default → 4000. (4) expense fallback → 5900 — only when nothing else fits AND no purchase/inventory wording.',
    });
  }

  // ── 4. Wallet name (user input — for bank/card only) ─────────────────
  const code = draft.payment_account_code;
  if ((code === '1100' || code === '2100') && !draft.wallet_name) {
    const kind = code === '1100' ? 'bank' : 'card';
    const examples =
      kind === 'bank'
        ? 'e.g. BBL, SCB, KBank, HSBC'
        : 'e.g. AmEx, Visa, Mastercard';
    needs.push({
      field: 'wallet_name',
      priority: 2,
      needs_user_input: true,
      ask_user: `Which ${kind}?`,
      examples,
    });
  }

  // ── 5. FX rate (auto-fix via fetch_exchange_rate) ────────────────────
  if (
    draft.currency &&
    user.reporting_currency &&
    draft.currency !== user.reporting_currency &&
    !draft.exchange_rate
  ) {
    needs.push({
      field: 'exchange_rate',
      priority: 3,
      needs_user_input: false,
      instruction: `Call fetch_exchange_rate(from_currency='${draft.currency}', to_currency='${user.reporting_currency}', date='${draft.transaction_date || 'today'}'). Then update_draft with exchange_rate=<rate> and exchange_rate_source='frankfurter'. If the user already stated a rate, use that with exchange_rate_source='manual'.`,
    });
  }

  return summarize(needs);
}

function summarize(needs) {
  // Sort: priority asc (lower = first), then user-input items before auto-fix.
  needs.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.needs_user_input !== b.needs_user_input) {
      return a.needs_user_input ? -1 : 1;
    }
    return 0;
  });

  const next_user_question = needs.find((n) => n.needs_user_input) || null;
  return {
    ready_to_confirm: needs.length === 0,
    ready_to_save: needs.length === 0,
    needs,
    next_user_question,
  };
}

module.exports = { validateDraft };
