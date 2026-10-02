import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { destroySessionsForUser, requireAdmin, requireAuth } from '../auth/session.js';
import { many, one, withTx } from '../db/pool.js';
import { logActivity } from '../lib/activity.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { idParam, zText } from '../lib/http.js';
import { loadOrg } from '../lib/org.js';
import { normalizePhone } from '../lib/phone.js';
import { enqueueStaffEmail } from '../notifications/messages.js';
import { createToken } from './auth.js';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #2563eb');

const USER_COLUMNS = `id, name, email, phone, role, color, active, last_login_at, created_at, (password_hash IS NULL) AS invite_pending`;

export function registerUserRoutes(app: FastifyInstance, deps: AppDeps) {
  const { pool, config } = deps;

  /** Lightweight list for technician pickers and calendar colours (any signed-in user). */
  app.get('/team', async (req) => {
    const auth = requireAuth(req);
    return many(pool, `SELECT id, name, color, role FROM users WHERE org_id = $1 AND active ORDER BY name`, [auth.orgId]);
  });

  app.get('/users', async (req) => {
    const auth = requireAdmin(req);
    return many(pool, `SELECT ${USER_COLUMNS} FROM users WHERE org_id = $1 ORDER BY active DESC, name`, [auth.orgId]);
  });

  async function sendInvite(orgId: string, userId: string, invitedBy: string) {
    return withTx(pool, async (tx) => {
      const user = await one<{ name: string; email: string; password_hash: string | null }>(
        tx,
        'SELECT name, email, password_hash FROM users WHERE org_id = $1 AND id = $2',
        [orgId, userId],
      );
      if (!user) throw notFound('Team member');
      const org = await loadOrg(tx, orgId);
      const purpose = user.password_hash ? 'password_reset' : 'invite';
      const token = await createToken(tx, userId, purpose, purpose === 'invite' ? 24 * 7 : 24);
      const url = `${config.PUBLIC_URL}/${purpose === 'invite' ? 'accept-invite' : 'reset-password'}?token=${token}`;
      await enqueueStaffEmail(tx, org, {
        kind: purpose,
        to: user.email,
        subject: purpose === 'invite' ? `${invitedBy} invited you to ${org.name}` : `Set a new password for ${org.name}`,
        text:
          purpose === 'invite'
            ? `Hi ${user.name},\n\n${invitedBy} has added you to ${org.name}'s booking system. Choose a password to get started. The link works for 7 days.`
            : `Hi ${user.name},\n\n${invitedBy} sent you a link to set a new password. It works for 24 hours.`,
        action: { label: purpose === 'invite' ? 'Accept invitation' : 'Set new password', url },
      });
      return url;
    });
  }

  app.post('/users', async (req, reply) => {
    const auth = requireAdmin(req);
    const org = await loadOrg(pool, auth.orgId);
    const body = z
      .object({
        name: z.string().trim().min(1).max(100),
        email: z.string().trim().toLowerCase().email().max(200),
        role: z.enum(['admin', 'employee']).default('employee'),
        phone: zText(40),
        color: color.default('#2563eb'),
      })
      .parse(req.body);
    const phone = normalizePhone(body.phone, org.country);
    const exists = await one(pool, 'SELECT 1 FROM users WHERE email = $1', [body.email]);
    if (exists) throw conflict('email_taken', 'Someone with that email already has an account');
    const user = await one<{ id: string }>(
      pool,
      `INSERT INTO users (org_id, name, email, role, phone, color) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [auth.orgId, body.name, body.email, body.role, phone, body.color],
    );
    const inviteUrl = await sendInvite(auth.orgId, user!.id, auth.name);
    await logActivity(pool, { orgId: auth.orgId, userId: auth.userId, entityType: 'user', entityId: user!.id, action: 'invited', details: { role: body.role } });
    const created = await one(pool, `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [user!.id]);
    // The link is returned so an admin can share it directly when email is not configured.
    return reply.code(201).send({ user: created, invite_url: inviteUrl });
  });

  app.post('/users/:id/invite', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Team member');
    const target = await one<{ role: string; active: boolean }>(pool, 'SELECT role, active FROM users WHERE org_id = $1 AND id = $2', [auth.orgId, id]);
    if (!target) throw notFound('Team member');
    if (!target.active) throw badRequest('Reactivate this team member first');
    if (target.role === 'owner' && auth.role !== 'owner') throw forbidden("Only the owner can reset the owner's password");
    return { invite_url: await sendInvite(auth.orgId, id, auth.name) };
  });

  app.patch('/users/:id', async (req) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Team member');
    const org = await loadOrg(pool, auth.orgId);
    const body = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        phone: zText(40),
        role: z.enum(['admin', 'employee']).optional(),
        color: color.optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body);
    const target = await one<{ role: string; active: boolean }>(pool, 'SELECT role, active FROM users WHERE org_id = $1 AND id = $2', [auth.orgId, id]);
    if (!target) throw notFound('Team member');
    if (target.role === 'owner') {
      if (auth.userId !== id) throw forbidden('Only the owner can edit the owner account');
      if (body.role !== undefined || body.active === false) throw badRequest("The owner's role can't be changed and the owner can't be deactivated");
    }
    if (id === auth.userId && (body.role === 'employee' || body.active === false)) {
      throw badRequest("You can't demote or deactivate yourself");
    }
    const phone = body.phone === undefined ? undefined : normalizePhone(body.phone, org.country);
    await pool.query(
      `UPDATE users SET name = COALESCE($3, name), phone = CASE WHEN $4 THEN $5 ELSE phone END, role = COALESCE($6, role),
              color = COALESCE($7, color), active = COALESCE($8, active), updated_at = now()
        WHERE org_id = $1 AND id = $2`,
      [auth.orgId, id, body.name ?? null, phone !== undefined, phone ?? null, body.role ?? null, body.color ?? null, body.active ?? null],
    );
    if (body.active === false) await destroySessionsForUser(pool, id);
    await logActivity(pool, { orgId: auth.orgId, userId: auth.userId, entityType: 'user', entityId: id, action: 'updated', details: { fields: Object.keys(body) } });
    const upcoming = body.active === false
      ? await one<{ n: number }>(
          pool,
          `SELECT count(*)::int AS n FROM appointment_technicians t JOIN appointments a ON a.id = t.appointment_id
            WHERE t.user_id = $1 AND a.status IN ('pending', 'confirmed') AND a.start_at > now()`,
          [id],
        )
      : undefined;
    return {
      user: await one(pool, `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]),
      warnings: upcoming?.n ? [`${upcoming.n} upcoming job(s) are still assigned to this person. Reassign them on the calendar.`] : [],
    };
  });

  app.delete('/users/:id', async (req) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Team member');
    const target = await one<{ role: string }>(pool, 'SELECT role FROM users WHERE org_id = $1 AND id = $2', [auth.orgId, id]);
    if (!target) throw notFound('Team member');
    if (target.role === 'owner') throw forbidden("The owner account can't be deleted");
    if (id === auth.userId) throw badRequest("You can't delete your own account");
    await pool.query('DELETE FROM users WHERE org_id = $1 AND id = $2', [auth.orgId, id]);
    await logActivity(pool, { orgId: auth.orgId, userId: auth.userId, entityType: 'user', entityId: id, action: 'deleted' });
    return { ok: true };
  });
}
