require('dotenv').config();
const express = require('express');
const db = require('./src/db');
const { processIncomingMessage } = require('./src/whatsapp');
const scheduler = require('./src/jobs/scheduler');
const { jobsDisabled } = require('./src/jobs');

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

(async () => {
  await db.init();

  // Daily per-user jobs (morning digest, reminders). DISABLE_JOBS=1|true|yes|on for a second
  // web-only instance or local dev — job_runs already prevents double sends, this just skips the work.
  if (!jobsDisabled(process.env.DISABLE_JOBS)) {
    scheduler.start();
    // A signal listener replaces Node's default exit: let an in-flight tick finish (max 10s)
    // so its job_runs rows get recorded, then exit.
    const shutdown = async (signal) => {
      console.log(`[server] ${signal}: stopping scheduler`);
      await Promise.race([scheduler.stop(), new Promise((resolve) => setTimeout(resolve, 10000))]);
      process.exit(0);
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  }

  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.get('/', (_req, res) => {
    res.send('WhatsApp bot is running. POST /webhook for Twilio.');
  });

  // Twilio delivery callbacks for scheduled sends (digest template) — marks async failures
  // like 63016 on job_runs. Signature-checked against PUBLIC_BASE_URL.
  app.post('/twilio/status', scheduler.twilioStatusHandler());

  app.post('/webhook', (req, res) => {
    // Ack Twilio immediately so the 15s webhook timeout never kicks in.
    res.set('Content-Type', 'text/xml');
    res.send(EMPTY_TWIML);

    // Process and send the actual reply via Twilio REST API in the background.
    processIncomingMessage({
      from: req.body.From || 'unknown',
      body: req.body.Body || '',
      raw: req.body,
    }).catch((err) => {
      console.error('[webhook async] processing error:', err);
    });
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`[server] listening on http://localhost:${port}`);
    console.log(`[server] webhook path: POST /webhook`);
  });
})().catch((err) => {
  console.error('[server] startup failed:', err);
  process.exit(1);
});
