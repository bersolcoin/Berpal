/**
 * One-off setup script: creates the Twilio Content Template used for the
 * transaction confirmation message (Quick Reply with "Confirm" / "Reject").
 *
 * Run once:
 *   node scripts/create-confirmation-template.js
 * (or)
 *   npm run create-template
 *
 * Prints the resulting Content SID — copy it into .env as TWILIO_CONFIRMATION_CONTENT_SID.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
  console.error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in .env');
  process.exit(1);
}

const FRIENDLY_NAME = 'transaction_confirmation';

const payload = {
  friendly_name: FRIENDLY_NAME,
  language: 'en',
  variables: { '1': 'summary placeholder' },
  types: {
    'twilio/quick-reply': {
      body: '{{1}}',
      actions: [
        { title: 'Confirm', id: 'confirm' },
        { title: 'Reject', id: 'reject' },
      ],
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
  console.log(`  TWILIO_CONFIRMATION_CONTENT_SID=${data.sid}`);
  console.log('');
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
