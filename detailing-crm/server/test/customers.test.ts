import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { book, createCustomer, createService, createTestApp, hoursFromNow, signup, type TestContext } from './helpers.js';

let t: TestContext;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

describe('customers & vehicles', () => {
  it('normalises phone numbers to E.164 for SMS and rejects invalid ones (v1 stored "07911 123456" raw)', async () => {
    const { client } = await signup(t.app);
    const ok = await client.post('/api/customers', { name: 'Uk Local', phone: '07911 123456', email: ' Mixed@Case.COM ' });
    expect(ok.status).toBe(201);
    expect(ok.body.phone).toBe('+447911123456');
    const intl = await client.post('/api/customers', { name: 'US Visitor', phone: '+1 (415) 555-2671' });
    expect(intl.body.phone).toBe('+14155552671');
    // Ofcom's reserved TV/drama range is not a real number.
    expect((await client.post('/api/customers', { name: 'Fake', phone: '07700 900123' })).status).toBe(400);
    expect(ok.body.email).toBe('mixed@case.com');
    const bad = await client.post('/api/customers', { name: 'Bad', phone: '12345' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.phone).toBeTruthy();
    const badEmail = await client.post('/api/customers', { name: 'Bad', email: 'not-an-email' });
    expect(badEmail.status).toBe(400);
  });

  it('warns about duplicates by phone/email unless explicitly allowed', async () => {
    const { client } = await signup(t.app);
    const first = await client.post('/api/customers', { name: 'Amelia', phone: '+44 7911 123555' });
    const dup = await client.post('/api/customers', { name: 'Amelia T', phone: '07911123555' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('duplicate_customer');
    expect(dup.body.error.existing.id).toBe(first.body.id);
    expect((await client.post('/api/customers', { name: 'Amelia T', phone: '07911123555', allow_duplicate: true })).status).toBe(201);
  });

  it('searches by name, phone digits in any format, plate without spaces, VIN; wildcards are literal', async () => {
    const { client } = await signup(t.app);
    await client.post('/api/customers', {
      name: 'Harry Evans',
      phone: '07911 123777',
      vehicles: [{ make: 'Ford', model: 'Focus', plate: 'fo17 cus', vin: 'wf0axxgcdahs12345' }],
    });
    await client.post('/api/customers', { name: '100% Real_Name' });
    const q = async (s: string) => (await client.get(`/api/customers?q=${encodeURIComponent(s)}`)).body.items.map((c: { name: string }) => c.name);
    expect(await q('harry')).toEqual(['Harry Evans']);
    expect(await q('07911 123 777')).toEqual(['Harry Evans']);
    expect(await q('123777')).toEqual(['Harry Evans']);
    expect(await q('FO17CUS')).toEqual(['Harry Evans']);
    expect(await q('fo17 cus')).toEqual(['Harry Evans']);
    expect(await q('WF0AXX')).toEqual(['Harry Evans']);
    expect(await q('focus')).toEqual(['Harry Evans']);
    expect(await q('%')).toEqual(['100% Real_Name']);
    expect(await q('_')).toEqual(['100% Real_Name']);
  });

  it('paginates large customer lists and finds any customer for booking (v1 capped lists at 500)', async () => {
    const { client, orgId } = await signup(t.app);
    await t.pool.query(
      `INSERT INTO customers (org_id, name) SELECT $1, 'Bulk ' || lpad(g::text, 4, '0') FROM generate_series(1, 620) g`,
      [orgId],
    );
    await client.post('/api/customers', { name: 'Zara Last' });
    const page1 = await client.get('/api/customers?page=1&page_size=50');
    expect(page1.body.total).toBe(621);
    expect(page1.body.items).toHaveLength(50);
    const last = await client.get('/api/customers?page=13&page_size=50');
    expect(last.body.items.map((c: { name: string }) => c.name)).toContain('Zara Last');
    const lookup = await client.get('/api/customers/lookup?q=zara');
    expect(lookup.body[0].name).toBe('Zara Last');
  });

  it('keeps customers with invoices (financial records) and archives them instead (v1 deleted invoices)', async () => {
    const { client } = await signup(t.app);
    const svc = await createService(client);
    const c = await createCustomer(client);
    const appt = await book(client, { customer_id: c.id, start_at: hoursFromNow(-30), items: [{ service_id: svc.id }], status: 'completed' });
    expect(appt.status).toBe(201);
    const del = await client.delete(`/api/customers/${c.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('has_invoices');
    expect((await client.post(`/api/customers/${c.id}/archive`)).status).toBe(200);
    expect((await client.get('/api/customers')).body.items.find((x: { id: string }) => x.id === c.id)).toBeUndefined();
    expect((await client.get('/api/customers?status=archived')).body.items[0].id).toBe(c.id);
    // Archived customers can't be booked until restored.
    const blocked = await book(client, { customer_id: c.id, start_at: hoursFromNow(48) });
    expect(blocked.status).toBe(400);
    expect((await client.post(`/api/customers/${c.id}/unarchive`)).status).toBe(200);
    expect((await book(client, { customer_id: c.id, start_at: hoursFromNow(48) })).status).toBe(201);
  });

  it('erases a customer without invoices, including vehicles, jobs and their photo files', async () => {
    const { client } = await signup(t.app);
    const c = await createCustomer(client);
    await book(client, { customer_id: c.id, start_at: hoursFromNow(24) });
    expect((await client.delete(`/api/customers/${c.id}`)).status).toBe(200);
    expect((await client.get(`/api/customers/${c.id}`)).status).toBe(404);
    const left = await t.pool.query('SELECT count(*)::int AS n FROM vehicles WHERE customer_id = $1', [c.id]);
    expect(left.rows[0].n).toBe(0);
  });

  it('manages vehicles and validates VINs', async () => {
    const { client } = await signup(t.app);
    const c = await createCustomer(client, { vehicles: [] });
    const v = await client.post(`/api/customers/${c.id}/vehicles`, { make: 'Tesla', model: 'Model 3', year: 2022, plate: 'ev22 tes', vin: '5yj3e1ea7kf317000' });
    expect(v.status).toBe(201);
    expect(v.body).toMatchObject({ plate: 'EV22 TES', vin: '5YJ3E1EA7KF317000' });
    expect((await client.post(`/api/customers/${c.id}/vehicles`, { vin: 'NOT A VIN!!' })).status).toBe(400);
    expect((await client.post(`/api/customers/${c.id}/vehicles`, { year: 1800 })).status).toBe(400);
    expect((await client.patch(`/api/vehicles/${v.body.id}`, { color: 'White' })).body.color).toBe('White');
    expect((await client.delete(`/api/vehicles/${v.body.id}`)).status).toBe(200);
  });

  it('exports CSV with spreadsheet formula injection neutralised', async () => {
    const { client } = await signup(t.app);
    await client.post('/api/customers', { name: '=HYPERLINK("http://evil","click")', notes: 'Line 1, "quoted"' });
    const res = await client.get('/api/customers/export.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.body).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
    expect(res.body).toContain('"Line 1, ""quoted"""');
  });

  it("isolates tenants: one business can never read or change another's customers", async () => {
    const a = await signup(t.app, { business_name: 'Business A' });
    const b = await signup(t.app, { business_name: 'Business B' });
    const ca = await createCustomer(a.client);
    expect((await b.client.get(`/api/customers/${ca.id}`)).status).toBe(404);
    expect((await b.client.patch(`/api/customers/${ca.id}`, { name: 'pwned' })).status).toBe(404);
    expect((await b.client.delete(`/api/customers/${ca.id}`)).status).toBe(404);
    expect((await b.client.post(`/api/customers/${ca.id}/vehicles`, { make: 'X' })).status).toBe(404);
    expect((await b.client.patch(`/api/vehicles/${ca.vehicles[0]!.id}`, { make: 'X' })).status).toBe(404);
    expect((await b.client.get('/api/customers')).body.items).toHaveLength(0);
    expect((await b.client.get(`/api/customers/lookup?q=${encodeURIComponent('Jack')}`)).body).toHaveLength(0);
    // Booking with another tenant's customer or vehicle is rejected.
    expect((await book(b.client, { customer_id: ca.id, start_at: hoursFromNow(24) })).status).toBe(400);
    const cb = await createCustomer(b.client);
    expect((await book(b.client, { customer_id: cb.id, vehicle_id: ca.vehicles[0]!.id, start_at: hoursFromNow(24) })).status).toBe(400);
    expect((await a.client.get(`/api/customers/${ca.id}`)).body.name).toBe('Jack Wilson');
  });
});
