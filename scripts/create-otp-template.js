/**
 * One-off setup script: creates the Twilio Content Template for OTP delivery.
 *
 * Run once:
 *   node scripts/create-otp-template.js
 *
 * Prints the resulting Content SID — copy it into .env as TWILIO_OTP_CONTENT_SID.
 *
 * Why a template:
 *   The live WhatsApp Business sender requires an approved template for the
 *   FIRST outbound message to a user (and for any message outside an active
 *   24-hour conversation window). Plain-text sends only work for active
 *   conversations or the Sandbox.
 *
 * Submission flow after creation:
 *   1. Template is created but NOT yet approved by Meta.
 *   2. Submit for approval via Twilio Console → Messaging → Content Template Builder.
 *      Auth template category recommended (faster approval for OTPs).
 *   3. Once approved, this template's SID can be used in production.
 *
 * For sandbox testing, the bot falls back to plain-text WhatsApp — no template required.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
  console.error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in .env');
  process.exit(1);
}

const FRIENDLY_NAME = 'berpal_otp_v3';

// Plain Utility-category template — bare minimum text, no emoji, no markdown,
// no consecutive newlines, plenty of plain text around the parameter.
// Meta's strict OTP-category rules made the fancier templates fail; this
// minimal version should pass cleanly.
const payload = {
  friendly_name: FRIENDLY_NAME,
  language: 'en',
  variables: { '1': '123456' },
  types: {
    'twilio/text': {
      body: 'Your Berpal verification code is {{1}}. It expires in 10 minutes. Do not share this code with anyone.',
    },
  },
};

(async () => {
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  console.log(`Creating Twilio content template "${FRIENDLY_NAME}"...`);

  const response = await fetch('https://content.twilio.com/v1/Content', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('Failed to create template:');
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log('');
  console.log('Template created successfully.');
  console.log('');
  console.log(`  Content SID:    ${data.sid}`);
  console.log(`  Friendly name:  ${data.friendly_name}`);
  console.log(`  Language:       ${data.language}`);
  console.log('');
  console.log('Add this line to your .env file (do not commit it):');
  console.log('');
  console.log(`  TWILIO_OTP_CONTENT_SID=${data.sid}`);
  console.log('');
  console.log('Next steps for production:');
  console.log('  1. Open Twilio Console → Messaging → Content Template Builder');
  console.log(`  2. Find "${FRIENDLY_NAME}" and submit for WhatsApp approval`);
  console.log('     (Category: Authentication for faster approval)');
  console.log('  3. Once approved, the live sender can use it for first-touch OTPs');
  console.log('');
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
