import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { one } from '../db/pool.js';
import { safeEqual, verifySignedPayload } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { escapeHtml } from '../lib/template.js';

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE']);
const START_WORDS = new Set(['START', 'YES', 'UNSTOP', 'OPTIN']);

/** https://www.twilio.com/docs/usage/security#validating-requests */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f3f4f6;color:#111827;margin:0;padding:24px}
main{max-width:460px;margin:10vh auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:12px 18px;font-size:16px;cursor:pointer}</style></head>
<body><main>${body}</main></body></html>`;
}

export function registerWebhookRoutes(app: FastifyInstance, deps: AppDeps) {
  const { pool, config } = deps;

  function verifyTwilio(req: FastifyRequest) {
    if (!config.twilioEnabled) throw new AppError(404, 'not_found', 'Not found');
    if (!config.TWILIO_VALIDATE_WEBHOOKS) return;
    const signature = String(req.headers['x-twilio-signature'] ?? '');
    const params = Object.fromEntries(Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    const expected = twilioSignature(config.TWILIO_AUTH_TOKEN ?? '', `${config.PUBLIC_URL}${req.url}`, params);
    if (!signature || !safeEqual(signature, expected)) throw new AppError(403, 'invalid_signature', 'Invalid Twilio signature');
  }

  const twiml = (reply: FastifyReply) => reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  /** Delivery receipts for sent SMS. */
  app.post('/webhooks/twilio/status', { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }, async (req, reply) => {
    verifyTwilio(req);
    const body = z.object({ MessageSid: z.string(), MessageStatus: z.string(), ErrorCode: z.string().optional() }).passthrough().parse(req.body);
    const status = body.MessageStatus;
    if (status === 'delivered') {
      await pool.query(`UPDATE notifications SET status = 'delivered', updated_at = now() WHERE provider_id = $1 AND status IN ('sent', 'delivered')`, [body.MessageSid]);
    } else if (status === 'undelivered' || status === 'failed') {
      await pool.query(`UPDATE notifications SET status = 'failed', error = $2, updated_at = now() WHERE provider_id = $1`, [
        body.MessageSid,
        `Carrier reported ${status}${body.ErrorCode ? ` (error ${body.ErrorCode})` : ''}`,
      ]);
    }
    return twiml(reply);
  });

  /** Replies from customers: honour STOP / START keywords (required for SMS compliance). */
  app.post('/webhooks/twilio/inbound', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    verifyTwilio(req);
    const body = z.object({ From: z.string(), Body: z.string().default('') }).passthrough().parse(req.body);
    const word = body.Body.trim().toUpperCase().replace(/[^A-Z]/g, '');
    if (STOP_WORDS.has(word) || START_WORDS.has(word)) {
      const optIn = START_WORDS.has(word);
      // The sending number is shared by every business on this server, so STOP applies to all of them.
      const res = await pool.query('UPDATE customers SET sms_opt_in = $2, updated_at = now() WHERE phone = $1', [body.From, optIn]);
      req.log.info({ optIn, matched: res.rowCount }, 'sms consent keyword received');
    }
    return twiml(reply);
  });

  // ---- email unsubscribe (link in marketing emails + RFC 8058 one-click) ----
  async function unsubscribe(token: string): Promise<string | null> {
    const payload = verifySignedPayload(config.APP_SECRET, token);
    if (!payload?.o || !payload.c) return null;
    const row = await one<{ name: string }>(
      pool,
      `UPDATE customers c SET marketing_opt_in = false, updated_at = now()
         FROM organizations o WHERE o.id = c.org_id AND c.org_id = $1 AND c.id = $2 RETURNING o.name`,
      [payload.o, payload.c],
    );
    return row?.name ?? null;
  }

  // GET only shows a confirmation button: mail scanners pre-fetch links, and must not unsubscribe people.
  app.get('/public/unsubscribe/:token', async (req, reply) => {
    const { token } = z.object({ token: z.string().max(500) }).parse(req.params);
    const valid = verifySignedPayload(config.APP_SECRET, token);
    reply.type('text/html; charset=utf-8');
    if (!valid) return page('Link not valid', '<h1>Link not valid</h1><p>This unsubscribe link is invalid.</p>');
    return page(
      'Unsubscribe',
      `<h1>Unsubscribe</h1><p>Stop receiving review requests and offers by email? You will still get booking confirmations and reminders.</p>
<form method="post"><button type="submit">Unsubscribe</button></form>`,
    );
  });

  app.post('/public/unsubscribe/:token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = z.object({ token: z.string().max(500) }).parse(req.params);
    const business = await unsubscribe(token);
    reply.type('text/html; charset=utf-8');
    if (!business) return reply.code(400).send(page('Link not valid', '<h1>Link not valid</h1><p>This unsubscribe link is invalid.</p>'));
    return page('Unsubscribed', `<h1>You're unsubscribed</h1><p>${escapeHtml(business)} won't send you offers or review requests any more.</p>`);
  });
}
