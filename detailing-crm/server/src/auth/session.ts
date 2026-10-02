import type {} from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/pool.js';
import { one } from '../db/pool.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { randomToken, sha256 } from '../lib/crypto.js';

export type Role = 'owner' | 'admin' | 'employee';

export interface AuthContext {
  sessionId: string;
  userId: string;
  orgId: string;
  role: Role;
  name: string;
  email: string;
}

export const SESSION_COOKIE = 'sid';

export async function createSession(
  db: Db,
  user: { id: string; org_id: string },
  meta: { ip?: string; userAgent?: string; ttlDays: number },
): Promise<string> {
  const token = randomToken();
  await db.query(
    `INSERT INTO sessions (id, user_id, org_id, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, now() + make_interval(days => $4), $5, $6)`,
    [sha256(token), user.id, user.org_id, meta.ttlDays, meta.ip ?? null, (meta.userAgent ?? '').slice(0, 300) || null],
  );
  return token;
}

/** Looks up a session by its raw cookie token; extends it (sliding expiry) at most once an hour. */
export async function resolveSession(db: Db, token: string, ttlDays: number): Promise<AuthContext | null> {
  if (!token || token.length > 100) return null;
  const id = sha256(token);
  const row = await one<{
    user_id: string;
    org_id: string;
    role: Role;
    name: string;
    email: string;
    stale: boolean;
  }>(
    db,
    `SELECT s.user_id, s.org_id, u.role, u.name, u.email, s.last_seen_at < now() - interval '1 hour' AS stale
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now() AND u.active`,
    [id],
  );
  if (!row) return null;
  if (row.stale) {
    await db.query(
      `UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(days => $2) WHERE id = $1`,
      [id, ttlDays],
    );
  }
  return { sessionId: id, userId: row.user_id, orgId: row.org_id, role: row.role, name: row.name, email: row.email };
}

export async function destroySessionsForUser(db: Db, userId: string, exceptSessionId?: string): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE user_id = $1 AND id IS DISTINCT FROM $2`, [
    userId,
    exceptSessionId ?? null,
  ]);
}

export function setSessionCookie(reply: FastifyReply, token: string, opts: { secure: boolean; ttlDays: number }): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: opts.ttlDays * 24 * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function isAdmin(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'admin';
}

export function requireAdmin(req: FastifyRequest): AuthContext {
  const auth = requireAuth(req);
  if (!isAdmin(auth)) throw forbidden('Only admins can do that');
  return auth;
}
