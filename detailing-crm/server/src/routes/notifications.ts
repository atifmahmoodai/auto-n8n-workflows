import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAdmin } from '../auth/session.js';
import { many } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { idParam, zPage } from '../lib/http.js';
import { SECRET_KINDS } from '../notifications/outbox.js';
import type { Scheduler } from '../jobs/scheduler.js';

export function registerNotificationRoutes(app: FastifyInstance, deps: AppDeps & { scheduler: Scheduler }) {
  const { pool, scheduler } = deps;

  app.get('/notifications', async (req) => {
    const auth = requireAdmin(req);
    const qs = zPage
      .extend({
        status: z.enum(['all', 'queued', 'sent', 'failed', 'skipped']).default('all'),
        appointment_id: z.string().uuid().optional(),
      })
      .parse(req.query);
    const where = ['n.org_id = $1'];
    const params: unknown[] = [auth.orgId];
    if (qs.status === 'sent') where.push(`n.status IN ('sent', 'delivered', 'simulated')`);
    else if (qs.status === 'queued') where.push(`n.status IN ('queued', 'sending')`);
    else if (qs.status !== 'all') {
      params.push(qs.status);
      where.push(`n.status = $${params.length}`);
    }
    if (qs.appointment_id) {
      params.push(qs.appointment_id);
      where.push(`n.appointment_id = $${params.length}`);
    }
    params.push(qs.page_size, (qs.page - 1) * qs.page_size);
    const rows = await many<Record<string, unknown> & { kind: string; total: number }>(
      pool,
      `SELECT n.id, n.kind, n.channel, n.recipient, n.subject, n.body, n.status, n.error, n.attempts, n.created_at, n.sent_at,
              n.next_attempt_at, n.appointment_id, n.customer_id, c.name AS customer_name, count(*) OVER ()::int AS total
         FROM notifications n LEFT JOIN customers c ON c.id = n.customer_id
        WHERE ${where.join(' AND ')}
        ORDER BY n.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      // Login links in invites/password resets are never exposed, even to admins.
      items: rows.map(({ total: _t, ...r }) => (SECRET_KINDS.has(r.kind as never) ? { ...r, body: '[hidden: contains a sign-in link]' } : r)),
      total: rows[0]?.total ?? 0,
      page: qs.page,
      page_size: qs.page_size,
    };
  });

  app.post('/notifications/:id/retry', async (req) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Message');
    const r = await pool.query(
      `UPDATE notifications SET status = 'queued', attempts = 0, next_attempt_at = now(), error = NULL, updated_at = now()
        WHERE org_id = $1 AND id = $2 AND status IN ('failed', 'skipped') AND kind NOT IN ('invite', 'password_reset')`,
      [auth.orgId, id],
    );
    if (!r.rowCount) throw notFound('Failed message');
    return { ok: true };
  });

  /** Runs the scheduler once right now (reminders, follow-ups, queue) instead of waiting for the next tick. */
  app.post('/notifications/run', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    requireAdmin(req);
    return scheduler.runOnce();
  });
}
