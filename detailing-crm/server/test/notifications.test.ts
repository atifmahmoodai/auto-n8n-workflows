import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { planScheduledMessages } from '../src/notifications/planner.js';
import { ProviderError } from '../src/notifications/providers.js';
import { processOutbox } from '../src/notifications/worker.js';
import { twilioSignature } from '../src/routes/webhooks.js';
import { Client, book, createCustomer, createService, createTestApp, signup, type TestContext } from './helpers.js';

let t: TestContext;
const env = () => ({ publicUrl: t.config.PUBLIC_URL, secret: t.config.APP_SECRET });
const worker = () => ({
  pool: t.pool,
  providers: t.providers,
  log: t.app.log,
  renderInvoicePdf: async () => ({ filename: 'x.pdf', content: Buffer.from('%PDF') }),
});

beforeAll(async () => {
  t = await createTestApp({ TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'twilio-token', TWILIO_FROM_NUMBER: '+447400000000' });
});
afterAll(async () => t.close());
beforeEach(() => t.providers.reset());

/** Fresh org with quiet hours disabled so results don't depend on the time of day the tests run. */
async function org() {
  const s = await signup(t.app);
  await s.client.put('/api/settings', { settings: { notifications: { quiet_hours_start: '00:00', quiet_hours_end: '00:00', review_link: 'https://g.page/r/test' } } });
  const customer = await createCustomer(s.client);
  return { ...s, customer };
}

const rowsFor = async (appointmentId: string, kind?: string) =>
  (
    await t.pool.query(
      `SELECT kind, channel, status, attempts, error, body, next_attempt_at FROM notifications
        WHERE appointment_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY created_at, channel`,
      [appointmentId, kind ?? null],
    )
  ).rows;

/** Drain only this test's messages: make everything due now and run the worker until empty. */
async function deliverAll() {
  await t.pool.query(`UPDATE notifications SET next_attempt_at = now() WHERE status = 'queued'`);
  while ((await processOutbox(worker())) > 0);
}

describe('reminder planning', () => {
  it('plans exactly one reminder per channel even when the planner runs concurrently (v1 sent duplicates)', async () => {
    const { client, customer } = await org();
    const start = new Date(Date.now() + 30 * 3600_000);
    const a = (await book(client, { customer_id: customer.id, start_at: start.toISOString() })).body;
    const inWindow = new Date(start.getTime() - 23 * 3600_000);
    await Promise.all([1, 2, 3].map(() => planScheduledMessages(t.pool, env(), inWindow)));
    await planScheduledMessages(t.pool, env(), inWindow);
    const reminders = await rowsFor(a.id, 'reminder');
    expect(reminders.map((r) => r.channel)).toEqual(['email', 'sms']);
  });

  it("doesn't send a reminder seconds after the confirmation for short-notice bookings (v1 did)", async () => {
    const { client, customer } = await org();
    const a = (await client.post('/api/appointments', { customer_id: customer.id, start_at: new Date(Date.now() + 5 * 3600_000).toISOString() })).body;
    await planScheduledMessages(t.pool, env());
    expect(await rowsFor(a.id, 'reminder')).toEqual([]);
    expect((await rowsFor(a.id, 'confirmation')).length).toBe(2);
    const planned = await t.pool.query('SELECT reminder_planned_for IS NOT NULL AS done FROM appointments WHERE id = $1', [a.id]);
    expect(planned.rows[0].done).toBe(true);
  });

  it('re-plans the reminder when a job moves, and the worker drops a reminder for the old time', async () => {
    const { client, customer } = await org();
    const start = new Date(Date.now() + 30 * 3600_000);
    const a = (await book(client, { customer_id: customer.id, start_at: start.toISOString() })).body.appointment;
    await planScheduledMessages(t.pool, env(), new Date(start.getTime() - 23 * 3600_000));
    // Moved without notifying the customer: the queued reminder is withdrawn.
    const newStart = new Date(start.getTime() + 2 * 24 * 3600_000);
    await client.patch(`/api/appointments/${a.id}`, { version: a.version, start_at: newStart.toISOString(), notify: false });
    expect((await rowsFor(a.id, 'reminder')).map((r) => r.status)).toEqual(['canceled', 'canceled']);
    await planScheduledMessages(t.pool, env(), new Date(newStart.getTime() - 23 * 3600_000));
    const reminders = await rowsFor(a.id, 'reminder');
    expect(reminders.map((r) => r.status)).toEqual(['canceled', 'canceled', 'queued', 'queued']);
  });

  it('defers scheduled messages out of quiet hours', async () => {
    const { client, customer } = await org();
    await client.put('/api/settings', { settings: { notifications: { quiet_hours_start: '20:00', quiet_hours_end: '08:00' } } });
    const start = new Date('2027-03-10T12:00:00Z'); // Wed 12:00 GMT
    const a = (await book(client, { customer_id: customer.id, start_at: start.toISOString() })).body;
    const lateEvening = new Date('2027-03-09T22:30:00Z'); // 22:30 London, inside quiet hours
    await planScheduledMessages(t.pool, env(), lateEvening);
    const rows = await rowsFor(a.id, 'reminder');
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.next_attempt_at.toISOString()).toBe('2027-03-10T08:00:00.000Z');
  });
});

describe('delivery worker', () => {
  it('sends with the business name and local time, and records provider ids', async () => {
    const { client, customer } = await org();
    const start = new Date('2027-05-14T09:15:00Z'); // 10:15 BST
    await client.post('/api/appointments', { customer_id: customer.id, start_at: start.toISOString() });
    await deliverAll();
    const sms = t.providers.sms.find((m) => m.to === customer.phone)!;
    expect(sms.body).toContain('Shine Detailing');
    expect(sms.body).toContain('Friday 14 May at 10:15');
    const email = t.providers.emails.find((m) => m.to === customer.email)!;
    expect(email.subject).toContain('Booking confirmed');
    expect(email.html).toContain('Shine Detailing');
  });

  it('retries transient failures with backoff and gives up on permanent ones', async () => {
    const { client, customer } = await org();
    const a = (await client.post('/api/appointments', { customer_id: customer.id, start_at: new Date(Date.now() + 72 * 3600_000).toISOString() })).body;
    await t.pool.query(`UPDATE notifications SET next_attempt_at = now() WHERE appointment_id = $1`, [a.id]);
    t.providers.failNext = [new ProviderError('SendGrid 503', false), new ProviderError('Twilio 503', false)];
    await processOutbox(worker());
    let rows = await rowsFor(a.id);
    expect(rows.map((r) => [r.status, r.attempts])).toEqual([
      ['queued', 1],
      ['queued', 1],
    ]);
    expect(rows[0].next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 50_000);
    // Permanent error on the next attempt: stop retrying.
    await t.pool.query(`UPDATE notifications SET next_attempt_at = now() WHERE appointment_id = $1`, [a.id]);
    t.providers.failNext = [new ProviderError('SendGrid 400: bad address', true)];
    await processOutbox(worker());
    rows = await rowsFor(a.id);
    expect(rows.map((r) => r.status).sort()).toEqual(['failed', 'sent']);
  });

  it('marks a message failed after the maximum number of attempts', async () => {
    const { client, customer } = await org();
    const a = (await client.post('/api/appointments', { customer_id: customer.id, start_at: new Date(Date.now() + 72 * 3600_000).toISOString() })).body;
    await t.pool.query(`UPDATE notifications SET attempts = 4, next_attempt_at = now() WHERE appointment_id = $1`, [a.id]);
    t.providers.failNext = [new Error('socket hang up'), new Error('socket hang up')];
    await processOutbox(worker());
    expect((await rowsFor(a.id)).map((r) => r.status)).toEqual(['failed', 'failed']);
  });

  it('honours a Twilio "unsubscribed recipient" error by opting the customer out of SMS', async () => {
    const { client, customer } = await org();
    await client.post('/api/appointments', { customer_id: customer.id, start_at: new Date(Date.now() + 72 * 3600_000).toISOString() });
    // email is sent first (ordering by channel isn't guaranteed), so fail whichever SMS comes
    t.providers.sendSms = async () => {
      throw new ProviderError('Twilio 400 (21610): unsubscribed recipient', true, '21610');
    };
    await deliverAll();
    const c = await t.pool.query('SELECT sms_opt_in FROM customers WHERE id = $1', [customer.id]);
    expect(c.rows[0].sms_opt_in).toBe(false);
    t.providers.sendSms = Object.getPrototypeOf(t.providers).sendSms.bind(t.providers);
  });

  it('re-checks consent right before sending', async () => {
    const { client, customer } = await org();
    const a = (await client.post('/api/appointments', { customer_id: customer.id, start_at: new Date(Date.now() + 72 * 3600_000).toISOString() })).body;
    await client.patch(`/api/customers/${customer.id}`, { sms_opt_in: false });
    await deliverAll();
    const rows = await rowsFor(a.id);
    expect(rows.find((r) => r.channel === 'sms')).toMatchObject({ status: 'skipped', error: 'Customer opted out of SMS' });
    expect(rows.find((r) => r.channel === 'email')!.status).toBe('sent');
  });

  it('wipes sign-in links from the outbox once a password reset email is sent', async () => {
    const { email } = await signup(t.app);
    await new Client(t.app).post('/api/auth/forgot-password', { email });
    await deliverAll();
    const row = await t.pool.query(`SELECT status, body, html FROM notifications WHERE kind = 'password_reset' AND recipient = $1`, [email]);
    expect(row.rows[0]).toEqual({ status: 'sent', body: '[redacted]', html: null });
    expect(t.providers.emails.find((m) => m.to === email)!.text).toMatch(/reset-password\?token=/);
  });
});

describe('follow-ups & consent', () => {
  it('sends a review request after the job with opt-outs, and honours the unsubscribe link', async () => {
    const { client, customer } = await org();
    const svc = await createService(client);
    const a = (await book(client, { customer_id: customer.id, start_at: new Date(Date.now() - 2 * 3600_000).toISOString(), items: [{ service_id: svc.id }] })).body;
    await client.post(`/api/appointments/${a.id}/status`, { status: 'completed' });
    await planScheduledMessages(t.pool, env(), new Date(Date.now() + 3 * 3600_000));
    const rows = await rowsFor(a.id, 'followup');
    expect(rows).toHaveLength(2);
    const sms = rows.find((r) => r.channel === 'sms')!;
    expect(sms.body).toContain('https://g.page/r/test');
    expect(sms.body).toContain('Reply STOP to opt out');
    const email = rows.find((r) => r.channel === 'email')!;
    const unsub = /Unsubscribe: (\S+)/.exec(email.body)![1]!;
    const path = new URL(unsub).pathname;

    // GET only shows a confirmation page (link scanners must not unsubscribe people).
    const page = await t.app.inject({ method: 'GET', url: path });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<form method="post">');
    let c = await t.pool.query('SELECT marketing_opt_in FROM customers WHERE id = $1', [customer.id]);
    expect(c.rows[0].marketing_opt_in).toBe(true);
    // One-click unsubscribe (RFC 8058 POST).
    const done = await t.app.inject({ method: 'POST', url: path, payload: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(done.statusCode).toBe(200);
    c = await t.pool.query('SELECT marketing_opt_in FROM customers WHERE id = $1', [customer.id]);
    expect(c.rows[0].marketing_opt_in).toBe(false);
    // Tampered tokens are rejected.
    expect((await t.app.inject({ method: 'POST', url: `${path}x` })).statusCode).toBe(400);
    // Already-queued follow-ups are dropped at send time; no new ones are planned.
    await deliverAll();
    expect((await rowsFor(a.id, 'followup')).map((r) => r.status)).toEqual(['skipped', 'skipped']);
  });
});

describe('Twilio webhooks', () => {
  const post = (path: string, params: Record<string, string>, signature?: string) =>
    t.app.inject({
      method: 'POST',
      url: path,
      payload: new URLSearchParams(params).toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature ?? twilioSignature('twilio-token', `${t.config.PUBLIC_URL}${path}`, params),
      },
    });

  it('rejects unsigned requests and handles STOP / START replies', async () => {
    const { customer } = await org();
    const params = { From: customer.phone, Body: ' stop ', MessageSid: 'SM1' };
    expect((await post('/api/webhooks/twilio/inbound', params, 'forged')).statusCode).toBe(403);
    const res = await post('/api/webhooks/twilio/inbound', params);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);
    let c = await t.pool.query('SELECT sms_opt_in FROM customers WHERE id = $1', [customer.id]);
    expect(c.rows[0].sms_opt_in).toBe(false);
    await post('/api/webhooks/twilio/inbound', { ...params, Body: 'START' });
    c = await t.pool.query('SELECT sms_opt_in FROM customers WHERE id = $1', [customer.id]);
    expect(c.rows[0].sms_opt_in).toBe(true);
  });

  it('records delivery receipts', async () => {
    const { client, customer } = await org();
    const a = (await client.post('/api/appointments', { customer_id: customer.id, start_at: new Date(Date.now() + 72 * 3600_000).toISOString() })).body;
    await deliverAll();
    const sms = (await t.pool.query(`SELECT provider_id FROM notifications WHERE appointment_id = $1 AND channel = 'sms'`, [a.id])).rows[0];
    expect((await post('/api/webhooks/twilio/status', { MessageSid: sms.provider_id, MessageStatus: 'delivered' })).statusCode).toBe(200);
    expect((await rowsFor(a.id)).find((r) => r.channel === 'sms')!.status).toBe('delivered');
  });
});

describe('low stock alerts', () => {
  it('alerts admins once per shortage and re-arms after a restock', async () => {
    const { client, email } = await org();
    const item = (await client.post('/api/inventory', { name: 'Snow foam', unit: 'litres', quantity: 5, low_threshold: 2 })).body;
    const move = (delta: number, reason = delta > 0 ? 'restock' : 'usage') => client.post(`/api/inventory/${item.id}/movements`, { delta, reason });
    expect((await move(-3)).body.low_stock_alert_sent).toBe(true);
    expect((await move(-1)).body.low_stock_alert_sent).toBe(false);
    await move(10);
    expect((await move(-10)).body.low_stock_alert_sent).toBe(true);
    const alerts = await t.pool.query(`SELECT recipient FROM notifications WHERE kind = 'low_stock' AND recipient = $1`, [email]);
    expect(alerts.rowCount).toBe(2);
  });

  it('never loses or oversells stock under concurrent adjustments', async () => {
    const { client } = await org();
    const item = (await client.post('/api/inventory', { name: 'Wax', quantity: 5, low_threshold: 0 })).body;
    const results = await Promise.all(Array.from({ length: 10 }, () => client.post(`/api/inventory/${item.id}/movements`, { delta: -1, reason: 'usage' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.status === 400)).toHaveLength(5);
    const after = (await client.get('/api/inventory')).body.find((i: { id: string }) => i.id === item.id);
    expect(after.quantity).toBe(0);
    const history = (await client.get(`/api/inventory/${item.id}/movements`)).body;
    expect(history).toHaveLength(6); // initial + 5 usages
  });
});
