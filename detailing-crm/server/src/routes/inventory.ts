import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAdmin } from '../auth/session.js';
import { many, one, withTx, type Client } from '../db/pool.js';
import { logActivity } from '../lib/activity.js';
import { badRequest, notFound } from '../lib/errors.js';
import { idParam, zText } from '../lib/http.js';
import { loadOrg } from '../lib/org.js';
import { enqueueLowStockAlert } from '../notifications/messages.js';

const qty = z.number().min(0).max(1_000_000).multipleOf(0.01, 'Use at most 2 decimal places');

const itemSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sku: zText(60),
  unit: z.string().trim().min(1).max(30).default('units'),
  low_threshold: qty.default(0),
  cost_cents: z.number().int().min(0).max(10_000_000).default(0),
  supplier: zText(120),
});

interface ItemRow {
  id: string;
  name: string;
  unit: string;
  quantity: number;
  low_threshold: number;
  low_alerted_at: Date | null;
}

/**
 * Alerts once when an item drops to/below its threshold and re-arms when it is restocked above it,
 * so admins get one message per shortage instead of one per adjustment.
 */
async function syncLowStock(tx: Client, orgId: string, itemId: string): Promise<boolean> {
  const item = await one<ItemRow>(tx, 'SELECT id, name, unit, quantity, low_threshold, low_alerted_at FROM inventory_items WHERE id = $1', [itemId]);
  if (!item) return false;
  const low = item.quantity <= item.low_threshold;
  if (low && !item.low_alerted_at) {
    await tx.query('UPDATE inventory_items SET low_alerted_at = now() WHERE id = $1', [itemId]);
    await enqueueLowStockAlert(tx, await loadOrg(tx, orgId), [item]);
    return true;
  }
  if (!low && item.low_alerted_at) await tx.query('UPDATE inventory_items SET low_alerted_at = NULL WHERE id = $1', [itemId]);
  return false;
}

export function registerInventoryRoutes(app: FastifyInstance, deps: AppDeps) {
  const { pool } = deps;

  app.get('/inventory', async (req) => {
    const auth = requireAdmin(req);
    return many(
      pool,
      `SELECT i.*, (i.quantity <= i.low_threshold) AS is_low,
              (SELECT max(m.created_at) FROM inventory_movements m WHERE m.item_id = i.id AND m.reason = 'restock') AS last_restocked_at
         FROM inventory_items i WHERE i.org_id = $1
        ORDER BY (i.quantity <= i.low_threshold) DESC, lower(i.name)`,
      [auth.orgId],
    );
  });

  app.post('/inventory', async (req, reply) => {
    const auth = requireAdmin(req);
    const body = itemSchema.extend({ quantity: qty.default(0) }).parse(req.body);
    const row = await withTx(pool, async (tx) => {
      const item = await one<{ id: string }>(
        tx,
        `INSERT INTO inventory_items (org_id, name, sku, unit, quantity, low_threshold, cost_cents, supplier)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [auth.orgId, body.name, body.sku ?? null, body.unit, body.quantity, body.low_threshold, body.cost_cents, body.supplier ?? null],
      );
      if (body.quantity > 0) {
        await tx.query(
          `INSERT INTO inventory_movements (org_id, item_id, delta, quantity_after, reason, user_id) VALUES ($1, $2, $3, $3, 'initial', $4)`,
          [auth.orgId, item!.id, body.quantity, auth.userId],
        );
      }
      await syncLowStock(tx, auth.orgId, item!.id);
      await logActivity(tx, { orgId: auth.orgId, userId: auth.userId, entityType: 'inventory', entityId: item!.id, action: 'created' });
      return one(tx, 'SELECT * FROM inventory_items WHERE id = $1', [item!.id]);
    });
    return reply.code(201).send(row);
  });

  /** Item details only. Stock levels change through movements so the history always adds up. */
  app.patch('/inventory/:id', async (req) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Item');
    const body = itemSchema.partial().parse(req.body);
    return withTx(pool, async (tx) => {
      const row = await one(
        tx,
        `UPDATE inventory_items SET name = COALESCE($3, name), sku = CASE WHEN $4 THEN $5 ELSE sku END, unit = COALESCE($6, unit),
                low_threshold = COALESCE($7, low_threshold), cost_cents = COALESCE($8, cost_cents),
                supplier = CASE WHEN $9 THEN $10 ELSE supplier END, updated_at = now()
          WHERE org_id = $1 AND id = $2 RETURNING id`,
        [auth.orgId, id, body.name ?? null, body.sku !== undefined, body.sku ?? null, body.unit ?? null, body.low_threshold ?? null, body.cost_cents ?? null, body.supplier !== undefined, body.supplier ?? null],
      );
      if (!row) throw notFound('Item');
      await syncLowStock(tx, auth.orgId, id);
      return one(tx, 'SELECT *, (quantity <= low_threshold) AS is_low FROM inventory_items WHERE id = $1', [id]);
    });
  });

  app.post('/inventory/:id/movements', async (req, reply) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Item');
    const body = z
      .object({
        delta: z.number().min(-1_000_000).max(1_000_000).multipleOf(0.01).refine((v) => v !== 0, 'Enter a non-zero amount'),
        reason: z.enum(['restock', 'usage', 'adjustment']),
        note: zText(300),
      })
      .parse(req.body);
    if (body.reason === 'restock' && body.delta < 0) throw badRequest('A restock must add stock');
    if (body.reason === 'usage' && body.delta > 0) throw badRequest('Usage must remove stock');
    const result = await withTx(pool, async (tx) => {
      // Row lock: concurrent adjustments are applied one after another, never lost.
      const item = await one<{ quantity: number; unit: string }>(tx, 'SELECT quantity, unit FROM inventory_items WHERE org_id = $1 AND id = $2 FOR UPDATE', [auth.orgId, id]);
      if (!item) throw notFound('Item');
      const after = Math.round((item.quantity + body.delta) * 100) / 100;
      if (after < 0) throw badRequest(`Only ${item.quantity} ${item.unit} in stock`, { fields: { delta: 'More than in stock' } });
      await tx.query('UPDATE inventory_items SET quantity = $2, updated_at = now() WHERE id = $1', [id, after]);
      await tx.query(
        `INSERT INTO inventory_movements (org_id, item_id, delta, quantity_after, reason, note, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [auth.orgId, id, body.delta, after, body.reason, body.note ?? null, auth.userId],
      );
      const alerted = await syncLowStock(tx, auth.orgId, id);
      return { item: await one(tx, 'SELECT *, (quantity <= low_threshold) AS is_low FROM inventory_items WHERE id = $1', [id]), low_stock_alert_sent: alerted };
    });
    return reply.code(201).send(result);
  });

  app.get('/inventory/:id/movements', async (req) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Item');
    return many(
      pool,
      `SELECT m.id, m.delta, m.quantity_after, m.reason, m.note, m.created_at, u.name AS user_name
         FROM inventory_movements m LEFT JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1 AND m.item_id = $2 ORDER BY m.created_at DESC LIMIT 200`,
      [auth.orgId, id],
    );
  });

  app.delete('/inventory/:id', async (req) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Item');
    const r = await pool.query('DELETE FROM inventory_items WHERE org_id = $1 AND id = $2', [auth.orgId, id]);
    if (!r.rowCount) throw notFound('Item');
    await logActivity(pool, { orgId: auth.orgId, userId: auth.userId, entityType: 'inventory', entityId: id, action: 'deleted' });
    return { ok: true };
  });
}
