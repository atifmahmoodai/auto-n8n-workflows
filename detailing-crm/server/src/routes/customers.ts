import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAdmin } from '../auth/session.js';
import { many, one, withTx, type Db } from '../db/pool.js';
import { logActivity } from '../lib/activity.js';
import { toCsv } from '../lib/csv.js';
import { conflict, notFound } from '../lib/errors.js';
import { idParam, likePattern, zEmail, zPage, zText } from '../lib/http.js';
import { loadOrg } from '../lib/org.js';
import { normalizePhone } from '../lib/phone.js';

const currentYear = new Date().getFullYear();

const vehicleSchema = z.object({
  make: zText(60),
  model: zText(60),
  year: z.union([z.number().int().min(1900).max(currentYear + 2), z.null()]).optional(),
  plate: zText(20).transform((v) => (v ? v.toUpperCase() : v)),
  vin: zText(17)
    .transform((v) => (v ? v.toUpperCase().replace(/\s+/g, '') : v))
    .refine((v) => !v || /^[A-Z0-9]{5,17}$/.test(v), 'VIN should be letters and digits (up to 17)'),
  color: zText(40),
  notes: zText(1000),
});

const customerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(150),
  email: zEmail,
  phone: zText(40),
  address: zText(300),
  notes: zText(4000),
  sms_opt_in: z.boolean().optional(),
  email_opt_in: z.boolean().optional(),
  marketing_opt_in: z.boolean().optional(),
});

/** Search predicate shared by the list and the booking-form lookup. $2 = text pattern, $3 = digits, $4 = compact plate. */
const SEARCH_SQL = `(
  c.name ILIKE $2 ESCAPE '\\' OR c.email ILIKE $2 ESCAPE '\\' OR c.address ILIKE $2 ESCAPE '\\'
  OR ($3 <> '' AND regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') LIKE '%' || $3 || '%')
  OR EXISTS (SELECT 1 FROM vehicles v WHERE v.org_id = c.org_id AND v.customer_id = c.id AND (
       ($4 <> '' AND replace(upper(COALESCE(v.plate, '')), ' ', '') LIKE '%' || $4 || '%')
       OR v.vin ILIKE $2 ESCAPE '\\' OR v.make ILIKE $2 ESCAPE '\\' OR v.model ILIKE $2 ESCAPE '\\'))
)`;

function searchParams(q: string) {
  const digits = q.replace(/\D/g, '').replace(/^0+/, '');
  return [likePattern(q), digits.length >= 4 ? digits : '', q.toUpperCase().replace(/[^A-Z0-9]/g, '')];
}

async function findDuplicate(db: Db, orgId: string, phone: string | null, email: string | null, excludeId?: string) {
  if (!phone && !email) return undefined;
  return one<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM customers
      WHERE org_id = $1 AND archived_at IS NULL AND id IS DISTINCT FROM $4
        AND ((phone IS NOT NULL AND phone = $2) OR (email IS NOT NULL AND email = $3))
      LIMIT 1`,
    [orgId, phone, email, excludeId ?? null],
  );
}

export function registerCustomerRoutes(app: FastifyInstance, deps: AppDeps) {
  const { pool } = deps;

  app.get('/customers', async (req) => {
    const auth = requireAdmin(req);
    const qs = zPage
      .extend({
        q: z.string().trim().max(100).default(''),
        status: z.enum(['active', 'archived', 'all']).default('active'),
        sort: z.enum(['name', 'recent', 'value', 'last_visit']).default('name'),
      })
      .parse(req.query);
    const order = {
      name: 'lower(c.name), c.id',
      recent: 'c.created_at DESC, c.id',
      value: 'lifetime_cents DESC, lower(c.name)',
      last_visit: 'last_visit DESC NULLS LAST, lower(c.name)',
    }[qs.sort];
    const status = { active: 'c.archived_at IS NULL', archived: 'c.archived_at IS NOT NULL', all: 'TRUE' }[qs.status];
    const rows = await many<Record<string, unknown> & { total: number }>(
      pool,
      `SELECT c.id, c.name, c.email, c.phone, c.archived_at, c.created_at,
              COALESCE(st.visits, 0)::int AS visits, st.last_visit, COALESCE(inv.billed, 0)::int AS lifetime_cents,
              (SELECT string_agg(NULLIF(concat_ws(' ', v.make, v.model, v.plate), ''), ', ' ORDER BY v.created_at)
                 FROM vehicles v WHERE v.org_id = c.org_id AND v.customer_id = c.id) AS vehicles,
              count(*) OVER ()::int AS total
         FROM customers c
         LEFT JOIN LATERAL (SELECT count(*) AS visits, max(a.start_at) AS last_visit FROM appointments a
                             WHERE a.org_id = c.org_id AND a.customer_id = c.id AND a.status = 'completed') st ON true
         LEFT JOIN LATERAL (SELECT sum(i.total_cents) AS billed FROM invoices i
                             WHERE i.org_id = c.org_id AND i.customer_id = c.id AND i.status <> 'void') inv ON true
        WHERE c.org_id = $1 AND ${status} AND ($5 = '' OR ${SEARCH_SQL})
        ORDER BY ${order}
        LIMIT $6 OFFSET $7`,
      [auth.orgId, ...searchParams(qs.q), qs.q, qs.page_size, (qs.page - 1) * qs.page_size],
    );
    return {
      items: rows.map(({ total: _t, ...r }) => r),
      total: rows[0]?.total ?? 0,
      page: qs.page,
      page_size: qs.page_size,
    };
  });

  /** Fast typeahead for the booking form: returns customers with their vehicles. */
  app.get('/customers/lookup', async (req) => {
    const auth = requireAdmin(req);
    const { q } = z.object({ q: z.string().trim().max(100).default('') }).parse(req.query);
    return many(
      pool,
      `SELECT c.id, c.name, c.phone, c.email, c.address,
              COALESCE((SELECT json_agg(json_build_object('id', v.id, 'make', v.make, 'model', v.model, 'year', v.year, 'plate', v.plate)
                                  ORDER BY v.created_at)
                          FROM vehicles v WHERE v.org_id = c.org_id AND v.customer_id = c.id), '[]'::json) AS vehicles
         FROM customers c
        WHERE c.org_id = $1 AND c.archived_at IS NULL AND ($5 = '' OR ${SEARCH_SQL})
        ORDER BY CASE WHEN c.name ILIKE $6 ESCAPE '\\' THEN 0 ELSE 1 END, lower(c.name)
        LIMIT 20`,
      [auth.orgId, ...searchParams(q), q, `${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`],
    );
  });

  app.get('/customers/export.csv', async (req, reply) => {
    const auth = requireAdmin(req);
    const rows = await many<Record<string, string | number | null>>(
      pool,
      `SELECT c.name, c.email, c.phone, c.address, c.notes, c.sms_opt_in, c.email_opt_in, c.marketing_opt_in,
              to_char(c.created_at, 'YYYY-MM-DD') AS created, CASE WHEN c.archived_at IS NULL THEN 'no' ELSE 'yes' END AS archived,
              (SELECT string_agg(concat_ws(' ', v.year::text, v.make, v.model, v.plate), '; ') FROM vehicles v WHERE v.customer_id = c.id) AS vehicles,
              (SELECT count(*) FROM appointments a WHERE a.customer_id = c.id AND a.status = 'completed')::int AS completed_jobs,
              (SELECT COALESCE(sum(total_cents), 0) FROM invoices i WHERE i.customer_id = c.id AND i.status <> 'void')::int AS billed_cents
         FROM customers c WHERE c.org_id = $1 ORDER BY lower(c.name)`,
      [auth.orgId],
    );
    const csv = toCsv(
      ['Name', 'Email', 'Phone', 'Address', 'Notes', 'SMS opt-in', 'Email opt-in', 'Marketing opt-in', 'Created', 'Archived', 'Vehicles', 'Completed jobs', 'Billed'],
      rows.map((r) => [
        r.name, r.email, r.phone, r.address, r.notes, r.sms_opt_in ? 'yes' : 'no', r.email_opt_in ? 'yes' : 'no', r.marketing_opt_in ? 'yes' : 'no',
        r.created, r.archived, r.vehicles, r.completed_jobs, ((Number(r.billed_cents) || 0) / 100).toFixed(2),
      ]),
    );
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(csv);
  });

  app.post('/customers', async (req, reply) => {
    const auth = requireAdmin(req);
    const org = await loadOrg(pool, auth.orgId);
    const body = customerSchema
      .extend({ vehicles: z.array(vehicleSchema).max(10).default([]), allow_duplicate: z.boolean().default(false) })
      .parse(req.body);
    const phone = normalizePhone(body.phone, org.country);
    const email = body.email ?? null;
    if (!body.allow_duplicate) {
      const dup = await findDuplicate(pool, auth.orgId, phone, email);
      if (dup) throw conflict('duplicate_customer', `${dup.name} already has this phone number or email.`, { existing: dup });
    }
    const id = await withTx(pool, async (tx) => {
      const row = await one<{ id: string }>(
        tx,
        `INSERT INTO customers (org_id, name, email, phone, address, notes, sms_opt_in, email_opt_in, marketing_opt_in)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [auth.orgId, body.name, email, phone, body.address ?? null, body.notes ?? null, body.sms_opt_in ?? true, body.email_opt_in ?? true, body.marketing_opt_in ?? true],
      );
      for (const v of body.vehicles) {
        if (!v.make && !v.model && !v.plate && !v.vin) continue;
        await tx.query(
          `INSERT INTO vehicles (org_id, customer_id, make, model, year, plate, vin, color, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [auth.orgId, row!.id, v.make ?? null, v.model ?? null, v.year ?? null, v.plate ?? null, v.vin ?? null, v.color ?? null, v.notes ?? null],
        );
      }
      await logActivity(tx, { orgId: auth.orgId, userId: auth.userId, entityType: 'customer', entityId: row!.id, action: 'created' });
      return row!.id;
    });
    return reply.code(201).send(await one(pool, 'SELECT * FROM customers WHERE id = $1', [id]));
  });

  app.get('/customers/:id', async (req) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Customer');
    const customer = await one(pool, 'SELECT * FROM customers WHERE org_id = $1 AND id = $2', [auth.orgId, id]);
    if (!customer) throw notFound('Customer');
    const [vehicles, appointments, invoices, photos, stats] = await Promise.all([
      many(pool, 'SELECT * FROM vehicles WHERE org_id = $1 AND customer_id = $2 ORDER BY created_at', [auth.orgId, id]),
      many(
        pool,
        `SELECT a.id, a.start_at, a.end_at, a.status, a.series_id,
                (SELECT string_agg(i.name, ' + ' ORDER BY i.position) FROM appointment_items i WHERE i.appointment_id = a.id) AS services,
                GREATEST(0, (SELECT COALESCE(SUM(i.quantity * i.unit_price_cents), 0) FROM appointment_items i WHERE i.appointment_id = a.id) - a.discount_cents)::int AS value_cents,
                NULLIF(concat_ws(' ', v.make, v.model, v.plate), '') AS vehicle,
                (SELECT string_agg(u.name, ', ' ORDER BY u.name) FROM appointment_technicians t JOIN users u ON u.id = t.user_id WHERE t.appointment_id = a.id) AS technicians
           FROM appointments a LEFT JOIN vehicles v ON v.org_id = a.org_id AND v.id = a.vehicle_id
          WHERE a.org_id = $1 AND a.customer_id = $2 ORDER BY a.start_at DESC LIMIT 200`,
        [auth.orgId, id],
      ),
      many(
        pool,
        `SELECT id, number, status, issue_date, due_date, total_cents, paid_cents, appointment_id FROM invoices
          WHERE org_id = $1 AND customer_id = $2 ORDER BY issue_date DESC, number DESC`,
        [auth.orgId, id],
      ),
      many(
        pool,
        `SELECT p.id, p.kind, p.appointment_id, p.created_at, a.start_at FROM photos p JOIN appointments a ON a.id = p.appointment_id
          WHERE p.org_id = $1 AND a.customer_id = $2 ORDER BY a.start_at DESC, CASE p.kind WHEN 'before' THEN 0 ELSE 1 END, p.created_at LIMIT 120`,
        [auth.orgId, id],
      ),
      one(
        pool,
        `SELECT (SELECT count(*) FROM appointments WHERE org_id = $1 AND customer_id = $2 AND status = 'completed')::int AS visits,
                (SELECT COALESCE(sum(total_cents), 0) FROM invoices WHERE org_id = $1 AND customer_id = $2 AND status <> 'void')::int AS lifetime_cents,
                (SELECT COALESCE(sum(total_cents - paid_cents), 0) FROM invoices WHERE org_id = $1 AND customer_id = $2 AND status = 'open')::int AS outstanding_cents,
                (SELECT max(start_at) FROM appointments WHERE org_id = $1 AND customer_id = $2 AND status = 'completed') AS last_visit,
                (SELECT min(start_at) FROM appointments WHERE org_id = $1 AND customer_id = $2 AND status IN ('pending', 'confirmed') AND start_at > now()) AS next_visit`,
        [auth.orgId, id],
      ),
    ]);
    return { ...customer, vehicles, appointments, invoices, photos, stats };
  });

  app.patch('/customers/:id', async (req) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Customer');
    const org = await loadOrg(pool, auth.orgId);
    const body = customerSchema.partial().extend({ allow_duplicate: z.boolean().default(false) }).parse(req.body);
    const cur = await one<{ phone: string | null; email: string | null }>(pool, 'SELECT phone, email FROM customers WHERE org_id = $1 AND id = $2', [auth.orgId, id]);
    if (!cur) throw notFound('Customer');
    const phone = body.phone === undefined ? cur.phone : normalizePhone(body.phone, org.country);
    const email = body.email === undefined ? cur.email : body.email;
    if (!body.allow_duplicate && (phone !== cur.phone || email !== cur.email)) {
      const dup = await findDuplicate(pool, auth.orgId, phone !== cur.phone ? phone : null, email !== cur.email ? email : null, id);
      if (dup) throw conflict('duplicate_customer', `${dup.name} already has this phone number or email.`, { existing: dup });
    }
    await pool.query(
      `UPDATE customers SET name = COALESCE($3, name), email = $4, phone = $5,
              address = CASE WHEN $6 THEN $7 ELSE address END, notes = CASE WHEN $8 THEN $9 ELSE notes END,
              sms_opt_in = COALESCE($10, sms_opt_in), email_opt_in = COALESCE($11, email_opt_in),
              marketing_opt_in = COALESCE($12, marketing_opt_in), updated_at = now()
        WHERE org_id = $1 AND id = $2`,
      [
        auth.orgId, id, body.name ?? null, email, phone,
        body.address !== undefined, body.address ?? null, body.notes !== undefined, body.notes ?? null,
        body.sms_opt_in ?? null, body.email_opt_in ?? null, body.marketing_opt_in ?? null,
      ],
    );
    await logActivity(pool, { orgId: auth.orgId, userId: auth.userId, entityType: 'customer', entityId: id, action: 'updated', details: { fields: Object.keys(body) } });
    return one(pool, 'SELECT * FROM customers WHERE id = $1', [id]);
  });

  app.post('/customers/:id/archive', async (req) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Customer');
    const res = await withTx(pool, async (tx) => {
      const r = await tx.query('UPDATE customers SET archived_at = COALESCE(archived_at, now()), updated_at = now() WHERE org_id = $1 AND id = $2', [auth.orgId, id]);
      if (!r.rowCount) throw notFound('Customer');
      // Stop recurring bookings from generating new visits.
      await tx.query('UPDATE appointment_series SET active = false, updated_at = now() WHERE org_id = $1 AND customer_id = $2', [auth.orgId, id]);
      const upcoming = await one<{ n: number }>(
        tx,
        `SELECT count(*)::int AS n FROM appointments WHERE org_id = $1 AND customer_id = $2 AND status IN ('pending', 'confirmed') AND start_at > now()`,
        [auth.orgId, id],
      );
      await logActivity(tx, { orgId: auth.orgId, userId: auth.userId, entityType: 'customer', entityId: id, action: 'archived' });
      return upcoming?.n ?? 0;
    });
    return { ok: true, warnings: res ? [`This customer still has ${res} upcoming booking(s). Cancel them if they are no longer needed.`] : [] };
  });

  app.post('/customers/:id/unarchive', async (req) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Customer');
    const r = await pool.query('UPDATE customers SET archived_at = NULL, updated_at = now() WHERE org_id = $1 AND id = $2', [auth.orgId, id]);
    if (!r.rowCount) throw notFound('Customer');
    await logActivity(pool, { orgId: auth.orgId, userId: auth.userId, entityType: 'customer', entityId: id, action: 'restored' });
    return { ok: true };
  });

  /** Permanent erasure (e.g. a GDPR request). Customers with invoices must be kept (archive instead). */
  app.delete('/customers/:id', async (req) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Customer');
    const keys = await withTx(pool, async (tx) => {
      const c = await one(tx, 'SELECT 1 FROM customers WHERE org_id = $1 AND id = $2 FOR UPDATE', [auth.orgId, id]);
      if (!c) throw notFound('Customer');
      const inv = await one(tx, 'SELECT 1 FROM invoices WHERE org_id = $1 AND customer_id = $2 LIMIT 1', [auth.orgId, id]);
      if (inv) {
        throw conflict('has_invoices', "This customer has invoices, which must be kept for your financial records. Archive the customer instead.");
      }
      const photos = await many<{ storage_key: string; thumb_key: string }>(
        tx,
        `SELECT p.storage_key, p.thumb_key FROM photos p JOIN appointments a ON a.id = p.appointment_id WHERE a.org_id = $1 AND a.customer_id = $2`,
        [auth.orgId, id],
      );
      await tx.query('DELETE FROM customers WHERE org_id = $1 AND id = $2', [auth.orgId, id]);
      await logActivity(tx, { orgId: auth.orgId, userId: auth.userId, entityType: 'customer', entityId: id, action: 'deleted' });
      return photos.flatMap((p) => [p.storage_key, p.thumb_key]);
    });
    await Promise.all(keys.map((k) => deps.storage.remove(k).catch((err) => req.log.warn({ err, key: k }, 'photo file cleanup failed'))));
    return { ok: true };
  });

  // ---- vehicles ----
  app.post('/customers/:id/vehicles', async (req, reply) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Customer');
    const v = vehicleSchema.parse(req.body);
    const exists = await one(pool, 'SELECT 1 FROM customers WHERE org_id = $1 AND id = $2', [auth.orgId, id]);
    if (!exists) throw notFound('Customer');
    const row = await one(
      pool,
      `INSERT INTO vehicles (org_id, customer_id, make, model, year, plate, vin, color, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [auth.orgId, id, v.make ?? null, v.model ?? null, v.year ?? null, v.plate ?? null, v.vin ?? null, v.color ?? null, v.notes ?? null],
    );
    return reply.code(201).send(row);
  });

  app.patch('/vehicles/:id', async (req) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Vehicle');
    const v = vehicleSchema.partial().parse(req.body);
    const sets: string[] = [];
    const params: unknown[] = [auth.orgId, id];
    for (const key of ['make', 'model', 'year', 'plate', 'vin', 'color', 'notes'] as const) {
      if (v[key] !== undefined) {
        params.push(v[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    if (!sets.length) {
      const cur = await one(pool, 'SELECT * FROM vehicles WHERE org_id = $1 AND id = $2', [auth.orgId, id]);
      if (!cur) throw notFound('Vehicle');
      return cur;
    }
    const row = await one(pool, `UPDATE vehicles SET ${sets.join(', ')} WHERE org_id = $1 AND id = $2 RETURNING *`, params);
    if (!row) throw notFound('Vehicle');
    return row;
  });

  app.delete('/vehicles/:id', async (req) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Vehicle');
    const r = await pool.query('DELETE FROM vehicles WHERE org_id = $1 AND id = $2', [auth.orgId, id]);
    if (!r.rowCount) throw notFound('Vehicle');
    return { ok: true };
  });
}
