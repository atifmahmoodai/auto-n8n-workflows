import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addEmployee, book, createCustomer, createService, createTestApp, hoursFromNow, signup, type Client, type TestContext } from './helpers.js';

let t: TestContext;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(() => t.providers.reset());

function multipart(kind: string, files: Array<{ data: Buffer; type?: string; name?: string }>) {
  const boundary = '----testboundary';
  const parts: Buffer[] = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n`)];
  for (const f of files) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photos"; filename="${f.name ?? 'p.jpg'}"\r\nContent-Type: ${f.type ?? 'image/jpeg'}\r\n\r\n`),
      f.data,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const upload = (client: Client, jobId: string, kind: string, files: Array<{ data: Buffer; type?: string }>) => {
  const m = multipart(kind, files);
  return client.request('POST', `/api/appointments/${jobId}/photos`, m.body, m.headers);
};

describe('photos', () => {
  it('strips EXIF/GPS, applies orientation, makes thumbnails and restricts access to the job', async () => {
    const s = await signup(t.app);
    const customer = await createCustomer(s.client);
    const tech = await addEmployee(t.app, s.client);
    const other = await addEmployee(t.app, s.client, 'Other Tech');
    const job = (await book(s.client, { customer_id: customer.id, start_at: hoursFromNow(1), technician_ids: [tech.id] })).body;
    // 800x600 photo that a phone marked as "rotate 90°", with identifying EXIF data.
    const phonePhoto = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#cc3333' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Copyright: 'Customer home GPS here', Artist: 'Phone' } })
      .toBuffer();
    expect((await sharp(phonePhoto).metadata()).exif).toBeDefined();

    const res = await upload(tech.client, job.id, 'before', [{ data: phonePhoto }]);
    expect(res.status).toBe(201);
    const photo = res.body[0];
    expect([photo.width, photo.height]).toEqual([600, 800]); // rotated upright

    const full = await tech.client.get(`/api/photos/${photo.id}`);
    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toBe('image/jpeg');
    const meta = await sharp(full.raw).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    const thumb = await tech.client.get(`/api/photos/${photo.id}?size=thumb`);
    expect((await sharp(thumb.raw).metadata()).height).toBe(480);

    expect((await other.client.get(`/api/photos/${photo.id}`)).status).toBe(404);
    expect((await upload(other.client, job.id, 'after', [{ data: phonePhoto }])).status).toBe(404);
    expect((await s.client.get(`/api/photos/${photo.id}`)).status).toBe(200);
    const foreign = await signup(t.app);
    expect((await foreign.client.get(`/api/photos/${photo.id}`)).status).toBe(404);
  });

  it('rejects files that are not images and requires before/after', async () => {
    const s = await signup(t.app);
    const customer = await createCustomer(s.client);
    const job = (await book(s.client, { customer_id: customer.id, start_at: hoursFromNow(1) })).body;
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const bad = await upload(s.client, job.id, 'before', [{ data: html, type: 'image/jpeg' }]);
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/not a supported image/);
    const png = await sharp({ create: { width: 10, height: 10, channels: 4, background: '#fff' } }).png().toBuffer();
    expect((await upload(s.client, job.id, 'sideways', [{ data: png }])).status).toBe(400);
    expect((await upload(s.client, job.id, 'after', [{ data: png }])).status).toBe(201);
  });

  it('removes photo files from disk when the job is deleted', async () => {
    const s = await signup(t.app);
    const customer = await createCustomer(s.client);
    const job = (await book(s.client, { customer_id: customer.id, start_at: hoursFromNow(1) })).body;
    const png = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#0f0' } }).png().toBuffer();
    await upload(s.client, job.id, 'before', [{ data: png }, { data: png }]);
    const dir = path.join(t.uploadDir, s.orgId, job.id);
    expect(fs.readdirSync(dir)).toHaveLength(4); // 2 photos + 2 thumbnails
    expect((await s.client.delete(`/api/appointments/${job.id}`)).status).toBe(200);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });
});

describe('dashboard & reports', () => {
  it('reports revenue, collections, top customers/services, technicians and retention', async () => {
    const s = await signup(t.app);
    const tech = await addEmployee(t.app, s.client);
    const valet = await createService(s.client, { name: 'Full valet', price_cents: 10000 });
    const wash = await createService(s.client, { name: 'Mini wash', price_cents: 3000 });
    const loyal = await createCustomer(s.client, { name: 'Loyal Larry' });
    const once = await createCustomer(s.client, { name: 'Once Olly' });
    const complete = async (customerId: string, serviceId: string, hoursAgo: number) => {
      const j = (await book(s.client, { customer_id: customerId, start_at: hoursFromNow(-hoursAgo), items: [{ service_id: serviceId }], technician_ids: [tech.id], force: true })).body;
      return (await s.client.post(`/api/appointments/${j.id}/status`, { status: 'completed' })).body.appointment;
    };
    const first = await complete(loyal.id, valet.id, 2);
    await complete(loyal.id, valet.id, 3);
    await complete(once.id, wash.id, 4);
    await s.client.post(`/api/invoices/${first.invoice_id}/payments`, { amount_cents: 10000, method: 'card' });
    await book(s.client, { customer_id: once.id, start_at: hoursFromNow(30) });

    const r = (await s.client.get('/api/reports/dashboard')).body;
    expect(r.monthly).toHaveLength(12);
    const thisMonth = r.monthly[11];
    expect(thisMonth.invoiced_cents).toBe(23000);
    expect(thisMonth.collected_cents).toBe(10000);
    expect(r.kpi).toMatchObject({ invoiced_mtd: 23000, collected_mtd: 10000, outstanding_cents: 13000, upcoming: 1 });
    expect(r.top_customers[0]).toMatchObject({ name: 'Loyal Larry', revenue_cents: 20000 });
    expect(r.top_services[0]).toMatchObject({ name: 'Full valet', jobs: 2 });
    expect(r.technicians[0]).toMatchObject({ name: 'Sam Tech', jobs: 3, revenue_cents: 23000 });
    expect(r.retention).toMatchObject({ customers: 2, repeat_customers: 1, repeat_rate: 50 });
  });
});

describe('settings', () => {
  it('validates time zones and currencies (v1 accepted any currency and crashed the UI)', async () => {
    const { client } = await signup(t.app);
    expect((await client.put('/api/settings', { org: { currency: 'POUNDS' } })).status).toBe(400);
    expect((await client.put('/api/settings', { org: { timezone: 'Mars/Olympus' } })).status).toBe(400);
    expect((await client.put('/api/settings', { settings: { notifications: { reminder_hours: 0 } } })).status).toBe(400);
    expect((await client.put('/api/settings', { settings: { notifications: { quiet_hours_start: '25:00' } } })).status).toBe(400);
    const ok = await client.put('/api/settings', { org: { currency: 'eur', timezone: 'Europe/Dublin', country: 'ie' } });
    expect(ok.body.org).toMatchObject({ currency: 'EUR', timezone: 'Europe/Dublin', country: 'IE' });
  });

  it('merges partial updates and uses edited templates for the next message', async () => {
    const { client } = await signup(t.app);
    await client.put('/api/settings', { settings: { business: { phone: '07911 123456', email: 'hello@shine.example' } } });
    const res = await client.put('/api/settings', { settings: { templates: { confirmation: 'Booked! {service} on {date}. Call {business_phone}' } } });
    expect(res.body.settings.business).toMatchObject({ phone: '+447911123456', email: 'hello@shine.example' });
    expect(res.body.settings.notifications.reminder_hours).toBe(24);
    const svc = await createService(client, { name: 'Ceramic coat' });
    const customer = await createCustomer(client);
    const job = (await client.post('/api/appointments', { customer_id: customer.id, start_at: hoursFromNow(80), items: [{ service_id: svc.id }] })).body;
    const sms = await t.pool.query(`SELECT body FROM notifications WHERE appointment_id = $1 AND channel = 'sms'`, [job.id]);
    expect(sms.rows[0].body).toMatch(/^Booked! Ceramic coat on \w+day \d+ \w+\. Call \+447911123456$/);
  });

  it('sends a test message through the configured provider', async () => {
    const { client } = await signup(t.app);
    const res = await client.post('/api/settings/test-message', { channel: 'sms', to: '07911 123456' });
    expect(res.body).toEqual({ status: 'sent', to: '+447911123456' });
    expect(t.providers.sms.at(-1)!.body).toMatch(/SMS is working/);
  });
});
