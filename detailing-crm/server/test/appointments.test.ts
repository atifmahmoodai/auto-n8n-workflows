import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extendAllSeries } from '../src/appointments/service.js';
import { addEmployee, book, createCustomer, createService, createTestApp, hoursFromNow, signup, type TestContext } from './helpers.js';

let t: TestContext;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

const london = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' }).setZone('Europe/London');
const localIso = (local: string) => DateTime.fromISO(local, { zone: 'Europe/London' }).toUTC().toISO()!;

async function setup() {
  const s = await signup(t.app);
  const svc = await createService(s.client, { name: 'Full valet', price_cents: 5000, duration_min: 90 });
  const customer = await createCustomer(s.client);
  const tech = await addEmployee(t.app, s.client);
  return { ...s, svc, customer, tech };
}

describe('booking', () => {
  it('prices and times a job from its services and queues a confirmation on every consented channel', async () => {
    const { client, svc, customer } = await setup();
    const res = await client.post('/api/appointments', {
      customer_id: customer.id,
      vehicle_id: customer.vehicles[0]!.id,
      start_at: hoursFromNow(72),
      items: [{ service_id: svc.id, quantity: 2 }, { name: 'Engine bay', unit_price_cents: 1500 }],
      discount_cents: 1000,
    });
    expect(res.status).toBe(201);
    const a = res.body.appointment;
    expect(a.items).toHaveLength(2);
    expect(a.totals).toMatchObject({ subtotal_cents: 11500, discount_cents: 1000, total_cents: 10500 });
    expect(new Date(a.end_at).getTime() - new Date(a.start_at).getTime()).toBe(180 * 60_000); // 2 x 90 min
    expect(a.status).toBe('confirmed');
    const n = await t.pool.query(`SELECT channel FROM notifications WHERE appointment_id = $1 AND kind = 'confirmation' ORDER BY channel`, [a.id]);
    expect(n.rows.map((r) => r.channel)).toEqual(['email', 'sms']);
  });

  it('blocks double-booking a technician unless forced', async () => {
    const { client, customer, tech } = await setup();
    const start = hoursFromNow(48);
    expect((await book(client, { customer_id: customer.id, start_at: start, duration_min: 120, technician_ids: [tech.id] })).status).toBe(201);
    const overlap = await book(client, { customer_id: customer.id, start_at: hoursFromNow(49), technician_ids: [tech.id] });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('schedule_conflict');
    expect(overlap.body.error.message).toContain('Sam Tech');
    expect((await book(client, { customer_id: customer.id, start_at: hoursFromNow(49), technician_ids: [] })).status).toBe(201);
    expect((await book(client, { customer_id: customer.id, start_at: hoursFromNow(49), technician_ids: [tech.id], force: true })).status).toBe(201);
    // Back-to-back is fine (end is exclusive).
    expect((await book(client, { customer_id: customer.id, start_at: hoursFromNow(52), technician_ids: [tech.id] })).status).toBe(201);
  });

  it('serialises simultaneous bookings so two people cannot grab the same slot', async () => {
    const { client, customer, tech } = await setup();
    const start = hoursFromNow(100);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => book(client, { customer_id: customer.id, start_at: start, technician_ids: [tech.id] })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
  });

  it('rejects stale edits (optimistic locking) instead of silently overwriting', async () => {
    const { client, customer } = await setup();
    const a = (await book(client, { customer_id: customer.id, start_at: hoursFromNow(30) })).body.appointment;
    const first = await client.patch(`/api/appointments/${a.id}`, { version: a.version, notes: 'Pet hair in boot' });
    expect(first.status).toBe(200);
    expect(first.body.appointment.version).toBe(a.version + 1);
    const stale = await client.patch(`/api/appointments/${a.id}`, { version: a.version, notes: 'overwrite' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('stale');
  });

  it('tells the customer when a job moves or is cancelled, and withdraws messages for the old time', async () => {
    const { client, customer } = await setup();
    const a = (await client.post('/api/appointments', { customer_id: customer.id, start_at: hoursFromNow(72) })).body.appointment;
    const moved = await client.patch(`/api/appointments/${a.id}`, { version: a.version, start_at: hoursFromNow(96) });
    expect(moved.status).toBe(200);
    const rows = async () =>
      (await t.pool.query(`SELECT kind, status FROM notifications WHERE appointment_id = $1 ORDER BY created_at, channel`, [a.id])).rows;
    expect(await rows()).toEqual([
      { kind: 'confirmation', status: 'canceled' },
      { kind: 'confirmation', status: 'canceled' },
      { kind: 'rescheduled', status: 'queued' },
      { kind: 'rescheduled', status: 'queued' },
    ]);
    const canceled = await client.patch(`/api/appointments/${a.id}`, { version: moved.body.appointment.version, status: 'canceled' });
    expect(canceled.status).toBe(200);
    const after = await rows();
    expect(after.filter((r) => r.kind === 'canceled').map((r) => r.status)).toEqual(['queued', 'queued']);
    expect(after.filter((r) => r.kind === 'rescheduled').every((r) => r.status === 'canceled')).toBe(true);
  });

  it('issues one invoice on completion, voids it when reopened and numbers invoices sequentially', async () => {
    const { client, svc, customer } = await setup();
    await client.put('/api/settings', { settings: { invoicing: { tax_rate_bp: 2000, prices_include_tax: true } } });
    const a = (await book(client, { customer_id: customer.id, start_at: hoursFromNow(-3), items: [{ service_id: svc.id, quantity: 2 }], discount_cents: 1000 }))
      .body.appointment;
    const done = await client.post(`/api/appointments/${a.id}/status`, { status: 'completed' });
    expect(done.status).toBe(200);
    expect(done.body.appointment.invoice_number).toBe('INV-00001');
    const inv = (await client.get(`/api/invoices/${done.body.appointment.invoice_id}`)).body;
    expect(inv).toMatchObject({ subtotal_cents: 10000, discount_cents: 1000, total_cents: 9000, tax_cents: 1500, status: 'open' });
    // Completing again is a no-op; reopening voids the unpaid invoice.
    await client.post(`/api/appointments/${a.id}/status`, { status: 'completed' });
    const reopened = await client.post(`/api/appointments/${a.id}/status`, { status: 'confirmed' });
    expect(reopened.body.appointment.invoice_id).toBeNull();
    expect((await client.get(`/api/invoices/${inv.id}`)).body.status).toBe('void');
    const again = await client.post(`/api/appointments/${a.id}/status`, { status: 'completed' });
    expect(again.body.appointment.invoice_number).toBe('INV-00002');
  });

  it('invoices a walk-in recorded straight as completed (v1 skipped the invoice)', async () => {
    const { client, svc, customer } = await setup();
    const res = await book(client, { customer_id: customer.id, start_at: hoursFromNow(-26), items: [{ service_id: svc.id }], status: 'completed' });
    expect(res.status).toBe(201);
    expect(res.body.invoice.number).toMatch(/^INV-/);
    expect(res.body.appointment.completed_at).toBeTruthy();
    expect(res.body.appointment.started_at).toBeTruthy();
  });

  it("keeps jobs of deactivated technicians editable but won't assign them new work (v1 blocked edits)", async () => {
    const { client, customer, tech } = await setup();
    const a = (await book(client, { customer_id: customer.id, start_at: hoursFromNow(50), technician_ids: [tech.id] })).body.appointment;
    await client.patch(`/api/users/${tech.id}`, { active: false });
    const edit = await client.patch(`/api/appointments/${a.id}`, { version: a.version, notes: 'Bring the steamer' });
    expect(edit.status).toBe(200);
    expect(edit.body.appointment.technicians[0].active).toBe(false);
    const fresh = await book(client, { customer_id: customer.id, start_at: hoursFromNow(80), technician_ids: [tech.id] });
    expect(fresh.status).toBe(400);
  });

  it('protects completed and invoiced jobs from deletion', async () => {
    const { client, svc, customer } = await setup();
    const done = (await book(client, { customer_id: customer.id, start_at: hoursFromNow(-5), items: [{ service_id: svc.id }], status: 'completed' })).body;
    expect((await client.delete(`/api/appointments/${done.id}`)).status).toBe(409);
    const pending = (await book(client, { customer_id: customer.id, start_at: hoursFromNow(5) })).body;
    expect((await client.delete(`/api/appointments/${pending.id}`)).status).toBe(200);
    expect((await client.get(`/api/appointments/${pending.id}`)).status).toBe(404);
  });

  it('validates input: bad dates, cross-customer vehicles, huge ranges', async () => {
    const { client, customer } = await setup();
    expect((await book(client, { customer_id: customer.id, start_at: 'tomorrow' })).status).toBe(400);
    expect((await book(client, { customer_id: customer.id, start_at: '2026-10-10T10:00' })).status).toBe(400); // no zone
    const other = await createCustomer(client);
    expect((await book(client, { customer_id: customer.id, vehicle_id: other.vehicles[0]!.id, start_at: hoursFromNow(5) })).status).toBe(400);
    const from = new Date().toISOString();
    expect((await client.get(`/api/appointments?from=${from}&to=${hoursFromNow(24 * 200)}`)).status).toBe(400);
  });
});

describe('technician (employee) access', () => {
  it('sees and progresses only their own jobs', async () => {
    const { client, customer, tech } = await setup();
    const mine = (await book(client, { customer_id: customer.id, start_at: hoursFromNow(2), technician_ids: [tech.id] })).body.appointment;
    const other = (await book(client, { customer_id: customer.id, start_at: hoursFromNow(3) })).body.appointment;
    const list = await tech.client.get(`/api/appointments?from=${hoursFromNow(-1)}&to=${hoursFromNow(24)}`);
    expect(list.body.map((a: { id: string }) => a.id)).toEqual([mine.id]);
    expect((await tech.client.get(`/api/appointments/${other.id}`)).status).toBe(404);
    const detail = await tech.client.get(`/api/appointments/${mine.id}`);
    expect(detail.body.customer_email).toBeUndefined(); // no billing/contact extras beyond what the job needs
    expect(detail.body.notifications).toBeUndefined();

    expect((await tech.client.patch(`/api/appointments/${mine.id}`, { version: mine.version, notes: 'x' })).status).toBe(403);
    expect((await tech.client.post(`/api/appointments/${mine.id}/status`, { status: 'canceled' })).status).toBe(403);
    expect((await tech.client.post(`/api/appointments/${other.id}/status`, { status: 'completed' })).status).toBe(404);
    const started = await tech.client.post(`/api/appointments/${mine.id}/status`, { status: 'in_progress' });
    expect(started.status).toBe(200);
    expect(started.body.appointment.started_at).toBeTruthy();
    const completed = await tech.client.post(`/api/appointments/${mine.id}/status`, { status: 'completed' });
    expect(completed.status).toBe(200);
    expect(completed.body.appointment.invoice_total_cents).toBeUndefined();
    // Can't un-complete (that would void invoices): admin only.
    expect((await tech.client.post(`/api/appointments/${mine.id}/status`, { status: 'in_progress' })).status).toBe(403);
  });
});

describe('recurring bookings', () => {
  it('keeps the local time across daylight-saving changes and generates ahead on a rolling horizon', async () => {
    const { client, customer } = await setup();
    const res = await book(client, { customer_id: customer.id, start_at: localIso('2026-10-20T10:00'), recurrence: { freq: 'weekly', interval: 1 } });
    expect(res.status).toBe(201);
    expect(res.body.ids.length).toBeGreaterThanOrEqual(26);
    const rows = (
      await t.pool.query('SELECT start_at, series_index FROM appointments WHERE series_id = $1 ORDER BY series_index', [res.body.series_id])
    ).rows;
    for (const r of rows) expect(london(r.start_at.toISOString()).toFormat('ccc HH:mm')).toBe('Tue 10:00');
    // 20 Oct is BST (09:00Z), 27 Oct is GMT (10:00Z): same wall-clock time, different instant.
    expect(rows[0].start_at.toISOString()).toBe('2026-10-20T09:00:00.000Z');
    expect(rows[1].start_at.toISOString()).toBe('2026-10-27T10:00:00.000Z');
    // Re-running the generator is idempotent; running it later extends the series.
    const count = async () => (await t.pool.query('SELECT count(*)::int AS n, max(start_at) AS last FROM appointments WHERE series_id = $1', [res.body.series_id])).rows[0];
    await extendAllSeries(t.pool);
    expect((await count()).n).toBe(rows.length);
    // Two months later the rolling horizon (182 days) has moved on, so more weeks get generated.
    const later = new Date(Date.now() + 60 * 86_400_000);
    await extendAllSeries(t.pool, later);
    const after = await count();
    const horizon = later.getTime() + 182 * 86_400_000;
    expect(after.n).toBeGreaterThan(rows.length);
    expect(after.last.getTime()).toBeLessThanOrEqual(horizon);
    expect(after.last.getTime() + 7 * 86_400_000).toBeGreaterThan(horizon);
  });

  it('handles monthly series on the 31st and honours an occurrence limit', async () => {
    const { client, customer } = await setup();
    const res = await book(client, {
      customer_id: customer.id,
      start_at: localIso('2027-01-31T09:30'),
      recurrence: { freq: 'monthly', interval: 1, ends_after: 4 },
    });
    expect(res.status).toBe(201);
    const days = (await t.pool.query('SELECT start_at FROM appointments WHERE series_id = $1 ORDER BY start_at', [res.body.series_id])).rows.map((r) =>
      london(r.start_at.toISOString()).toFormat('dd LLL HH:mm'),
    );
    expect(days).toEqual(['31 Jan 09:30', '28 Feb 09:30', '31 Mar 09:30', '30 Apr 09:30']);
    const series = await t.pool.query('SELECT active FROM appointment_series WHERE id = $1', [res.body.series_id]);
    expect(series.rows[0].active).toBe(false);
  });

  it('moves "this and following" occurrences together and keeps the series in step', async () => {
    const { client, customer, tech } = await setup();
    const res = await book(client, {
      customer_id: customer.id,
      start_at: localIso('2026-11-03T10:00'),
      technician_ids: [tech.id],
      recurrence: { freq: 'weekly', interval: 1, ends_after: 6 },
    });
    const occ = (await t.pool.query('SELECT id, version FROM appointments WHERE series_id = $1 ORDER BY series_index', [res.body.series_id])).rows;
    const third = occ[2];
    const moved = await client.patch(`/api/appointments/${third.id}`, {
      version: third.version,
      start_at: localIso('2026-11-18T11:30'), // Tue 17 -> Wed 18, 10:00 -> 11:30
      scope: 'future',
      notify: false,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.affected).toBe(4);
    const times = (await t.pool.query('SELECT start_at FROM appointments WHERE series_id = $1 ORDER BY series_index', [res.body.series_id])).rows.map((r) =>
      london(r.start_at.toISOString()).toFormat('ccc dd HH:mm'),
    );
    expect(times).toEqual(['Tue 03 10:00', 'Tue 10 10:00', 'Wed 18 11:30', 'Wed 25 11:30', 'Wed 02 11:30', 'Wed 09 11:30']);
  });

  it('deletes "this and following" and stops the series', async () => {
    const { client, customer } = await setup();
    const res = await book(client, { customer_id: customer.id, start_at: localIso('2026-12-01T10:00'), recurrence: { freq: 'weekly', interval: 2 } });
    const occ = (await t.pool.query('SELECT id FROM appointments WHERE series_id = $1 ORDER BY series_index', [res.body.series_id])).rows;
    const del = await client.delete(`/api/appointments/${occ[3].id}?scope=future`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(occ.length - 3);
    await extendAllSeries(t.pool, new Date(Date.now() + 365 * 86_400_000));
    const left = await t.pool.query('SELECT count(*)::int AS n FROM appointments WHERE series_id = $1', [res.body.series_id]);
    expect(left.rows[0].n).toBe(3);
  });

  it('checks every occurrence for technician conflicts before creating a series', async () => {
    const { client, customer, tech } = await setup();
    await book(client, { customer_id: customer.id, start_at: localIso('2027-02-16T10:30'), technician_ids: [tech.id] });
    const res = await book(client, {
      customer_id: customer.id,
      start_at: localIso('2027-02-02T10:00'),
      technician_ids: [tech.id],
      recurrence: { freq: 'weekly', interval: 1, ends_after: 4 },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.conflicts[0].start_at).toBe(localIso('2027-02-16T10:30').replace('Z', '.000Z').replace('.000.000Z', '.000Z'));
  });
});
