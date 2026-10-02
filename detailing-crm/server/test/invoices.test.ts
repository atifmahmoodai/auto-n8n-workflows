import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { book, createCustomer, createService, createTestApp, hoursFromNow, signup, type TestContext } from './helpers.js';

let t: TestContext;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(() => t.providers.reset());

async function completedJob(opts: { price?: number; qty?: number; tax?: number; inclusive?: boolean } = {}) {
  const s = await signup(t.app);
  if (opts.tax !== undefined) {
    await s.client.put('/api/settings', { settings: { invoicing: { tax_rate_bp: opts.tax, prices_include_tax: opts.inclusive ?? true, payment_terms_days: 14 } } });
  }
  const svc = await createService(s.client, { price_cents: opts.price ?? 12000 });
  const customer = await createCustomer(s.client);
  const job = (await book(s.client, { customer_id: customer.id, vehicle_id: customer.vehicles[0]!.id, start_at: hoursFromNow(-4), items: [{ service_id: svc.id, quantity: opts.qty ?? 1 }] })).body;
  const done = await s.client.post(`/api/appointments/${job.id}/status`, { status: 'completed' });
  return { ...s, customer, svc, jobId: job.id as string, invoiceId: done.body.appointment.invoice_id as string };
}

describe('invoices', () => {
  it('adds VAT on top for VAT-exclusive pricing and sets the due date from payment terms', async () => {
    const { client, invoiceId } = await completedJob({ price: 10000, tax: 2000, inclusive: false });
    const inv = (await client.get(`/api/invoices/${invoiceId}`)).body;
    expect(inv).toMatchObject({ subtotal_cents: 10000, tax_cents: 2000, total_cents: 12000, prices_include_tax: false, status: 'open' });
    const days = (new Date(inv.due_date).getTime() - new Date(inv.issue_date).getTime()) / 86_400_000;
    expect(days).toBe(14);
    expect(inv.bill_to).toMatchObject({ name: 'Jack Wilson', vehicle: '2019 Audi A3 (AB19 CDE)' });
  });

  it('tracks partial payments, prevents overpayment and protects paid invoices from voiding', async () => {
    const { client, invoiceId } = await completedJob({ price: 12000 });
    const pay = (amount_cents: number) => client.post(`/api/invoices/${invoiceId}/payments`, { amount_cents, method: 'card' });
    expect((await pay(5000)).body).toMatchObject({ status: 'open', paid_cents: 5000 });
    const over = await pay(8000);
    expect(over.status).toBe(400);
    expect(over.body.error.message).toMatch(/more than the balance/);
    const full = await pay(7000);
    expect(full.body).toMatchObject({ status: 'paid', paid_cents: 12000 });
    expect(full.body.paid_at).toBeTruthy();
    expect((await pay(1)).status).toBe(409);
    expect((await client.post(`/api/invoices/${invoiceId}/void`, { reason: 'mistake' })).status).toBe(409);
    // Removing a payment reopens the invoice.
    const removed = await client.delete(`/api/invoices/${invoiceId}/payments/${full.body.payments[1].id}`);
    expect(removed.body).toMatchObject({ status: 'open', paid_cents: 5000, paid_at: null });
    expect((await client.post(`/api/invoices/${invoiceId}/payments`, { amount_cents: 100, method: 'cash', paid_at: hoursFromNow(48) })).status).toBe(400);
  });

  it('voids and reissues an unpaid invoice with corrected line items', async () => {
    const { client, invoiceId, jobId } = await completedJob({ price: 9000 });
    const job = (await client.get(`/api/appointments/${jobId}`)).body;
    const edit = await client.patch(`/api/appointments/${jobId}`, {
      version: job.version,
      items: [...job.items.map((i: { service_id: string }) => ({ service_id: i.service_id })), { name: 'Odour removal', unit_price_cents: 2500 }],
    });
    expect(edit.body.warnings[0]).toMatch(/already issued/);
    const fresh = await client.post(`/api/invoices/${invoiceId}/reissue`);
    expect(fresh.status).toBe(200);
    expect(fresh.body.total_cents).toBe(11500);
    expect(fresh.body.number).toBe('INV-00002');
    expect((await client.get(`/api/invoices/${invoiceId}`)).body).toMatchObject({ status: 'void', void_reason: 'Reissued with corrected details' });
  });

  it('numbers invoices without gaps or duplicates under concurrent completions', async () => {
    const s = await signup(t.app);
    const svc = await createService(s.client);
    const customer = await createCustomer(s.client);
    const ids = [];
    for (let i = 0; i < 8; i++) ids.push((await book(s.client, { customer_id: customer.id, start_at: hoursFromNow(-10 - i), items: [{ service_id: svc.id }] })).body.id);
    const results = await Promise.all(ids.map((id) => s.client.post(`/api/appointments/${id}/status`, { status: 'completed' })));
    const numbers = results.map((r) => r.body.appointment.invoice_number).sort();
    expect(numbers).toEqual(Array.from({ length: 8 }, (_, i) => `INV-${String(i + 1).padStart(5, '0')}`));
  });

  it('renders a PDF with photos and emails it as an attachment', async () => {
    const { client, invoiceId, jobId, customer } = await completedJob({ tax: 2000 });
    const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#3366cc' } }).jpeg().toBuffer();
    const boundary = '----x';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nafter\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      jpeg,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await client.request('POST', `/api/appointments/${jobId}/photos`, body, { 'content-type': `multipart/form-data; boundary=${boundary}` });
    expect(up.status).toBe(201);

    const pdf = await client.get(`/api/invoices/${invoiceId}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.raw.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.raw.length).toBeGreaterThan(5000); // fonts + embedded photo

    const sent = await client.post(`/api/invoices/${invoiceId}/send`);
    expect(sent.body.to).toBe(customer.email);
    await t.pool.query(`UPDATE notifications SET next_attempt_at = now() WHERE invoice_id = $1`, [invoiceId]);
    await t.app.scheduler.runOnce();
    const email = t.providers.emails.find((e) => e.to === customer.email && e.subject.startsWith('Invoice'))!;
    expect(email.attachments?.[0]?.filename).toMatch(/^INV-\d{5}\.pdf$/);
    expect(email.attachments?.[0]?.content.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('exports invoices to CSV for the accountant', async () => {
    const { client } = await completedJob({ price: 4550 });
    const csv = await client.get('/api/invoices/export.csv');
    expect(csv.status).toBe(200);
    expect(csv.body).toContain('INV-00001');
    expect(csv.body).toContain('45.50');
  });

  it('lists invoices with outstanding and overdue totals', async () => {
    const { client, invoiceId } = await completedJob({ price: 3000 });
    await t.pool.query(`UPDATE invoices SET due_date = current_date - 3 WHERE id = $1`, [invoiceId]);
    const res = await client.get('/api/invoices?status=overdue');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.summary).toEqual({ open_cents: 3000, overdue_cents: 3000 });
  });
});
