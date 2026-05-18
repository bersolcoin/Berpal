/**
 * Manual provisioning CLI — useful for testing the flow against ERPNext
 * before wiring it to the web signup form.
 *
 * INTERACTIVE: just run `node scripts/provision.js` and answer the prompts.
 * No CLI arg quoting required.
 *
 * Notes:
 *   - business_name is the LEGAL ENTITY (becomes ERPNext Company name)
 *   - display_name is the PERSON'S name (in the web app, that's normally
 *     pulled from WhatsApp ProfileName)
 *   - country must match an ERPNext-supported country exactly (e.g.
 *     "Thailand", "United States", "India", "Singapore", "Hong Kong")
 *   - email is optional; a synthetic one is generated if blank
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const readline = require('readline');
const { provisionTenant } = require('../src/erp-sync/provision');

function prompt(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

(async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n── Provision a new tenant ──────────────────');
  console.log('(press Ctrl+C to cancel at any prompt)\n');

  const phone = await prompt(rl, 'Phone (E.164, e.g. +85259608836): ');
  const business_name = await prompt(rl, 'Business / Company name: ');
  const country = await prompt(rl, 'Country (e.g. Hong Kong, Thailand, United States): ');
  const currency = await prompt(rl, 'Currency (ISO, e.g. HKD, THB, USD): ');
  const display_name = await prompt(rl, "Your display name (optional, press Enter to skip): ");
  const email = await prompt(rl, 'Email (optional, press Enter for synthetic): ');

  rl.close();

  if (!phone || !business_name || !country || !currency) {
    console.error('\nMissing required field. Need phone, business_name, country, currency.');
    process.exit(1);
  }

  console.log('\n──────────────────────────────────────────');
  console.log('Provisioning with:');
  console.log(`  phone:         ${phone}`);
  console.log(`  business_name: ${business_name}`);
  console.log(`  country:       ${country}`);
  console.log(`  currency:      ${currency}`);
  console.log(`  display_name:  ${display_name || '(none)'}`);
  console.log(`  email:         ${email || '(synth)'}`);
  console.log('──────────────────────────────────────────\n');

  const result = await provisionTenant({
    phone,
    business_name,
    country,
    currency,
    display_name: display_name || null,
    email: email || null,
  });

  console.log('\n──────────────────────────────────────────');
  console.log('Result:');
  console.log(JSON.stringify(result, null, 2));
  console.log('──────────────────────────────────────────');
  process.exit(result.ok ? 0 : 1);
})().catch((err) => {
  console.error('\nFATAL:', err.message);
  if (err.response) console.error('response:', JSON.stringify(err.response).slice(0, 600));
  process.exit(1);
});
