'use strict';
process.env.TZ = 'Europe/London';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, addInterval } = require('../src/server');
const { runScheduler } = require('../src/notify');

const PNG = 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(200)]).toString('base64');
let server, base, app;

function client() {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.arrayBuffer() };
  };
}

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-'));
  app = createApp({ dbFile: ':memory:', uploadDir: path.join(dir, 'up') });
  server = http.createServer(app.handler);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('full admin + employee workflow', async () => {
  const admin = client(); const emp = client(); const anon = client();
  assert.equal((await anon('GET', '/api/customers')).status, 401);
  assert.equal((await admin('POST', '/api/login', { email: 'admin@example.com', password: 'wrong' })).status, 401);
  assert.equal((await admin('POST', '/api/login', { email: 'ADMIN@example.com', password: 'admin123' })).status, 200);
  // CSRF header required for writes
  assert.equal((await admin('POST', '/api/customers', { name: 'x' }, { 'X-Requested-With': '' })).status, 403);

  const tech = (await admin('POST', '/api/users', { name: 'Tech', email: 't@x.io', password: 'password1', role: 'employee' })).body;
  assert.equal((await admin('POST', '/api/users', { name: 'Dup', email: 'T@x.io', password: 'password1' })).status, 409);
  const svc = (await admin('POST', '/api/services', { name: 'Full valet', price: 90, duration_min: 120 })).body;
  const cust = (await admin('POST', '/api/customers', { name: 'Olivia Brown', phone: '+447700900001', email: 'o@x.io', notes: 'Pet hair',
    vehicles: [{ make: 'Audi', model: 'A3', year: 2019, plate: 'ab19 cde', vin: 'wauzzz' }] })).body;
  const detail = (await admin('GET', `/api/customers/${cust.id}`)).body;
  assert.equal(detail.vehicles[0].plate, 'AB19 CDE');
  // search by plate, by name, and wildcard chars are literal
  assert.equal((await admin('GET', '/api/customers?q=ab19')).body.length, 1);
  assert.equal((await admin('GET', '/api/customers?q=olivia')).body.length, 1);
  assert.equal((await admin('GET', '/api/customers?q=%25')).body.length, 0);

  // booking + immediate confirmation (simulated)
  const start = new Date(Date.now() + 3 * 3600e3);
  const r = await admin('POST', '/api/appointments', { customer_id: cust.id, vehicle_id: detail.vehicles[0].id, service_id: svc.id, technician_id: tech.id, start_at: start.toISOString(), status: 'confirmed' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const apptId = r.body.ids[0];
  assert.equal(r.body.appointment.price, 90);
  assert.equal(new Date(r.body.appointment.end_at) - new Date(r.body.appointment.start_at), 120 * 60000);
  await new Promise(res => setTimeout(res, 50));
  const notes = (await admin('GET', '/api/notifications')).body;
  assert.ok(notes.some(n => n.type === 'confirmation' && n.channel === 'sms' && n.status === 'simulated'));

  // double booking -> 409, force -> ok
  const clash = await admin('POST', '/api/appointments', { customer_id: cust.id, technician_id: tech.id, start_at: new Date(start.getTime() + 30 * 60000).toISOString(), send_confirmation: false });
  assert.equal(clash.status, 409);
  const forced = await admin('POST', '/api/appointments', { customer_id: cust.id, technician_id: tech.id, start_at: new Date(start.getTime() + 30 * 60000).toISOString(), send_confirmation: false, force: true });
  assert.equal(forced.status, 200);
  // wrong vehicle for customer rejected
  const c2 = (await admin('POST', '/api/customers', { name: 'Jack' })).body;
  assert.equal((await admin('POST', '/api/appointments', { customer_id: c2.id, vehicle_id: detail.vehicles[0].id, start_at: start.toISOString() })).status, 400);

  // recurring weekly x4, delete future from 2nd
  const rec = await admin('POST', '/api/appointments', { customer_id: c2.id, start_at: new Date(Date.now() + 10 * 86400e3).toISOString(), recurrence: 'weekly', occurrences: 4, send_confirmation: false });
  assert.equal(rec.body.ids.length, 4);
  assert.equal((await admin('DELETE', `/api/appointments/${rec.body.ids[1]}?scope=future`)).body.deleted, 3);

  // reminder scheduler: within 24h -> sent once
  let s = await runScheduler(app.db);
  assert.ok(s.reminders >= 1);
  s = await runScheduler(app.db);
  assert.equal(s.reminders, 0);

  // employee permissions
  assert.equal((await emp('POST', '/api/login', { email: 't@x.io', password: 'password1' })).status, 200);
  assert.equal((await emp('GET', '/api/customers')).status, 403);
  assert.equal((await emp('GET', '/api/reports')).status, 403);
  const mine = (await emp('GET', '/api/appointments')).body;
  assert.ok(mine.length >= 1 && mine.every(a => a.technician_id === tech.id));
  assert.equal((await emp('GET', `/api/appointments/${rec.body.ids[0]}`)).status, 403);
  assert.equal((await emp('PUT', `/api/appointments/${apptId}`, { price: 1 })).status, 403);
  const ph = await emp('POST', `/api/appointments/${apptId}/photos`, { kind: 'before', data: PNG });
  assert.equal(ph.status, 200, JSON.stringify(ph.body));
  assert.equal((await emp('POST', `/api/appointments/${apptId}/photos`, { kind: 'after', data: 'data:text/html;base64,PGI+' })).status, 400);
  const img = await emp('GET', `/api/photos/${ph.body.id}`);
  assert.equal(img.status, 200);
  assert.equal((await emp('PUT', `/api/appointments/${apptId}`, { status: 'completed' })).status, 200);

  // invoice auto-created; mark paid
  const invs = (await admin('GET', '/api/invoices')).body;
  assert.equal(invs.length, 1);
  assert.equal(invs[0].amount, 90);
  const inv = (await admin('GET', `/api/invoices/${invs[0].id}`)).body;
  assert.equal(inv.photos.length, 1);
  assert.equal((await admin('PUT', `/api/invoices/${inv.id}`, { status: 'paid' })).body.status, 'paid');

  // follow-up after completion (simulate time passing)
  s = await runScheduler(app.db, Date.now() + 3 * 3600e3);
  assert.equal(s.followups, 1);

  // inventory low stock alert -> notification once, re-armed after restock
  const item = (await admin('POST', '/api/inventory', { name: 'Wax', quantity: 3, low_threshold: 2 })).body;
  await admin('POST', `/api/inventory/${item.id}/adjust`, { delta: -2 });
  await new Promise(res => setTimeout(res, 50));
  const lowCount = () => app.db.prepare("SELECT COUNT(*) n FROM notifications WHERE type='low_stock'").get().n;
  assert.equal(lowCount(), 1);
  await admin('POST', `/api/inventory/${item.id}/adjust`, { delta: -1 });
  await new Promise(res => setTimeout(res, 50));
  assert.equal(lowCount(), 1);
  assert.equal((await admin('POST', `/api/inventory/${item.id}/adjust`, { delta: -50 })).body.quantity, 0);

  // reports
  const rep = (await admin('GET', '/api/reports')).body;
  assert.equal(rep.monthly.length, 12);
  assert.equal(rep.topCustomers[0].name, 'Olivia Brown');
  assert.equal(rep.topServices[0].name !== undefined, true);
  assert.equal(rep.lowStock.length, 1);

  // reopening a completed job voids an unpaid invoice but leaves paid ones alone
  assert.equal((await admin('PUT', `/api/appointments/${apptId}`, { status: 'confirmed' })).status, 200);
  assert.equal((await admin('GET', `/api/invoices/${inv.id}`)).body.status, 'paid');

  // deactivated user is logged out
  await admin('PUT', `/api/users/${tech.id}`, { active: false });
  assert.equal((await emp('GET', '/api/appointments')).status, 401);
  // static + traversal
  assert.equal((await anon('GET', '/')).status, 200);
  assert.notEqual((await anon('GET', '/..%2f..%2fpackage.json')).status, 200);
});

test('monthly recurrence clamps to month end, weekly keeps local time over DST', () => {
  const jan31 = new Date(2026, 0, 31, 10, 0);
  assert.equal(addInterval(jan31, 'monthly', 1).getDate(), 28);
  const preDst = new Date(2026, 2, 24, 10, 0); // DST starts 29 Mar in UK
  assert.equal(addInterval(preDst, 'weekly', 1).getHours(), 10);
});
