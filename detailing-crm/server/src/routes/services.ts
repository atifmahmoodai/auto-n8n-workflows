import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAdmin, requireAuth } from '../auth/session.js';
import { many, one } from '../db/pool.js';
import { logActivity } from '../lib/activity.js';
import { notFound } from '../lib/errors.js';
import { idParam, zText } from '../lib/http.js';

const serviceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: zText(500),
  price_cents: z.number().int().min(0).max(10_000_000),
  duration_min: z.number().int().min(5).max(1440),
  active: z.boolean().default(true),
});

export function registerServiceRoutes(app: FastifyInstance, deps: AppDeps) {
  const { pool } = deps;

  app.get('/services', async (req) => {
    const auth = requireAuth(req);
    return many(
      pool,
      `SELECT s.*, (SELECT count(*) FROM appointment_items i WHERE i.service_id = s.id)::int AS times_booked
         FROM services s WHERE s.org_id = $1 ORDER BY s.active DESC, lower(s.name)`,
      [auth.orgId],
    );
  });

  app.post('/services', async (req, reply) => {
    const auth = requireAdmin(req);
    const b = serviceSchema.parse(req.body);
    const row = await one<{ id: string }>(
      pool,
      `INSERT INTO services (org_id, name, description, price_cents, duration_min, active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [auth.orgId, b.name, b.description ?? null, b.price_cents, b.duration_min, b.active],
    );
    await logActivity(pool, { orgId: auth.orgId, userId: auth.userId, entityType: 'service', entityId: row!.id, action: 'created' });
    return reply.code(201).send(row);
  });

  app.patch('/services/:id', async (req) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Service');
    const b = serviceSchema.partial().parse(req.body);
    const row = await one(
      pool,
      `UPDATE services SET name = COALESCE($3, name), description = CASE WHEN $4 THEN $5 ELSE description END,
              price_cents = COALESCE($6, price_cents), duration_min = COALESCE($7, duration_min), active = COALESCE($8, active),
              updated_at = now()
        WHERE org_id = $1 AND id = $2 RETURNING *`,
      [auth.orgId, id, b.name ?? null, b.description !== undefined, b.description ?? null, b.price_cents ?? null, b.duration_min ?? null, b.active ?? null],
    );
    if (!row) throw notFound('Service');
    return row;
  });

  // Past bookings keep their own copy of name/price, so deleting a service never changes history.
  app.delete('/services/:id', async (req) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Service');
    const r = await pool.query('DELETE FROM services WHERE org_id = $1 AND id = $2', [auth.orgId, id]);
    if (!r.rowCount) throw notFound('Service');
    await logActivity(pool, { orgId: auth.orgId, userId: auth.userId, entityType: 'service', entityId: id, action: 'deleted' });
    return { ok: true };
  });
}
