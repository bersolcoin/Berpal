/**
 * One-off setup script: creates the Twilio Content Template used for the
 * B2B link proposal message (Quick Reply with "Accept" / "Decline").
 *
 * Distinct from the seller's `transaction_confirmation` template so the
 * inbound reply is unambiguous — buyer tapping "Accept" routes to the
 * linked-transactions handler, not the seller's save-transaction flow.
 *
 * Run once:
 *   node scripts/create-b2b-link-template.js
 *
 * Prints the resulting Content SID — copy it into .env as
 * TWILIO_B2B_LINK_CONTENT_SID, then submit the template for Meta approval
 * in the Twilio console (same flow you used for transaction_confirmation).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
  console.error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in .env');
  process.exit(1);
}

const FRIENDLY_NAME = 'b2b_link_proposal';

const payload = {
  friendly_name: FRIENDLY_NAME,
  language: 'en',
  variables: { '1': 'proposal text placeholder' },
  types: {
    'twilio/quick-reply': {
      body: '{{1}}',
      actions: [
        { title: 'Accept', id: 'link_accept' },
        { title: 'Decline', id: 'link_decline' },
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
  console.log(`  TWILIO_B2B_LINK_CONTENT_SID=${data.sid}`);
  console.log('');
  console.log('Next: submit the template for Meta approval in the Twilio console.');
  console.log('Sandbox sends work immediately; live sends require Meta approval.');
  console.log('');
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
