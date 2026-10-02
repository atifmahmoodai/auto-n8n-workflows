import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import {
  clearSessionCookie,
  createSession,
  destroySessionsForUser,
  requireAuth,
  setSessionCookie,
} from '../auth/session.js';
import { many, one, withTx, type Db } from '../db/pool.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto.js';
import { AppError, badRequest, conflict } from '../lib/errors.js';
import { loadOrg } from '../lib/org.js';
import { isValidCountry } from '../lib/phone.js';
import { isValidZone } from '../lib/time.js';
import { enqueueStaffEmail } from '../notifications/messages.js';

const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 15;

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200, 'Use at most 200 characters');

const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address').max(200);

interface UserRow {
  id: string;
  org_id: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'employee';
  password_hash: string | null;
  active: boolean;
  failed_logins: number;
  locked_until: Date | null;
  color: string;
}

export function validCurrency(code: string): boolean {
  return Intl.supportedValuesOf('currency').includes(code);
}

export async function createToken(
  db: Db,
  userId: string,
  purpose: 'password_reset' | 'invite',
  hours: number,
): Promise<string> {
  const token = randomToken();
  // Only one live token per purpose: issuing a new link invalidates older ones.
  await db.query(`DELETE FROM auth_tokens WHERE user_id = $1 AND purpose = $2`, [userId, purpose]);
  await db.query(
    `INSERT INTO auth_tokens (id, user_id, purpose, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [sha256(token), userId, purpose, hours],
  );
  return token;
}

export async function mePayload(deps: AppDeps, userId: string) {
  const user = await one<{ id: string; org_id: string; name: string; email: string; role: string; color: string; phone: string | null }>(
    deps.pool,
    'SELECT id, org_id, name, email, role, color, phone FROM users WHERE id = $1',
    [userId],
  );
  if (!user) throw new AppError(401, 'unauthorized', 'Please sign in');
  const org = await loadOrg(deps.pool, user.org_id);
  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role, color: user.color, phone: user.phone },
    org: {
      id: org.id,
      name: org.name,
      timezone: org.timezone,
      currency: org.currency,
      country: org.country,
      locale: org.settings.locale,
      tax_rate_bp: org.settings.invoicing.tax_rate_bp,
      prices_include_tax: org.settings.invoicing.prices_include_tax,
      default_duration_min: org.settings.booking.default_duration_min,
      default_status: org.settings.booking.default_status,
    },
    features: { sms: deps.providers.smsEnabled, email: deps.providers.emailEnabled },
  };
}

function requestMeta(req: FastifyRequest) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps) {
  const { pool, config } = deps;
  const cookieOpts = { secure: config.httpsOnly, ttlDays: config.SESSION_TTL_DAYS };
  const authRateLimit = { rateLimit: { max: config.AUTH_RATE_LIMIT, timeWindow: '1 minute' } };

  app.get('/auth/setup-status', async () => {
    const row = await one<{ n: number }>(pool, 'SELECT count(*)::int AS n FROM organizations');
    const needsSetup = (row?.n ?? 0) === 0;
    return { needs_setup: needsSetup, signup_enabled: needsSetup || config.ALLOW_SIGNUP };
  });

  app.post('/auth/signup', { config: authRateLimit }, async (req, reply) => {
    const body = z
      .object({
        business_name: z.string().trim().min(1).max(120),
        name: z.string().trim().min(1).max(100),
        email: emailSchema,
        password: passwordSchema,
        timezone: z.string().refine(isValidZone, 'Unknown time zone').default('Europe/London'),
        currency: z.string().toUpperCase().refine(validCurrency, 'Unknown currency').default('GBP'),
        country: z.string().toUpperCase().refine(isValidCountry, 'Unknown country').default('GB'),
      })
      .parse(req.body);
    const result = await withTx(pool, async (tx) => {
      // Serialise signups so the "first organisation" check cannot race.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('crm:signup'))`);
      const count = await one<{ n: number }>(tx, 'SELECT count(*)::int AS n FROM organizations');
      if ((count?.n ?? 0) > 0 && !config.ALLOW_SIGNUP) throw new AppError(403, 'signup_disabled', 'Sign-ups are disabled on this server');
      const exists = await one(tx, 'SELECT 1 FROM users WHERE email = $1', [body.email]);
      if (exists) throw conflict('email_taken', 'An account with that email already exists. Try signing in.');
      const org = await one<{ id: string }>(
        tx,
        `INSERT INTO organizations (name, timezone, currency, country) VALUES ($1, $2, $3, $4) RETURNING id`,
        [body.business_name, body.timezone, body.currency, body.country],
      );
      const user = await one<{ id: string; org_id: string }>(
        tx,
        `INSERT INTO users (org_id, name, email, role, password_hash) VALUES ($1, $2, $3, 'owner', $4) RETURNING id, org_id`,
        [org!.id, body.name, body.email, await hashPassword(body.password)],
      );
      const token = await createSession(tx, user!, { ...requestMeta(req), ttlDays: config.SESSION_TTL_DAYS });
      return { userId: user!.id, token };
    });
    setSessionCookie(reply, result.token, cookieOpts);
    return reply.code(201).send(await mePayload(deps, result.userId));
  });

  app.post('/auth/login', { config: authRateLimit }, async (req, reply) => {
    const body = z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().max(200) }).parse(req.body);
    const user = await one<UserRow>(pool, 'SELECT * FROM users WHERE email = $1', [body.email]);
    if (user?.locked_until && user.locked_until > new Date()) {
      const minutes = Math.ceil((user.locked_until.getTime() - Date.now()) / 60_000);
      throw new AppError(429, 'locked', `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    }
    // verifyPassword burns the same CPU time for unknown users, so timing doesn't reveal accounts.
    const ok = await verifyPassword(body.password, user?.active ? user.password_hash : null);
    if (!user || !user.active || !ok) {
      if (user?.active) {
        await pool.query(
          `UPDATE users SET failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
                  locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
            WHERE id = $1`,
          [user.id, MAX_FAILED_LOGINS, LOCK_MINUTES],
        );
      }
      throw new AppError(401, 'invalid_credentials', 'Incorrect email or password');
    }
    await pool.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
    const token = await createSession(pool, user, { ...requestMeta(req), ttlDays: config.SESSION_TTL_DAYS });
    setSessionCookie(reply, token, cookieOpts);
    return mePayload(deps, user.id);
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.auth) await pool.query('DELETE FROM sessions WHERE id = $1', [req.auth.sessionId]);
    clearSessionCookie(reply, config.httpsOnly);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => mePayload(deps, requireAuth(req).userId));

  app.post('/auth/password', { config: authRateLimit }, async (req) => {
    const auth = requireAuth(req);
    const body = z.object({ current_password: z.string().max(200), new_password: passwordSchema }).parse(req.body);
    const row = await one<{ password_hash: string }>(pool, 'SELECT password_hash FROM users WHERE id = $1', [auth.userId]);
    if (!(await verifyPassword(body.current_password, row?.password_hash))) {
      throw badRequest('Your current password is incorrect', { fields: { current_password: 'Incorrect password' } });
    }
    await pool.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [auth.userId, await hashPassword(body.new_password)]);
    // Sign out every other device.
    await destroySessionsForUser(pool, auth.userId, auth.sessionId);
    return { ok: true };
  });

  app.patch('/auth/profile', async (req) => {
    const auth = requireAuth(req);
    const body = z
      .object({ name: z.string().trim().min(1).max(100).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() })
      .parse(req.body);
    await pool.query('UPDATE users SET name = COALESCE($2, name), color = COALESCE($3, color), updated_at = now() WHERE id = $1', [
      auth.userId,
      body.name ?? null,
      body.color ?? null,
    ]);
    return mePayload(deps, auth.userId);
  });

  app.post('/auth/forgot-password', { config: authRateLimit }, async (req) => {
    const body = z.object({ email: z.string().trim().toLowerCase().max(200) }).parse(req.body);
    const user = await one<{ id: string; org_id: string; name: string; email: string }>(
      pool,
      'SELECT id, org_id, name, email FROM users WHERE email = $1 AND active AND password_hash IS NOT NULL',
      [body.email],
    );
    if (user) {
      await withTx(pool, async (tx) => {
        const token = await createToken(tx, user.id, 'password_reset', 1);
        const org = await loadOrg(tx, user.org_id);
        await enqueueStaffEmail(tx, org, {
          kind: 'password_reset',
          to: user.email,
          subject: 'Reset your password',
          text: `Hi ${user.name},\n\nSomeone (hopefully you) asked to reset your password. The link works for 1 hour. If it wasn't you, you can ignore this email.`,
          action: { label: 'Choose a new password', url: `${config.PUBLIC_URL}/reset-password?token=${token}` },
        });
      });
    }
    // Same answer whether or not the account exists (no account enumeration).
    return { ok: true };
  });

  async function consumeToken(token: string, purpose: 'password_reset' | 'invite') {
    const row = await one<{ id: string; user_id: string; email: string; name: string; org_name: string }>(
      pool,
      `SELECT t.id, t.user_id, u.email, u.name, o.name AS org_name
         FROM auth_tokens t JOIN users u ON u.id = t.user_id JOIN organizations o ON o.id = u.org_id
        WHERE t.id = $1 AND t.purpose = $2 AND t.used_at IS NULL AND t.expires_at > now() AND u.active`,
      [sha256(token), purpose],
    );
    if (!row) throw badRequest('This link is invalid or has expired. Ask for a new one.');
    return row;
  }

  app.post('/auth/reset-password', { config: authRateLimit }, async (req) => {
    const body = z.object({ token: z.string().min(10).max(200), password: passwordSchema }).parse(req.body);
    const t = await consumeToken(body.token, 'password_reset');
    await withTx(pool, async (tx) => {
      await tx.query('UPDATE auth_tokens SET used_at = now() WHERE id = $1', [t.id]);
      await tx.query('UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [
        t.user_id,
        await hashPassword(body.password),
      ]);
      await destroySessionsForUser(tx, t.user_id);
    });
    return { ok: true };
  });

  app.get('/auth/invite/:token', { config: authRateLimit }, async (req) => {
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.params);
    const t = await consumeToken(token, 'invite');
    return { name: t.name, email: t.email, org_name: t.org_name };
  });

  app.post('/auth/invite/accept', { config: authRateLimit }, async (req, reply) => {
    const body = z
      .object({ token: z.string().min(10).max(200), password: passwordSchema, name: z.string().trim().min(1).max(100).optional() })
      .parse(req.body);
    const t = await consumeToken(body.token, 'invite');
    const sessionToken = await withTx(pool, async (tx) => {
      await tx.query('UPDATE auth_tokens SET used_at = now() WHERE id = $1', [t.id]);
      const user = await one<{ id: string; org_id: string }>(
        tx,
        `UPDATE users SET password_hash = $2, name = COALESCE($3, name), updated_at = now() WHERE id = $1 RETURNING id, org_id`,
        [t.user_id, await hashPassword(body.password), body.name ?? null],
      );
      return createSession(tx, user!, { ...requestMeta(req), ttlDays: config.SESSION_TTL_DAYS });
    });
    setSessionCookie(reply, sessionToken, cookieOpts);
    return mePayload(deps, t.user_id);
  });

  app.get('/auth/sessions', async (req) => {
    const auth = requireAuth(req);
    const rows = await many<{ id: string; created_at: Date; last_seen_at: Date; ip: string | null; user_agent: string | null }>(
      pool,
      'SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC',
      [auth.userId],
    );
    return rows.map((r) => ({ ...r, id: r.id.slice(0, 12), current: r.id === auth.sessionId }));
  });

  app.post('/auth/sign-out-everywhere', async (req) => {
    const auth = requireAuth(req);
    await destroySessionsForUser(pool, auth.userId, auth.sessionId);
    return { ok: true };
  });
}
