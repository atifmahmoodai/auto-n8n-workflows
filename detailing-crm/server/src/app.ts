import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import { SESSION_COOKIE, resolveSession } from './auth/session.js';
import type { Config } from './config.js';
import type { Pool } from './db/pool.js';
import { AppError, PG, pgCode } from './lib/errors.js';
import type { Storage } from './lib/storage.js';
import type { Providers } from './notifications/providers.js';
import { createScheduler, type Scheduler } from './jobs/scheduler.js';
import { registerRoutes } from './routes/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    scheduler: Scheduler;
  }
}

export interface AppDeps {
  config: Config;
  pool: Pool;
  storage: Storage;
  providers: Providers;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function loggerOptions(config: Config): FastifyServerOptions['logger'] {
  if (config.LOG_LEVEL === 'silent') return false;
  const base = {
    level: config.LOG_LEVEL,
    redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]', 'req.headers["x-twilio-signature"]'],
  };
  if (config.NODE_ENV === 'development') {
    return { ...base, transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } };
  }
  return base;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, pool } = deps;
  const app = Fastify({
    logger: loggerOptions(config),
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    // Signed tokens in URLs (e.g. unsubscribe links) are longer than Fastify's 100-character default.
    routerOptions: { maxParamLength: 500 },
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: false,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // React/Mantine set inline style attributes, which CSP treats as inline styles.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.httpsOnly ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.httpsOnly ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  await app.register(cookie);
  await app.register(formbody, { bodyLimit: 64 * 1024 });
  await app.register(multipart, {
    limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 10, fields: 10, fieldSize: 1024 },
  });
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/healthz' || req.url === '/readyz',
  });

  app.decorateRequest('auth', null);
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  app.addHook('onRequest', async (req) => {
    const url = req.url;
    if (!url.startsWith('/api/')) return;
    if (!SAFE_METHODS.has(req.method) && !url.startsWith('/api/webhooks/') && !url.startsWith('/api/public/')) {
      // CSRF defence: browsers cannot attach custom headers to cross-site form posts, and
      // cross-origin fetches with custom headers need a CORS preflight that this API never grants.
      if (req.headers['x-requested-with'] !== 'fetch') {
        throw new AppError(403, 'csrf', 'Missing or invalid request header');
      }
    }
    const token = req.cookies[SESSION_COOKIE];
    if (token) req.auth = await resolveSession(pool, token, config.SESSION_TTL_DAYS);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, ...(err.details ?? {}) } });
    }
    if (err instanceof ZodError) {
      const fields: Record<string, string> = {};
      for (const issue of err.issues) {
        const key = issue.path.join('.') || '_';
        fields[key] ??= issue.message;
      }
      const first = err.issues[0];
      const where = first?.path.length ? `${first.path.join('.')}: ` : '';
      return reply.code(400).send({ error: { code: 'validation_error', message: `${where}${first?.message ?? 'Invalid input'}`, fields } });
    }
    const code = pgCode(err);
    if (code === PG.UNIQUE) return reply.code(409).send({ error: { code: 'already_exists', message: 'That record already exists' } });
    if (code === PG.FOREIGN_KEY) {
      const detail = String((err as { detail?: string }).detail ?? '');
      return /still referenced/.test(detail)
        ? reply.code(409).send({ error: { code: 'in_use', message: 'It is still in use by other records' } })
        : reply.code(400).send({ error: { code: 'invalid_reference', message: 'A referenced record does not exist' } });
    }
    if (code === PG.CHECK || code === PG.NOT_NULL || code === PG.OUT_OF_RANGE || code === PG.INVALID_TEXT) {
      return reply.code(400).send({ error: { code: 'invalid_value', message: 'One of the values is not allowed' } });
    }
    const status = typeof (err as { statusCode?: number }).statusCode === 'number' ? (err as { statusCode: number }).statusCode : 500;
    if (status < 500) {
      const e = err as { code?: string; message?: string };
      const fallback = { 404: 'not_found', 413: 'too_large', 415: 'unsupported_media_type', 429: 'rate_limited' }[status] ?? 'bad_request';
      const message = status === 413 ? 'That upload is too large' : (e.message ?? 'Bad request');
      return reply.code(status).send({ error: { code: (e.code ?? fallback).toLowerCase(), message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Something went wrong. Please try again.' } });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  const scheduler = createScheduler({ ...deps, log: app.log.child({ component: 'scheduler' }) });
  app.decorate('scheduler', scheduler);
  app.addHook('onClose', async () => scheduler.stop());

  await app.register(async (api) => registerRoutes(api, { ...deps, scheduler }), { prefix: '/api' });

  // Single-page app: built frontend served by the same process in production.
  const dist = config.WEB_DIST_DIR;
  const hasWeb = fs.existsSync(path.join(dist, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: dist,
      wildcard: false,
      index: false,
      setHeaders: (res, filePath) => {
        // Vite fingerprints everything in /assets, so it can be cached forever.
        res.setHeader('Cache-Control', filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    if (hasWeb && req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  return app;
}
