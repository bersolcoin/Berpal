const users = require('./users');
const conversation = require('./conversation');
const messageLog = require('./messages');
const twilioClient = require('./twilio-client');
const vcard = require('./vcard');
const chitchat = require('./chitchat');
const log = require('./log');
const linkedTxn = require('./links/linked-transactions');

function registrationLinkReply() {
  // APP_URL is the public origin for the current environment, e.g.
  // https://berpal.ber.fun in prod, http://localhost:3000 in dev.
  const base = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  return (
    `Hi! It looks like your number isn't registered yet. Sign up at ${base} to link your WhatsApp number to your account.`
  );
}

async function fetchTwilioMedia(url) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return null;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  try {
    const response = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!response.ok) {
      console.error(`[whatsapp] failed to fetch media: ${response.status} ${url}`);
      return null;
    }
    return await response.text();
  } catch (err) {
    console.error('[whatsapp] media fetch error:', err.message);
    return null;
  }
}

async function extractContactShare(raw) {
  if (!raw) return null;
  const numMedia = parseInt(raw.NumMedia || '0', 10);
  if (!numMedia) return null;
  for (let i = 0; i < numMedia; i++) {
    const contentType = raw[`MediaContentType${i}`];
    const mediaUrl = raw[`MediaUrl${i}`];
    if (contentType && /vcard/i.test(contentType) && mediaUrl) {
      const text = await fetchTwilioMedia(mediaUrl);
      if (text) {
        const parsed = vcard.parseVCard(text);
        if (parsed.name || parsed.phone) return parsed;
      }
    }
  }
  return null;
}

async function processIncomingMessage({ from, body, raw = null }) {
  try {
    log.msgIn(from, body);

    const user = await users.findByPhone(from);

    if (!user) {
      const reply = registrationLinkReply();
      log.msgOut(from, reply, 'unknown_phone');
      await twilioClient.sendText(from, reply);
      return;
    }

    // Capture WhatsApp ProfileName as the user's display_name (only sets it
    // if not already populated — preserves any name the user set explicitly).
    if (raw?.ProfileName) {
      await users.captureProfileName(user.id, raw.ProfileName);
    }

    const conv = await conversation.loadConversation(user.id);
    await messageLog.logIncoming(user.id, conv.id, body, raw);

    // Pre-LLM short-circuit: handle obvious chitchat (greetings, thanks, help) without an API call.
    // Skip if the user shared media (vCard etc.) — that always carries real intent.
    const hasMedia = raw && parseInt(raw.NumMedia || '0', 10) > 0;
    if (!hasMedia) {
      const cannedReply = chitchat.tryMatch(body || '');
      if (cannedReply) {
        await messageLog.logOutgoing(user.id, conv.id, cannedReply);
        log.msgOut(from, cannedReply, 'chitchat');
        await twilioClient.sendText(from, cannedReply);
        return;
      }

      // B2B link acceptance/rejection: buyer replies "yes LINK-N" / "no LINK-N"
      // (or taps Accept / Decline on the template) for a proposed linked
      // Sales Invoice. Handled out-of-band from the LLM. `raw` is forwarded
      // so the handler can read OriginalRepliedMessageSid for button replies.
      try {
        const linkReply = await linkedTxn.tryHandleLinkCommand(user, body || '', raw);
        if (linkReply) {
          await messageLog.logOutgoing(user.id, conv.id, linkReply);
          log.msgOut(from, linkReply, 'linked-txn');
          await twilioClient.sendText(from, linkReply);
          return;
        }
      } catch (err) {
        console.error('[whatsapp] link command handler error:', err.message);
      }

      // Follow-up state after Accept: if the buyer was asked "which wallet?"
      // and has a parked pending_buyer_wallet_pick row, route their reply
      // here (a number, a wallet name, or "skip"). Falls through to LLM
      // if no parked row matches.
      try {
        const { tryHandleWalletPick } = require('./links/buyer-wallet-pick');
        const walletReply = await tryHandleWalletPick(user, body || '', raw);
        if (walletReply) {
          await messageLog.logOutgoing(user.id, conv.id, walletReply);
          log.msgOut(from, walletReply, 'linked-txn');
          await twilioClient.sendText(from, walletReply);
          return;
        }
      } catch (err) {
        console.error('[whatsapp] wallet-pick handler error:', err.message);
      }
    }

    // If the user shared a WhatsApp contact (vCard attachment), parse it and inject into the message.
    let augmentedBody = body || '';
    const contact = await extractContactShare(raw);
    if (contact) {
      const parts = [];
      if (contact.name) parts.push(`name: ${contact.name}`);
      if (contact.phone) parts.push(`phone: ${contact.phone}`);
      if (contact.email) parts.push(`email: ${contact.email}`);
      if (contact.org) parts.push(`organization: ${contact.org}`);
      const synthetic = `[contact shared — ${parts.join(', ')}]`;
      augmentedBody = augmentedBody ? `${augmentedBody}\n${synthetic}` : synthetic;
      console.log(`[whatsapp] vcard parsed: ${parts.join(', ')}`);
    }

    let result;
    try {
      result = await conversation.handle(user, augmentedBody);
    } catch (err) {
      console.error('[whatsapp] conversation error:', err);
      await twilioClient.sendText(from, 'Sorry, something went wrong. Please try again.');
      return;
    }

    const { text, isConfirmation } = result;

    await messageLog.logOutgoing(user.id, conv.id, text);

    // A "well-formed confirmation" is ANY text containing Date: and Amount:
    // lines — that's the canonical card shape. We promote it to a template
    // (button) card EVEN IF the LLM forgot to call request_confirmation,
    // which happens after corrections (LLM updates the draft but skips the
    // re-confirmation tool call). Trust the data, not the LLM's discipline.
    const hasCardShape =
      text &&
      /\bAmount:/i.test(text) &&
      /\bDate:/i.test(text);

    if (hasCardShape) {
      // Note when we're auto-promoting (LLM didn't call request_confirmation
      // but the message body is clearly a confirmation card).
      if (!isConfirmation) {
        console.log('[whatsapp] auto-promoting card-shaped reply to template (LLM omitted request_confirmation)');
      }
      log.msgOut(from, text, 'template');
      await twilioClient.sendConfirmation(from, text);
    } else if (isConfirmation && text) {
      // LLM called request_confirmation but the body has no card shape —
      // surface honestly instead of sending a stub card.
      const fallback =
        "I got partway but couldn't put together a clean summary card. Can you rephrase the transaction in one line? (e.g. \"sold paraiba 5ct to Acme Trading for 20000 USD net 30\")";
      console.warn(`[whatsapp] suppressed degenerate confirmation card. LLM reply was: ${text.slice(0, 200)}`);
      log.msgOut(from, fallback);
      await twilioClient.sendText(from, fallback);
    } else if (text) {
      log.msgOut(from, text);
      await twilioClient.sendText(from, text);
    }
  } catch (err) {
    console.error('[whatsapp] processing error:', err);
    try {
      await twilioClient.sendText(from, 'Sorry, something went wrong. Please try again.');
    } catch (sendErr) {
      console.error('[whatsapp] also failed to send error reply:', sendErr.message);
    }
  }
}

module.exports = { processIncomingMessage };
