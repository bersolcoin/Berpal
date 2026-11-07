require('dotenv').config();
// Env validation first: exits with one line per problem, and normalises ERPNEXT_URL before
// src/erpnext.js reads it at load.
require('./src/config').assertEnv();
const express = require('express');
const db = require('./src/db');
const { processIncomingMessage } = require('./src/whatsapp');
const scheduler = require('./src/jobs/scheduler');
const { jobsDisabled } = require('./src/jobs');
const { webhookHandler, webhookUrl } = require('./src/webhook');
const { createHealthHandler } = require('./src/health');

(async () => {
  await db.init();

  let jobsRunning = false;
  // Daily per-user jobs (morning digest, reminders). DISABLE_JOBS=1|true|yes|on for a second
  // web-only instance or local dev — job_runs already prevents double sends, this just skips the work.
  if (!jobsDisabled(process.env.DISABLE_JOBS)) {
    scheduler.start();
    jobsRunning = true;
  }
  // Always installed: in the Docker image node is PID 1, and PID 1 gets no default SIGTERM
  // action, so without a listener `docker stop` waits out its timeout and SIGKILLs. With the
  // scheduler running, let an in-flight tick finish (max 10s) so its job_runs rows get recorded.
  const shutdown = async (signal) => {
    if (jobsRunning) {
      console.log(`[server] ${signal}: stopping scheduler`);
      await Promise.race([scheduler.stop(), new Promise((resolve) => setTimeout(resolve, 10000))]);
    } else {
      console.log(`[server] ${signal}: exiting`);
    }
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.get('/', (_req, res) => {
    res.send('WhatsApp bot is running. POST /webhook for Twilio.');
  });

  // Liveness + dependency checks (db, ERPNext, Twilio); ?deep=0 skips the external calls.
  // 503 only when the db is down — see src/health.js.
  app.get('/health', createHealthHandler({ scheduler: { running: () => jobsRunning } }));

  // Twilio delivery callbacks for scheduled sends (digest template) — marks async failures
  // like 63016 on job_runs. Signature-checked against PUBLIC_BASE_URL.
  app.post('/twilio/status', scheduler.twilioStatusHandler());

  // Inbound messages. X-Twilio-Signature is checked against TWILIO_WEBHOOK_URL (or
  // PUBLIC_BASE_URL + '/webhook'); a malformed URL throws here and stops the boot. With neither
  // set: production refuses every request, dev skips the check (see src/webhook.js).
  const signedUrl = webhookUrl();
  if (!signedUrl && process.env.NODE_ENV === 'production') {
    console.error('[server] ✖ NODE_ENV=production without TWILIO_WEBHOOK_URL / PUBLIC_BASE_URL: POST /webhook will refuse every request (403).');
  } else if (!signedUrl) {
    console.warn('');
    console.warn('[server] ⚠⚠⚠ WARNING: PUBLIC_BASE_URL / TWILIO_WEBHOOK_URL not set — POST /webhook accepts UNSIGNED requests.');
    console.warn('[server] ⚠⚠⚠ Anyone who knows the URL can post as any registered user. Fine for local ngrok dev; refused when NODE_ENV=production.');
    console.warn('');
  }
  app.post('/webhook', webhookHandler({ processMessage: processIncomingMessage, url: signedUrl }));

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`[server] listening on http://localhost:${port}`);
    console.log(`[server] webhook path: POST /webhook${signedUrl ? ` (signed as ${signedUrl})` : ' (signature check OFF)'}`);
  });
})().catch((err) => {
  console.error('[server] startup failed:', err);
  process.exit(1);
});
