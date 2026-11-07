const users = require('./users');
const conversation = require('./conversation');
const messageLog = require('./messages');
const twilioClient = require('./twilio-client');
const vcard = require('./vcard');
const chitchat = require('./chitchat');
const log = require('./log');
const mediaIntake = require('./media');
const { downloadMedia } = require('./media/download');
const { cleanText } = require('./media/vision');
const onboarding = require('./onboarding');

// Goes through the media downloader so vCards get the same Twilio-host allowlist, timeout and
// size cap as photos — MediaUrl* is attacker-controllable and carries our Twilio credentials.
async function fetchTwilioMedia(url) {
  try {
    return (await downloadMedia(url)).toString('utf8');
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

/**
 * The "[contact shared] {json}" line the model reads. vCard fields are sender-controlled, so they
 * get the same treatment as scan values (src/media/vision.js): each value goes through cleanText
 * (brackets, braces, newlines, control/bidi characters stripped) and the line is JSON, so a value
 * can't close the line, fake another one, or pose as another key. null if nothing is left.
 */
function contactLine(contact) {
  const out = {};
  for (const [key, label] of [['name', 'name'], ['phone', 'phone'], ['email', 'email'], ['org', 'organization']]) {
    const v = cleanText(contact[key]);
    if (v) out[label] = v;
  }
  return Object.keys(out).length ? `[contact shared] ${JSON.stringify(out)}` : null;
}

// Per-user FIFO: a receipt scan or transcription takes seconds, and a typed follow-up ("put it on
// the AmEx") must not reach the conversation before the scan it refers to. Messages from
// different users still run concurrently.
const queues = new Map();

function processIncomingMessage(args) {
  const key = users.normalizePhone(args.from) || String(args.from);
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.then(() => processOne(args));
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

async function processOne({ from, body, raw = null }) {
  let user = null;
  let mediaIds = [];
  let loggedIn = false;
  try {
    user = await users.findByPhone(from);

    // Unknown number: the in-chat signup (src/onboarding) — deterministic, no LLM. null = rate-limited.
    // Onboarding logs the message and reply itself: tax-ID / accountant answers are masked there.
    if (!user) {
      loggedIn = true;
      const reply = await onboarding.handleUnknownPhone(from, body);
      if (reply) await twilioClient.sendText(from, reply);
      return;
    }

    log.msgIn(from, body);
    loggedIn = true;

    // Account-level replies before anything else: books not provisioned yet, closed account,
    // "delete my account". null for an active user with nothing pending.
    const accountReply = await onboarding.handleRegistered(user, body);
    if (accountReply) {
      log.msgOut(from, accountReply, 'account');
      await twilioClient.sendText(from, accountReply);
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

    // Receipt photos / PDFs are scanned and voice notes transcribed before the LLM sees the
    // message, so the model only ever deals with text (same idea as the vCard line below).
    const media = await mediaIntake.intake(user, raw, body);
    mediaIds = media.mediaIds;
    if (media.silent) return;
    if (media.reply) {
      await messageLog.logOutgoing(user.id, conv.id, media.reply);
      log.msgOut(from, media.reply, 'media');
      await twilioClient.sendText(from, media.reply);
      return;
    }

    let augmentedBody = body || '';
    if (media.transcript) {
      // The prefix tells the model this came from speech, so it echoes back what it understood.
      const spoken = `[voice note] ${media.transcript}`;
      augmentedBody = augmentedBody ? `${augmentedBody}\n${spoken}` : spoken;
    }
    for (const line of media.lines) {
      augmentedBody = augmentedBody ? `${augmentedBody}\n${line}` : line;
    }

    // If the user shared a WhatsApp contact (vCard attachment), parse it and inject into the message.
    const contact = await extractContactShare(raw);
    const synthetic = contact && contactLine(contact);
    if (synthetic) {
      augmentedBody = augmentedBody ? `${augmentedBody}\n${synthetic}` : synthetic;
      // Contact details are personal data: log which fields arrived and their lengths, never values.
      const lengths = ['name', 'phone', 'email', 'org'].filter((k) => contact[k]).map((k) => `${k}=${String(contact[k]).length}`);
      console.log(`[whatsapp] vcard parsed: ${lengths.join(' ')}`);
    }

    let result;
    try {
      result = await conversation.handle(user, augmentedBody, { voiceTranscript: media.transcript || null });
    } catch (err) {
      console.error('[whatsapp] conversation error:', err);
      // The draft that would have carried these receipts never formed; don't keep the images.
      await mediaIntake.discard(user.id, mediaIds);
      await twilioClient.sendText(from, 'Sorry, something went wrong. Please try again.');
      return;
    }

    // handle() returns { text, isConfirmation }; tolerate a bare string so a reply is never lost.
    const { text, isConfirmation } = typeof result === 'string' ? { text: result, isConfirmation: false } : result || {};

    await messageLog.logOutgoing(user.id, conv.id, text);

    if (isConfirmation && text) {
      log.msgOut(from, text, 'template');
      await twilioClient.sendConfirmation(from, text);
    } else if (text) {
      log.msgOut(from, text);
      await twilioClient.sendText(from, text);
    }
  } catch (err) {
    // Lookup failed before we knew whether this is a signup answer: don't log the body.
    if (!loggedIn) log.msgIn(from, '[message not shown: user lookup failed]');
    console.error('[whatsapp] processing error:', err);
    if (user && mediaIds.length) await mediaIntake.discard(user.id, mediaIds);
    try {
      await twilioClient.sendText(from, 'Sorry, something went wrong. Please try again.');
    } catch (sendErr) {
      console.error('[whatsapp] also failed to send error reply:', sendErr.message);
    }
  }
}

module.exports = { processIncomingMessage, contactLine };
