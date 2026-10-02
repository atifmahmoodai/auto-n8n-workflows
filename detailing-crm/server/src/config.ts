import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEV_SECRET = 'dev-only-secret-change-me-dev-only-secret-change-me';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DATABASE_SSL: bool.default('false'),
    PUBLIC_URL: z.string().url().default('http://localhost:3000'),
    APP_SECRET: z.string().min(32, 'must be at least 32 characters').default(DEV_SECRET),
    SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
    /** Max sign-in/sign-up/reset attempts per IP per minute. */
    AUTH_RATE_LIMIT: z.coerce.number().int().min(1).max(100_000).default(10),
    TRUST_PROXY: bool.default('false'),
    ALLOW_SIGNUP: bool.default('false'),
    UPLOAD_DIR: z.string().default(path.resolve(here, '..', 'uploads')),
    WEB_DIST_DIR: z.string().default(path.resolve(here, '..', '..', 'web', 'dist')),
    MAX_UPLOAD_MB: z.coerce.number().min(1).max(50).default(15),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    SCHEDULER_ENABLED: bool.default('true'),
    SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_FROM_NUMBER: z.string().optional(),
    TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
    TWILIO_VALIDATE_WEBHOOKS: bool.default('true'),
    SENDGRID_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().email().optional(),
    EMAIL_FROM_NAME: z.string().default('Detailing CRM'),
    BOOTSTRAP_ORG_NAME: z.string().optional(),
    BOOTSTRAP_ADMIN_NAME: z.string().default('Owner'),
    BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
    BOOTSTRAP_ADMIN_PASSWORD: z.string().min(10).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === 'production' && c.APP_SECRET === DEV_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['APP_SECRET'], message: 'must be set to a random value in production' });
    }
    if (c.TWILIO_ACCOUNT_SID && !c.TWILIO_AUTH_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['TWILIO_AUTH_TOKEN'],
        message: 'is required when TWILIO_ACCOUNT_SID is set',
      });
    }
    if (c.TWILIO_ACCOUNT_SID && !c.TWILIO_FROM_NUMBER && !c.TWILIO_MESSAGING_SERVICE_SID) {
      ctx.addIssue({
        code: 'custom',
        path: ['TWILIO_FROM_NUMBER'],
        message: 'TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID is required when Twilio is enabled',
      });
    }
    if (c.SENDGRID_API_KEY && !c.EMAIL_FROM) {
      ctx.addIssue({ code: 'custom', path: ['EMAIL_FROM'], message: 'is required when SENDGRID_API_KEY is set' });
    }
    if (c.BOOTSTRAP_ADMIN_EMAIL && !c.BOOTSTRAP_ADMIN_PASSWORD) {
      ctx.addIssue({
        code: 'custom',
        path: ['BOOTSTRAP_ADMIN_PASSWORD'],
        message: 'is required with BOOTSTRAP_ADMIN_EMAIL',
      });
    }
  });

export type Config = z.infer<typeof schema> & {
  twilioEnabled: boolean;
  sendgridEnabled: boolean;
  isProduction: boolean;
  /** HTTPS deployment: Secure cookies, HSTS. Derived from PUBLIC_URL, not NODE_ENV, so a plain-HTTP
   *  production test install doesn't end up with cookies the browser refuses to send back. */
  httpsOnly: boolean;
};

/** Parses and validates environment variables. Throws a readable error listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings (e.g. "TWILIO_ACCOUNT_SID=" copied from .env.example) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'config'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  return {
    ...c,
    PUBLIC_URL: c.PUBLIC_URL.replace(/\/+$/, ''),
    twilioEnabled: Boolean(c.TWILIO_ACCOUNT_SID && c.TWILIO_AUTH_TOKEN),
    sendgridEnabled: Boolean(c.SENDGRID_API_KEY && c.EMAIL_FROM),
    isProduction: c.NODE_ENV === 'production',
    httpsOnly: c.PUBLIC_URL.startsWith('https://'),
  };
}
