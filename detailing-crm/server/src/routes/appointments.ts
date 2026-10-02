import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import {
  STATUSES,
  createAppointment,
  createSchema,
  deleteAppointment,
  getAppointmentDetail,
  listAppointments,
  setStatus,
  updateAppointment,
  updateSchema,
  type Ctx,
} from '../appointments/service.js';
import { isAdmin, requireAdmin, requireAuth } from '../auth/session.js';
import { one } from '../db/pool.js';
import { logActivity } from '../lib/activity.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { idParam, zId } from '../lib/http.js';
import { processPhoto } from '../lib/images.js';
import { loadOrg } from '../lib/org.js';
import { parseInstant } from '../lib/time.js';
import { enqueueAppointmentMessage } from '../notifications/messages.js';

const MAX_PHOTOS_PER_JOB = 60;
const MAX_RANGE_DAYS = 120;

export function registerAppointmentRoutes(app: FastifyInstance, deps: AppDeps) {
  const { pool, config, storage } = deps;
  const env = { publicUrl: config.PUBLIC_URL, secret: config.APP_SECRET };

  async function ctxFor(req: FastifyRequest): Promise<Ctx> {
    const auth = requireAuth(req);
    return { auth, org: await loadOrg(pool, auth.orgId), env };
  }

  /** Employees may only touch jobs they are assigned to. Reported as 404 so ids can't be probed. */
  async function assertCanAccess(req: FastifyRequest, appointmentId: string) {
    const auth = requireAuth(req);
    const row = await one<{ assigned: boolean }>(
      pool,
      `SELECT EXISTS (SELECT 1 FROM appointment_technicians t WHERE t.appointment_id = a.id AND t.user_id = $3) AS assigned
         FROM appointments a WHERE a.org_id = $1 AND a.id = $2`,
      [auth.orgId, appointmentId, auth.userId],
    );
    if (!row || (!isAdmin(auth) && !row.assigned)) throw notFound('Appointment');
    return auth;
  }

  app.get('/appointments', async (req) => {
    const auth = requireAuth(req);
    const q = z
      .object({
        from: z.string(),
        to: z.string(),
        technician_id: zId.optional(),
        customer_id: zId.optional(),
        status: z.enum(STATUSES).optional(),
      })
      .parse(req.query);
    const from = parseInstant(q.from, 'from');
    const to = parseInstant(q.to, 'to');
    if (to <= from) throw badRequest('"to" must be after "from"');
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) throw badRequest(`Ask for at most ${MAX_RANGE_DAYS} days at a time`);
    return listAppointments(pool, auth.orgId, {
      from,
      to,
      technicianId: q.technician_id,
      customerId: q.customer_id,
      status: q.status,
      onlyForUser: isAdmin(auth) ? undefined : auth.userId,
    });
  });

  app.get('/appointments/:id', async (req) => {
    const ctx = await ctxFor(req);
    return getAppointmentDetail(pool, ctx.org, idParam(req, 'id', 'Appointment'), ctx.auth);
  });

  app.post('/appointments', async (req, reply) => {
    requireAdmin(req);
    const ctx = await ctxFor(req);
    const result = await createAppointment(pool, ctx, createSchema.parse(req.body));
    return reply.code(201).send({ ...result, appointment: await getAppointmentDetail(pool, ctx.org, result.id, ctx.auth) });
  });

  app.patch('/appointments/:id', async (req) => {
    requireAdmin(req);
    const ctx = await ctxFor(req);
    const id = idParam(req, 'id', 'Appointment');
    const result = await updateAppointment(pool, ctx, id, updateSchema.parse(req.body));
    return { ...result, appointment: await getAppointmentDetail(pool, ctx.org, id, ctx.auth) };
  });

  app.post('/appointments/:id/status', async (req) => {
    const ctx = await ctxFor(req);
    const id = idParam(req, 'id', 'Appointment');
    const body = z.object({ status: z.enum(STATUSES), notify: z.boolean().default(false) }).parse(req.body);
    const result = await setStatus(pool, ctx, id, body.status, body.notify);
    return { ...result, appointment: await getAppointmentDetail(pool, ctx.org, id, ctx.auth) };
  });

  app.delete('/appointments/:id', async (req) => {
    requireAdmin(req);
    const ctx = await ctxFor(req);
    const id = idParam(req, 'id', 'Appointment');
    const { scope } = z.object({ scope: z.enum(['this', 'future']).default('this') }).parse(req.query);
    const result = await deleteAppointment(pool, ctx, id, scope);
    await Promise.all(result.storageKeys.map((k) => storage.remove(k).catch((err) => req.log.warn({ err, key: k }, 'photo cleanup failed'))));
    return { deleted: result.deleted };
  });

  /** Manual send/resend from the job screen. */
  app.post('/appointments/:id/messages', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    requireAdmin(req);
    const ctx = await ctxFor(req);
    const id = idParam(req, 'id', 'Appointment');
    const { kind } = z.object({ kind: z.enum(['confirmation', 'reminder', 'rescheduled', 'canceled', 'followup']) }).parse(req.body);
    const exists = await one(pool, 'SELECT 1 FROM appointments WHERE org_id = $1 AND id = $2', [ctx.org.id, id]);
    if (!exists) throw notFound('Appointment');
    const queued = await enqueueAppointmentMessage(pool, ctx.org, env, id, kind, { automatic: false });
    if (!queued) {
      throw badRequest(
        kind === 'followup'
          ? 'Nothing was sent: the customer has no phone/email we may use, or has opted out of offers.'
          : 'Nothing was sent: the customer has no phone/email we may use, or has opted out.',
      );
    }
    return { queued };
  });

  // ---- photos ----
  app.post('/appointments/:id/photos', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const id = idParam(req, 'id', 'Appointment');
    const auth = await assertCanAccess(req, id);
    if (!req.isMultipart()) throw badRequest('Upload photos as multipart/form-data');
    let kind: string | null = null;
    const buffers: Buffer[] = [];
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'kind') kind = String(part.value);
      } else {
        buffers.push(await part.toBuffer());
      }
    }
    if (kind !== 'before' && kind !== 'after') throw badRequest('Choose whether these are "before" or "after" photos');
    if (!buffers.length) throw badRequest('No photo was uploaded');
    const count = await one<{ n: number }>(pool, 'SELECT count(*)::int AS n FROM photos WHERE appointment_id = $1', [id]);
    if ((count?.n ?? 0) + buffers.length > MAX_PHOTOS_PER_JOB) throw badRequest(`A job can have at most ${MAX_PHOTOS_PER_JOB} photos`);

    const created = [];
    for (const buf of buffers) {
      const img = await processPhoto(buf);
      const photoId = crypto.randomUUID();
      const key = `${auth.orgId}/${id}/${photoId}.jpg`;
      const thumbKey = `${auth.orgId}/${id}/${photoId}_thumb.jpg`;
      await storage.put(key, img.full);
      await storage.put(thumbKey, img.thumb);
      try {
        const row = await one(
          pool,
          `INSERT INTO photos (id, org_id, appointment_id, kind, storage_key, thumb_key, width, height, bytes, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, kind, width, height, created_at`,
          [photoId, auth.orgId, id, kind, key, thumbKey, img.width, img.height, img.full.length, auth.userId],
        );
        created.push(row);
      } catch (err) {
        await Promise.all([storage.remove(key), storage.remove(thumbKey)]);
        throw err;
      }
    }
    await logActivity(pool, { orgId: auth.orgId, userId: auth.userId, entityType: 'appointment', entityId: id, action: 'photos_added', details: { kind, count: created.length } });
    return reply.code(201).send(created);
  });

  app.get('/photos/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id', 'Photo');
    const { size } = z.object({ size: z.enum(['thumb', 'full']).default('full') }).parse(req.query);
    const p = await one<{ storage_key: string; thumb_key: string; appointment_id: string }>(
      pool,
      'SELECT storage_key, thumb_key, appointment_id FROM photos WHERE org_id = $1 AND id = $2',
      [auth.orgId, id],
    );
    if (!p) throw notFound('Photo');
    if (!isAdmin(auth)) await assertCanAccess(req, p.appointment_id);
    const key = size === 'thumb' ? p.thumb_key : p.storage_key;
    if (!(await storage.exists(key))) throw notFound('Photo file');
    return reply
      .header('Cache-Control', 'private, max-age=86400, immutable')
      .header('Content-Disposition', `inline; filename="${id}.jpg"`)
      .type('image/jpeg')
      .send(storage.createReadStream(key));
  });

  app.delete('/photos/:id', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id', 'Photo');
    const p = await one<{ storage_key: string; thumb_key: string; uploaded_by: string | null; appointment_id: string }>(
      pool,
      'SELECT storage_key, thumb_key, uploaded_by, appointment_id FROM photos WHERE org_id = $1 AND id = $2',
      [auth.orgId, id],
    );
    if (!p) throw notFound('Photo');
    if (!isAdmin(auth) && p.uploaded_by !== auth.userId) throw forbidden('You can only delete photos you uploaded');
    await pool.query('DELETE FROM photos WHERE org_id = $1 AND id = $2', [auth.orgId, id]);
    await Promise.all([storage.remove(p.storage_key), storage.remove(p.thumb_key)]).catch((err) => req.log.warn({ err }, 'photo cleanup failed'));
    await logActivity(pool, { orgId: auth.orgId, userId: auth.userId, entityType: 'appointment', entityId: p.appointment_id, action: 'photo_deleted' });
    return { ok: true };
  });
}
