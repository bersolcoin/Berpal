/**
 * Twilio inbound WhatsApp webhook — port of the old server.js Express handler.
 *
 * Twilio sends form-urlencoded. We ack with an empty TwiML immediately so the
 * 15-second webhook timeout never bites, and process the actual reply async
 * via Twilio's REST API in the background (same pattern as before).
 */

const { processIncomingMessage } = require('../../../src/whatsapp');

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request) {
  let payload;
  try {
    const formData = await request.formData();
    payload = Object.fromEntries(formData);
  } catch (err) {
    console.error('[webhook] formData parse error:', err.message);
    return new Response(EMPTY_TWIML, {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    });
  }

  // Kick off async processing — does NOT block the response. Twilio gets the
  // empty TwiML immediately; the real reply goes out via REST API once the
  // LLM + tools finish.
  processIncomingMessage({
    from: payload.From || 'unknown',
    body: payload.Body || '',
    raw: payload,
  }).catch((err) => {
    console.error('[webhook async] processing error:', err);
  });

  return new Response(EMPTY_TWIML, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}

export async function GET() {
  // Helpful for health checks / verifying the route is alive.
  return new Response('WhatsApp webhook is up. Twilio should POST here.', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}
