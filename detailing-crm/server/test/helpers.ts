import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool, type Pool } from '../src/db/pool.js';
import { createLocalStorage } from '../src/lib/storage.js';
import { ProviderError, type EmailMessage, type Providers } from '../src/notifications/providers.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/crm_test';

export interface SentSms {
  to: string;
  body: string;
}

/** Records every message instead of calling Twilio/SendGrid. Set failNext to simulate provider errors. */
export class FakeProviders implements Providers {
  smsEnabled = true;
  emailEnabled = true;
  sms: SentSms[] = [];
  emails: EmailMessage[] = [];
  failNext: Array<ProviderError | Error> = [];
  delayMs = 0;

  async sendSms(to: string, body: string) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const err = this.failNext.shift();
    if (err) throw err;
    this.sms.push({ to, body });
    return { status: 'sent' as const, providerId: `SM${crypto.randomBytes(8).toString('hex')}` };
  }

  async sendEmail(msg: EmailMessage) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const err = this.failNext.shift();
    if (err) throw err;
    this.emails.push(msg);
    return { status: 'sent' as const, providerId: crypto.randomBytes(8).toString('hex') };
  }

  reset() {
    this.sms = [];
    this.emails = [];
    this.failNext = [];
    this.delayMs = 0;
  }
}

export interface TestContext {
  app: FastifyInstance;
  pool: Pool;
  config: Config;
  providers: FakeProviders;
  uploadDir: string;
  close(): Promise<void>;
}

export async function createTestApp(env: Record<string, string> = {}): Promise<TestContext> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-uploads-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    LOG_LEVEL: 'silent',
    ALLOW_SIGNUP: 'true',
    AUTH_RATE_LIMIT: '100000',
    SCHEDULER_ENABLED: 'false',
    PUBLIC_URL: 'https://crm.example.com',
    APP_SECRET: 'test-secret-test-secret-test-secret-123456',
    UPLOAD_DIR: uploadDir,
    WEB_DIST_DIR: path.join(uploadDir, 'no-web'),
    ...env,
  });
  const pool = createPool({ connectionString: TEST_DATABASE_URL, max: 10, ssl: false });
  const providers = new FakeProviders();
  const app = await buildApp({ config, pool, storage: createLocalStorage(uploadDir), providers });
  await app.ready();
  return {
    app,
    pool,
    config,
    providers,
    uploadDir,
    async close() {
      await app.close();
      await pool.end();
      fs.rmSync(uploadDir, { recursive: true, force: true });
    },
  };
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: import('node:http').OutgoingHttpHeaders;
  raw: Buffer;
}

export class Client {
  cookie = '';
  constructor(private app: FastifyInstance) {}

  async request<T = any>(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const res = await this.app.inject({
      method: method as 'GET',
      url,
      payload: payload === undefined ? undefined : (payload as object),
      headers: { 'x-requested-with': 'fetch', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
    });
    const setCookie = res.headers['set-cookie'];
    const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (first?.startsWith('sid=')) this.cookie = first.split(';')[0]!;
    let body: any = res.body;
    if (String(res.headers['content-type'] ?? '').includes('application/json')) body = res.json();
    return { status: res.statusCode, body, headers: res.headers, raw: res.rawPayload };
  }
  get<T = any>(url: string) {
    return this.request<T>('GET', url);
  }
  post<T = any>(url: string, payload: unknown = {}) {
    return this.request<T>('POST', url, payload);
  }
  patch<T = any>(url: string, payload: unknown = {}) {
    return this.request<T>('PATCH', url, payload);
  }
  put<T = any>(url: string, payload: unknown = {}) {
    return this.request<T>('PUT', url, payload);
  }
  delete<T = any>(url: string) {
    return this.request<T>('DELETE', url);
  }
}

let counter = 0;
export function uniqueEmail(prefix = 'user') {
  counter += 1;
  return `${prefix}.${Date.now()}.${counter}.${crypto.randomBytes(3).toString('hex')}@example.com`;
}

/** Creates a fresh organisation + owner and returns a signed-in client. */
export async function signup(app: FastifyInstance, opts: Partial<{ business_name: string; timezone: string; currency: string; country: string }> = {}) {
  const client = new Client(app);
  const email = uniqueEmail('owner');
  const res = await client.post('/api/auth/signup', {
    business_name: opts.business_name ?? 'Shine Detailing',
    name: 'Olivia Owner',
    email,
    password: 'correct horse battery',
    timezone: opts.timezone ?? 'Europe/London',
    currency: opts.currency ?? 'GBP',
    country: opts.country ?? 'GB',
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { client, email, me: res.body, orgId: res.body.org.id as string, userId: res.body.user.id as string };
}

/** Invites an employee and accepts the invite; returns a signed-in client for them. */
export async function addEmployee(app: FastifyInstance, admin: Client, name = 'Sam Tech', role: 'employee' | 'admin' = 'employee') {
  const email = uniqueEmail(name.split(' ')[0]!.toLowerCase());
  const res = await admin.post('/api/users', { name, email, role });
  if (res.status !== 201) throw new Error(`invite failed: ${JSON.stringify(res.body)}`);
  const token = new URL(res.body.invite_url).searchParams.get('token');
  const client = new Client(app);
  const accepted = await client.post('/api/auth/invite/accept', { token, password: 'employee password 1' });
  if (accepted.status !== 200) throw new Error(`accept failed: ${JSON.stringify(accepted.body)}`);
  return { client, id: res.body.user.id as string, email };
}

export async function createCustomer(admin: Client, overrides: Record<string, unknown> = {}) {
  const res = await admin.post('/api/customers', {
    name: 'Jack Wilson',
    phone: `07400 1${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`,
    email: uniqueEmail('customer'),
    vehicles: [{ make: 'Audi', model: 'A3', year: 2019, plate: 'AB19 CDE' }],
    allow_duplicate: true,
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`customer failed: ${JSON.stringify(res.body)}`);
  const detail = await admin.get(`/api/customers/${res.body.id}`);
  return detail.body as { id: string; phone: string; email: string; vehicles: Array<{ id: string }> };
}

export async function createService(admin: Client, overrides: Record<string, unknown> = {}) {
  const res = await admin.post('/api/services', { name: 'Full valet', price_cents: 9000, duration_min: 120, ...overrides });
  if (res.status !== 201) throw new Error(`service failed: ${JSON.stringify(res.body)}`);
  return res.body as { id: string; price_cents: number; duration_min: number };
}

export const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

export async function book(admin: Client, body: Record<string, unknown>) {
  return admin.post('/api/appointments', { notify: false, ...body });
}
