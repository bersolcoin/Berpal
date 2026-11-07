/**
 * Every fixed reply the onboarding / account flows send. Deterministic text (no LLM), so it is
 * cheap and the tests can assert on it exactly.
 */

const { RETENTION_DAYS } = require('../media/store');

// Identifies the notice text below: bump it whenever CONSENT_NOTICE changes (users.consent_version
// records which one a user agreed to). v2: receipt retention corrected from "90 days" to the real one.
const CONSENT_VERSION = '2026-11-pdpa-v2';

const FOOTER = '\n\n(back = previous question · cancel = stop)';

const INVITE_ONLY =
  "Hi! Berpal is invite-only for now. If you have an invite code, send it here to get started.\n" +
  'ขณะนี้ Berpal เปิดให้ใช้เฉพาะผู้ที่ได้รับเชิญ หากมีรหัสเชิญ กรุณาส่งรหัสมาที่นี่';

const WELCOME =
  "Hi! I'm Berpal — I keep your business books from WhatsApp. Let's set you up; it takes about a minute.\n" +
  'สวัสดีครับ มาเริ่มตั้งค่าบัญชีกันครับ';

const PROMPTS = {
  name: 'What is the name of your business? (as it should appear on your books)',
  country: 'Which country is the business in? Reply with a code or a name: TH, MY, SG, ID, VN, PH or AU. (Reply skip for Thailand.)',
  vat: 'Is the business VAT-registered? Reply yes or no.\nจดทะเบียนภาษีมูลค่าเพิ่มหรือไม่ — ตอบ ใช่ / ไม่',
  tax_id_th: "What is the business's 13-digit tax ID (เลขประจำตัวผู้เสียภาษี)? Dashes or spaces are fine. Reply skip to add it later.",
  tax_id_other: "What is the business's tax / registration number? Reply skip to add it later.",
  accountant_name: 'Do you have an accountant? Send their name, or reply skip.',
  accountant_phone: (name) => `What is ${name}'s phone number? (e.g. 081 234 5678 or +66 81 234 5678) Reply skip if you'd rather not.`,
};

const CONSENT_NOTICE = [
  'Last step — privacy notice (PDPA):',
  `• What we store: your WhatsApp number, business details (name, country, VAT status, tax ID, accountant), the text of the transactions you send, and receipt images (our copy is deleted within ${RETENTION_DAYS} days; a receipt you confirm is attached to that entry in your ERPNext ledger).`,
  '• Where: our database (Postgres) and your ERPNext ledger. Messages, receipts and voice notes are read by OpenAI to understand them.',
  '• Why: only to keep your books and send the reminders and summaries you ask for.',
  '• Deleting: message "delete my account" at any time.',
  '',
  'Reply I agree (or ตกลง) to continue.',
].join('\n');

const RETRY = {
  name: 'Please send the business name (2–80 characters, with letters or digits; no < or >).',
  country: "Sorry, I didn't recognise that country. Reply TH, MY, SG, ID, VN, PH or AU (or the country name).",
  vat: 'Please reply yes or no (ใช่ / ไม่).',
  tax_id_th: "That doesn't look like a valid 13-digit Thai tax ID — please check the digits, or reply skip.",
  tax_id_other: 'Please send a tax number of 5–20 characters, or reply skip.',
  accountant_name: "Please send your accountant's name (2–80 characters; no < or >), or reply skip.",
  accountant_phone: "That doesn't look like a phone number. Send it with the area code (e.g. 081 234 5678), or reply skip.",
  consent: 'To finish, reply I agree (or ตกลง). Reply cancel to stop — nothing is kept.',
};

const CONSENT_REFUSED = 'No problem — signup stopped and nothing was saved. Message me again any time if you change your mind.';
const CANCELLED = 'Cancelled — nothing was saved. Message me again any time to start over.';
const COMPLETED = "Thanks — your books are being set up. You'll get a message when it's ready (usually within a day).";

const PENDING_PROVISIONING = 'Still setting up your books — hang tight.';
const ACCOUNT_CLOSED = 'This Berpal account has been closed. If that was a mistake, please contact the person who invited you.';
const BOOKS_READY = "Good news — your books are ready! Tell me what you bought, sold, paid or got billed for, e.g. \"paid 500 for lunch\".";

const DELETE_CONFIRM =
  'This will close your Berpal account and remove your tax ID and accountant details from our records. ' +
  'Your ledger in ERPNext is NOT deleted — your accountant keeps it as your bookkeeping record.\n\n' +
  'Reply DELETE to confirm, or anything else to keep your account.';
const DELETE_DONE =
  'Done — your Berpal account is closed and your tax ID, accountant details, stored receipts and message history have been removed. ' +
  'Your ERPNext ledger is kept: your accountant retains it as the bookkeeping record.';
const DELETE_KEPT = 'OK — nothing was deleted. Your account stays as it is.';

module.exports = {
  CONSENT_VERSION, FOOTER, INVITE_ONLY, WELCOME, PROMPTS, CONSENT_NOTICE, RETRY,
  CANCELLED, CONSENT_REFUSED, COMPLETED, PENDING_PROVISIONING, ACCOUNT_CLOSED, BOOKS_READY,
  DELETE_CONFIRM, DELETE_DONE, DELETE_KEPT,
};
