import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, addEmployee, createTestApp, signup, uniqueEmail, type TestContext } from './helpers.js';

let t: TestContext;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

describe('auth & sessions', () => {
  it('signs up a business and sets a hardened session cookie', async () => {
    const client = new Client(t.app);
    const res = await client.post('/api/auth/signup', {
      business_name: 'Gleam Co',
      name: 'Ada',
      email: uniqueEmail('Ada').toUpperCase(),
      password: 'a strong passphrase',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('owner');
    expect(res.body.org).toMatchObject({ name: 'Gleam Co', timezone: 'Europe/London', currency: 'GBP' });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Secure/); // PUBLIC_URL is https in tests
    expect((await client.get('/api/auth/me')).status).toBe(200);
  });

  it('rejects weak passwords and duplicate emails', async () => {
    const c = new Client(t.app);
    const weak = await c.post('/api/auth/signup', { business_name: 'X', name: 'X', email: uniqueEmail(), password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.fields.password).toBeTruthy();
    const { email } = await signup(t.app);
    const dup = await new Client(t.app).post('/api/auth/signup', { business_name: 'Y', name: 'Y', email, password: 'another long password' });
    expect(dup.status).toBe(409);
  });

  it('logs in case-insensitively and rejects bad passwords with a generic message', async () => {
    const { email } = await signup(t.app);
    const c = new Client(t.app);
    const bad = await c.post('/api/auth/login', { email, password: 'wrong password!!' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe('Incorrect email or password');
    const unknown = await c.post('/api/auth/login', { email: 'nobody@example.com', password: 'wrong password!!' });
    expect(unknown.body.error.message).toBe('Incorrect email or password');
    const ok = await c.post('/api/auth/login', { email: email.toUpperCase(), password: 'correct horse battery' });
    expect(ok.status).toBe(200);
  });

  it('locks an account after repeated failures, even for the right password', async () => {
    const { email } = await signup(t.app);
    for (let i = 0; i < 8; i++) {
      await new Client(t.app).post('/api/auth/login', { email, password: `wrong-${i}-password` });
    }
    const locked = await new Client(t.app).post('/api/auth/login', { email, password: 'correct horse battery' });
    expect(locked.status).toBe(429);
    expect(locked.body.error.message).toMatch(/Try again in/);
  });

  it('requires the CSRF header on state-changing requests and a session on protected routes', async () => {
    const { client } = await signup(t.app);
    const noHeader = await t.app.inject({ method: 'POST', url: '/api/customers', payload: { name: 'X' }, headers: { cookie: client.cookie } });
    expect(noHeader.statusCode).toBe(403);
    expect((await new Client(t.app).get('/api/customers')).status).toBe(401);
  });

  it('changes the password and signs out other devices', async () => {
    const { client, email } = await signup(t.app);
    const other = new Client(t.app);
    await other.post('/api/auth/login', { email, password: 'correct horse battery' });
    const wrong = await client.post('/api/auth/password', { current_password: 'nope', new_password: 'brand new password' });
    expect(wrong.status).toBe(400);
    const ok = await client.post('/api/auth/password', { current_password: 'correct horse battery', new_password: 'brand new password' });
    expect(ok.status).toBe(200);
    expect((await client.get('/api/auth/me')).status).toBe(200);
    expect((await other.get('/api/auth/me')).status).toBe(401);
  });

  it('resets a forgotten password with a single-use emailed token, hidden from the message log', async () => {
    const { client, email } = await signup(t.app);
    expect((await new Client(t.app).post('/api/auth/forgot-password', { email: 'unknown@example.com' })).body).toEqual({ ok: true });
    expect((await new Client(t.app).post('/api/auth/forgot-password', { email })).status).toBe(200);
    const row = await t.pool.query(`SELECT body FROM notifications WHERE kind = 'password_reset' AND recipient = $1`, [email]);
    const token = /token=([A-Za-z0-9_-]+)/.exec(row.rows[0].body)![1];
    const log = await client.get('/api/notifications');
    const entry = log.body.items.find((n: { kind: string }) => n.kind === 'password_reset');
    expect(entry.body).not.toContain(token);

    const anon = new Client(t.app);
    expect((await anon.post('/api/auth/reset-password', { token, password: 'my new password 1' })).status).toBe(200);
    expect((await anon.post('/api/auth/reset-password', { token, password: 'my new password 2' })).status).toBe(400); // single use
    expect((await client.get('/api/auth/me')).status).toBe(401); // existing sessions revoked
    expect((await anon.post('/api/auth/login', { email, password: 'my new password 1' })).status).toBe(200);
  });

  it('invites an employee who can only use technician features', async () => {
    const { client: admin } = await signup(t.app);
    const emp = await addEmployee(t.app, admin);
    expect((await emp.client.get('/api/auth/me')).body.user.role).toBe('employee');
    for (const url of ['/api/customers', '/api/invoices', '/api/inventory', '/api/reports/dashboard', '/api/settings', '/api/users']) {
      expect((await emp.client.get(url)).status, url).toBe(403);
    }
    expect((await emp.client.get('/api/team')).status).toBe(200);
    expect((await emp.client.get('/api/services')).status).toBe(200);
  });

  it('revokes sessions of deactivated users and protects the owner account', async () => {
    const { client: owner, userId: ownerId } = await signup(t.app);
    const admin2 = await addEmployee(t.app, owner, 'Second Admin', 'admin');
    const emp = await addEmployee(t.app, owner);
    expect((await admin2.client.patch(`/api/users/${ownerId}`, { name: 'Hacked' })).status).toBe(403);
    expect((await admin2.client.delete(`/api/users/${ownerId}`)).status).toBe(403);
    expect((await owner.patch(`/api/users/${ownerId}`, { role: 'employee' })).status).toBe(400);
    expect((await admin2.client.patch(`/api/users/${admin2.id}`, { active: false })).status).toBe(400);

    const res = await owner.patch(`/api/users/${emp.id}`, { active: false });
    expect(res.status).toBe(200);
    expect((await emp.client.get('/api/auth/me')).status).toBe(401);
    expect((await new Client(t.app).post('/api/auth/login', { email: emp.email, password: 'employee password 1' })).status).toBe(401);
  });

  it('rate-limits sign-in attempts per IP', async () => {
    const limited = await createTestApp({ AUTH_RATE_LIMIT: '3' });
    try {
      const statuses = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await new Client(limited.app).post('/api/auth/login', { email: 'x@example.com', password: 'whatever!!' })).status);
      }
      expect(statuses).toEqual([401, 401, 401, 429]);
    } finally {
      await limited.close();
    }
  });

  it('survives malformed URLs (v1 crashed the whole server on these)', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/%E0%A4%A' });
    expect(res.statusCode).toBe(400);
    const api = await t.app.inject({ method: 'GET', url: '/api/customers/%E0%A4%A' });
    expect(api.statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('returns 404 (not 500) for non-UUID ids and unknown API routes', async () => {
    const { client } = await signup(t.app);
    expect((await client.get('/api/customers/not-a-uuid')).status).toBe(404);
    expect((await client.get('/api/nope')).status).toBe(404);
  });
});
