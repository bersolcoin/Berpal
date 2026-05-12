require('dotenv').config();
const express = require('express');
const db = require('./src/db');
const { processIncomingMessage } = require('./src/whatsapp');

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

(async () => {
  await db.init();

  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.get('/', (_req, res) => {
    res.send('WhatsApp bot is running. POST /webhook for Twilio.');
  });

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
