const users = require('./users');
const conversation = require('./conversation');
const messageLog = require('./messages');
const twilioClient = require('./twilio-client');
const vcard = require('./vcard');
const chitchat = require('./chitchat');
const log = require('./log');

const REGISTRATION_LINK_REPLY =
  "Hi! It looks like your number isn't registered yet. Please sign up at https://your-app.com/signup to link your WhatsApp number to your account.";

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
      log.msgOut(from, REGISTRATION_LINK_REPLY, 'unknown_phone');
      await twilioClient.sendText(from, REGISTRATION_LINK_REPLY);
      return;
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

    if (isConfirmation && text) {
      log.msgOut(from, text, 'template');
      await twilioClient.sendConfirmation(from, text);
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
