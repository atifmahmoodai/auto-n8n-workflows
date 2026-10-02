import { DateTime } from 'luxon';
import { z } from 'zod';
import type { AuthContext } from '../auth/session.js';
import type { Client, Db, Pool } from '../db/pool.js';
import { lockOrgBookings, many, one, withTx } from '../db/pool.js';
import { issueInvoiceForAppointment, voidInvoice } from '../invoices/service.js';
import { logActivity } from '../lib/activity.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { zId, zText } from '../lib/http.js';
import { computeTotals } from '../lib/money.js';
import type { OrgContext } from '../lib/org.js';
import { isIsoDate, occurrenceStart, parseInstant, toLocalString, type Freq } from '../lib/time.js';
import { enqueueAppointmentMessage, type MessageEnv } from '../notifications/messages.js';
import { cancelPending } from '../notifications/outbox.js';

export const STATUSES = ['pending', 'confirmed', 'in_progress', 'completed', 'canceled', 'no_show'] as const;
export type Status = (typeof STATUSES)[number];
/** Statuses that occupy a technician's time. */
const BUSY: readonly Status[] = ['pending', 'confirmed', 'in_progress'];
const UPCOMING: readonly Status[] = ['pending', 'confirmed'];
/** Recurring occurrences are generated this far ahead (rolling). */
export const SERIES_HORIZON_DAYS = 182;

const isoDate = z.string().refine(isIsoDate, 'Use YYYY-MM-DD');

export const itemSchema = z.object({
  service_id: zId.nullish(),
  name: z.string().trim().min(1).max(120).optional(),
  unit_price_cents: z.number().int().min(0).max(10_000_000).optional(),
  quantity: z.number().int().min(1).max(100).default(1),
});

export const recurrenceSchema = z.object({
  freq: z.enum(['weekly', 'monthly']),
  interval: z.number().int().min(1).max(52).default(1),
  ends_after: z.number().int().min(2).max(520).nullish(),
  ends_on: isoDate.nullish(),
});

export const createSchema = z.object({
  customer_id: zId,
  vehicle_id: zId.nullish(),
  start_at: z.string(),
  duration_min: z.number().int().min(5).max(1440).optional(),
  items: z.array(itemSchema).max(30).default([]),
  technician_ids: z.array(zId).max(10).default([]),
  status: z.enum(STATUSES).optional(),
  location: zText(300),
  notes: zText(4000),
  discount_cents: z.number().int().min(0).max(10_000_000).default(0),
  recurrence: recurrenceSchema.nullish(),
  notify: z.boolean().default(true),
  force: z.boolean().default(false),
});

export const updateSchema = z.object({
  version: z.number().int().min(1),
  customer_id: zId.optional(),
  vehicle_id: zId.nullish(),
  start_at: z.string().optional(),
  duration_min: z.number().int().min(5).max(1440).optional(),
  items: z.array(itemSchema).max(30).optional(),
  technician_ids: z.array(zId).max(10).optional(),
  status: z.enum(STATUSES).optional(),
  location: zText(300),
  notes: zText(4000),
  discount_cents: z.number().int().min(0).max(10_000_000).optional(),
  scope: z.enum(['this', 'future']).default('this'),
  notify: z.boolean().default(true),
  force: z.boolean().default(false),
});

export type CreateInput = z.infer<typeof createSchema>;
export type UpdateInput = z.infer<typeof updateSchema>;

export interface Ctx {
  org: OrgContext;
  auth: AuthContext;
  env: MessageEnv;
}

interface ResolvedItem {
  service_id: string | null;
  name: string;
  unit_price_cents: number;
  quantity: number;
  duration_min: number | null;
}

interface SeriesTemplate {
  vehicle_id: string | null;
  items: Array<Omit<ResolvedItem, 'duration_min'>>;
  technician_ids: string[];
  notes: string | null;
  location: string | null;
  discount_cents: number;
  status: 'pending' | 'confirmed';
}

interface SeriesRow {
  id: string;
  org_id: string;
  customer_id: string;
  freq: Freq;
  interval: number;
  anchor_local: string;
  timezone: string;
  duration_min: number;
  ends_after: number | null;
  ends_on: string | null;
  template: SeriesTemplate;
  next_index: number;
  active: boolean;
}

interface AppointmentRow {
  id: string;
  org_id: string;
  customer_id: string;
  vehicle_id: string | null;
  series_id: string | null;
  series_index: number | null;
  start_at: Date;
  end_at: Date;
  status: Status;
  location: string | null;
  notes: string | null;
  discount_cents: number;
  started_at: Date | null;
  completed_at: Date | null;
  canceled_at: Date | null;
  version: number;
}

export interface Conflict {
  id: string;
  start_at: Date;
  end_at: Date;
  technician_name: string;
  customer_name: string;
}

// ---------------------------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------------------------

async function resolveItems(db: Db, orgId: string, items: z.infer<typeof itemSchema>[]): Promise<ResolvedItem[]> {
  const ids = [...new Set(items.map((i) => i.service_id).filter((v): v is string => Boolean(v)))];
  const services = ids.length
    ? await many<{ id: string; name: string; price_cents: number; duration_min: number }>(
        db,
        'SELECT id, name, price_cents, duration_min FROM services WHERE org_id = $1 AND id = ANY($2::uuid[])',
        [orgId, ids],
      )
    : [];
  const byId = new Map(services.map((s) => [s.id, s]));
  return items.map((item) => {
    if (item.service_id) {
      const svc = byId.get(item.service_id);
      if (!svc) throw badRequest('One of the selected services no longer exists');
      return {
        service_id: svc.id,
        name: item.name ?? svc.name,
        unit_price_cents: item.unit_price_cents ?? svc.price_cents,
        quantity: item.quantity,
        duration_min: svc.duration_min,
      };
    }
    if (!item.name || item.unit_price_cents === undefined) throw badRequest('Custom items need a name and a price');
    return {
      service_id: null,
      name: item.name,
      unit_price_cents: item.unit_price_cents,
      quantity: item.quantity,
      duration_min: null,
    };
  });
}

async function assertCustomer(db: Db, orgId: string, customerId: string): Promise<void> {
  const c = await one<{ archived: boolean }>(
    db,
    'SELECT archived_at IS NOT NULL AS archived FROM customers WHERE org_id = $1 AND id = $2',
    [orgId, customerId],
  );
  if (!c) throw badRequest('Customer not found');
  if (c.archived) throw badRequest('This customer is archived. Restore them before booking.');
}

async function assertVehicle(db: Db, orgId: string, customerId: string, vehicleId: string): Promise<void> {
  const v = await one(db, 'SELECT 1 FROM vehicles WHERE org_id = $1 AND id = $2 AND customer_id = $3', [
    orgId,
    vehicleId,
    customerId,
  ]);
  if (!v) throw badRequest("That vehicle doesn't belong to this customer");
}

/** All ids must be team members of this org; newly assigned ones must also be active. */
async function assertTechnicians(db: Db, orgId: string, ids: string[], mustBeActive: string[]): Promise<void> {
  if (!ids.length) return;
  const rows = await many<{ id: string; active: boolean }>(
    db,
    'SELECT id, active FROM users WHERE org_id = $1 AND id = ANY($2::uuid[])',
    [orgId, ids],
  );
  if (rows.length !== new Set(ids).size) throw badRequest('One of the selected technicians was not found');
  const inactive = rows.filter((r) => !r.active && mustBeActive.includes(r.id));
  if (inactive.length) throw badRequest('Deactivated team members cannot be assigned to jobs');
}

export async function findConflicts(
  db: Db,
  orgId: string,
  technicianIds: string[],
  ranges: Array<{ start: Date; end: Date }>,
  excludeIds: string[],
): Promise<Conflict[]> {
  if (!technicianIds.length || !ranges.length) return [];
  return many<Conflict>(
    db,
    `SELECT DISTINCT a.id, a.start_at, a.end_at, u.name AS technician_name, c.name AS customer_name
       FROM appointments a
       JOIN appointment_technicians t ON t.appointment_id = a.id
       JOIN users u ON u.id = t.user_id
       JOIN customers c ON c.org_id = a.org_id AND c.id = a.customer_id
       JOIN unnest($3::timestamptz[], $4::timestamptz[]) AS r(s, e) ON a.start_at < r.e AND a.end_at > r.s
      WHERE a.org_id = $1 AND t.user_id = ANY($2::uuid[]) AND a.status IN ('pending', 'confirmed', 'in_progress')
        AND NOT (a.id = ANY($5::uuid[]))
      ORDER BY a.start_at
      LIMIT 20`,
    [orgId, technicianIds, ranges.map((r) => r.start), ranges.map((r) => r.end), excludeIds],
  );
}

function conflictError(org: OrgContext, conflicts: Conflict[]) {
  const first = conflicts[0]!;
  const when = DateTime.fromJSDate(first.start_at)
    .setZone(org.timezone)
    .setLocale(org.settings.locale)
    .toLocaleString(DateTime.DATETIME_MED);
  const more = conflicts.length > 1 ? ` (and ${conflicts.length - 1} more)` : '';
  return conflict(
    'schedule_conflict',
    `${first.technician_name} is already booked with ${first.customer_name} at ${when}${more}.`,
    {
      conflicts: conflicts.map((c) => ({ ...c, start_at: c.start_at.toISOString(), end_at: c.end_at.toISOString() })),
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

async function insertAppointment(
  tx: Client,
  orgId: string,
  data: {
    customer_id: string;
    vehicle_id: string | null;
    series_id: string | null;
    series_index: number | null;
    start: Date;
    end: Date;
    status: Status;
    location: string | null;
    notes: string | null;
    discount_cents: number;
    created_by: string | null;
  },
  items: Array<Omit<ResolvedItem, 'duration_min'>>,
  technicianIds: string[],
): Promise<string | null> {
  const now = new Date();
  const row = await one<{ id: string }>(
    tx,
    `INSERT INTO appointments (org_id, customer_id, vehicle_id, series_id, series_index, start_at, end_at, status, location,
                               notes, discount_cents, created_by, started_at, completed_at, canceled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (series_id, series_index) WHERE series_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      orgId,
      data.customer_id,
      data.vehicle_id,
      data.series_id,
      data.series_index,
      data.start,
      data.end,
      data.status,
      data.location,
      data.notes,
      data.discount_cents,
      data.created_by,
      data.status === 'in_progress' || data.status === 'completed' ? (data.start < now ? data.start : now) : null,
      data.status === 'completed' ? (data.end < now ? data.end : now) : null,
      data.status === 'canceled' ? now : null,
    ],
  );
  if (!row) return null; // occurrence already generated
  await replaceItems(tx, orgId, row.id, items);
  await replaceTechnicians(tx, orgId, row.id, technicianIds);
  return row.id;
}

async function replaceItems(
  tx: Client,
  orgId: string,
  appointmentId: string,
  items: Array<Omit<ResolvedItem, 'duration_min'>>,
) {
  await tx.query('DELETE FROM appointment_items WHERE appointment_id = $1', [appointmentId]);
  let position = 0;
  for (const i of items) {
    await tx.query(
      `INSERT INTO appointment_items (org_id, appointment_id, service_id, name, unit_price_cents, quantity, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [orgId, appointmentId, i.service_id, i.name, i.unit_price_cents, i.quantity, position++],
    );
  }
}

async function replaceTechnicians(tx: Client, orgId: string, appointmentId: string, ids: string[]) {
  await tx.query('DELETE FROM appointment_technicians WHERE appointment_id = $1', [appointmentId]);
  for (const userId of new Set(ids)) {
    await tx.query('INSERT INTO appointment_technicians (org_id, appointment_id, user_id) VALUES ($1, $2, $3)', [
      orgId,
      appointmentId,
      userId,
    ]);
  }
}

function computeOccurrences(
  s: Pick<SeriesRow, 'freq' | 'interval' | 'anchor_local' | 'timezone' | 'duration_min' | 'ends_after' | 'ends_on'>,
  fromIndex: number,
  horizonEnd: DateTime,
) {
  const out: Array<{ index: number; start: Date; end: Date }> = [];
  for (let i = fromIndex; out.length < 600; i++) {
    if (s.ends_after != null && i >= s.ends_after) break;
    const start = occurrenceStart(s.anchor_local, s.timezone, s.freq, s.interval, i);
    if (s.ends_on && (start.toISODate() ?? '') > s.ends_on) break;
    if (start > horizonEnd) break;
    out.push({ index: i, start: start.toJSDate(), end: start.plus({ minutes: s.duration_min }).toJSDate() });
  }
  return out;
}

function seriesFinished(
  s: Pick<SeriesRow, 'freq' | 'interval' | 'anchor_local' | 'timezone' | 'ends_after' | 'ends_on'>,
  nextIndex: number,
): boolean {
  if (s.ends_after != null && nextIndex >= s.ends_after) return true;
  if (s.ends_on) {
    const next = occurrenceStart(s.anchor_local, s.timezone, s.freq, s.interval, nextIndex);
    if ((next.toISODate() ?? '') > s.ends_on) return true;
  }
  return false;
}

export async function createAppointment(pool: Pool, ctx: Ctx, input: CreateInput) {
  const { org, auth, env } = ctx;
  const start = parseInstant(input.start_at, 'start_at');
  const status: Status = input.status ?? org.settings.booking.default_status;
  if (input.recurrence && !UPCOMING.includes(status))
    throw badRequest('Recurring bookings must start as pending or confirmed');
  if (
    input.recurrence?.ends_on &&
    input.recurrence.ends_on < (DateTime.fromJSDate(start).setZone(org.timezone).toISODate() ?? '')
  ) {
    throw badRequest('The repeat end date is before the first appointment');
  }

  return withTx(pool, async (tx) => {
    await lockOrgBookings(tx, org.id);
    await assertCustomer(tx, org.id, input.customer_id);
    if (input.vehicle_id) await assertVehicle(tx, org.id, input.customer_id, input.vehicle_id);
    await assertTechnicians(tx, org.id, input.technician_ids, input.technician_ids);
    const items = await resolveItems(tx, org.id, input.items);
    const serviceMinutes = items.reduce((sum, i) => sum + (i.duration_min ?? 0) * i.quantity, 0);
    const duration =
      input.duration_min ??
      (serviceMinutes > 0 ? Math.min(serviceMinutes, 1440) : org.settings.booking.default_duration_min);
    const itemRows = items.map(({ duration_min: _d, ...rest }) => rest);

    let occurrences: Array<{ index: number | null; start: Date; end: Date }>;
    let seriesId: string | null = null;
    if (input.recurrence) {
      const anchor = DateTime.fromJSDate(start).setZone(org.timezone);
      const def = {
        freq: input.recurrence.freq,
        interval: input.recurrence.interval,
        anchor_local: toLocalString(anchor),
        timezone: org.timezone,
        duration_min: duration,
        ends_after: input.recurrence.ends_after ?? null,
        ends_on: input.recurrence.ends_on ?? null,
      };
      const horizon = DateTime.max(DateTime.now(), anchor).plus({ days: SERIES_HORIZON_DAYS });
      occurrences = computeOccurrences(def, 0, horizon);
      const template: SeriesTemplate = {
        vehicle_id: input.vehicle_id ?? null,
        items: itemRows,
        technician_ids: input.technician_ids,
        notes: input.notes ?? null,
        location: input.location ?? null,
        discount_cents: input.discount_cents,
        status: status as 'pending' | 'confirmed',
      };
      const nextIndex = occurrences.length;
      const series = await one<{ id: string }>(
        tx,
        `INSERT INTO appointment_series (org_id, customer_id, freq, interval, anchor_local, timezone, duration_min, ends_after, ends_on, template, next_index, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [
          org.id,
          input.customer_id,
          def.freq,
          def.interval,
          def.anchor_local,
          def.timezone,
          duration,
          def.ends_after,
          def.ends_on,
          JSON.stringify(template),
          nextIndex,
          !seriesFinished(def, nextIndex),
        ],
      );
      seriesId = series!.id;
    } else {
      occurrences = [{ index: null, start, end: new Date(start.getTime() + duration * 60_000) }];
    }

    if (!input.force && BUSY.includes(status)) {
      const conflicts = await findConflicts(tx, org.id, input.technician_ids, occurrences, []);
      if (conflicts.length) throw conflictError(org, conflicts);
    }

    const ids: string[] = [];
    for (const occ of occurrences) {
      const id = await insertAppointment(
        tx,
        org.id,
        {
          customer_id: input.customer_id,
          vehicle_id: input.vehicle_id ?? null,
          series_id: seriesId,
          series_index: occ.index,
          start: occ.start,
          end: occ.end,
          status,
          location: input.location ?? null,
          notes: input.notes ?? null,
          discount_cents: input.discount_cents,
          created_by: auth.userId,
        },
        itemRows,
        input.technician_ids,
      );
      if (id) ids.push(id);
    }
    const firstId = ids[0]!;
    let invoice: { id: string; number: string } | null = null;
    if (status === 'completed') invoice = await issueInvoiceForAppointment(tx, org, firstId, auth.userId);

    if (
      input.notify &&
      UPCOMING.includes(status) &&
      start > new Date() &&
      org.settings.notifications.confirmation_enabled
    ) {
      await enqueueAppointmentMessage(tx, org, env, firstId, 'confirmation', { automatic: true });
    }
    await logActivity(tx, {
      orgId: org.id,
      userId: auth.userId,
      entityType: 'appointment',
      entityId: firstId,
      action: 'created',
      details: { status, occurrences: ids.length, series_id: seriesId },
    });
    return { id: firstId, ids, series_id: seriesId, invoice };
  });
}

/** Side effects of a status change: timestamps, invoice issue/void. Returns user-facing warnings. */
async function applyStatusTransition(
  tx: Client,
  org: OrgContext,
  appointmentId: string,
  from: Status,
  to: Status,
  userId: string,
): Promise<string[]> {
  const warnings: string[] = [];
  if (from === to) return warnings;
  await tx.query(
    `UPDATE appointments
        SET started_at = CASE WHEN $2 IN ('in_progress', 'completed') THEN COALESCE(started_at, LEAST(now(), start_at)) ELSE started_at END,
            completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE NULL END,
            canceled_at = CASE WHEN $2 = 'canceled' THEN now() ELSE NULL END
      WHERE id = $1`,
    [appointmentId, to],
  );
  if (to === 'completed') {
    const inv = await issueInvoiceForAppointment(tx, org, appointmentId, userId);
    if (!inv) warnings.push('No invoice was created because the job has no priced items.');
  } else if (from === 'completed') {
    const inv = await one<{ id: string; paid_cents: number; number: string }>(
      tx,
      `SELECT id, paid_cents, number FROM invoices WHERE org_id = $1 AND appointment_id = $2 AND status <> 'void'`,
      [org.id, appointmentId],
    );
    if (inv && inv.paid_cents === 0) await voidInvoice(tx, org.id, inv.id, 'Job reopened', userId);
    else if (inv) warnings.push(`Invoice ${inv.number} has payments recorded, so it was kept.`);
  }
  return warnings;
}

async function lockAppointment(tx: Client, orgId: string, id: string): Promise<AppointmentRow> {
  const row = await one<AppointmentRow>(tx, 'SELECT * FROM appointments WHERE org_id = $1 AND id = $2 FOR UPDATE', [
    orgId,
    id,
  ]);
  if (!row) throw notFound('Appointment');
  return row;
}

async function technicianIdsOf(db: Db, appointmentId: string): Promise<string[]> {
  return (
    await many<{ user_id: string }>(db, 'SELECT user_id FROM appointment_technicians WHERE appointment_id = $1', [
      appointmentId,
    ])
  ).map((r) => r.user_id);
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set([...a, ...b]).size === a.length;

export async function updateAppointment(pool: Pool, ctx: Ctx, id: string, input: UpdateInput) {
  const { org, auth, env } = ctx;
  return withTx(pool, async (tx) => {
    await lockOrgBookings(tx, org.id);
    const cur = await lockAppointment(tx, org.id, id);
    if (input.version !== cur.version) {
      throw conflict('stale', 'This booking was changed by someone else. Reload it to see the latest version.');
    }
    const curTechs = await technicianIdsOf(tx, id);
    const customerId = input.customer_id ?? cur.customer_id;
    const customerChanged = customerId !== cur.customer_id;
    if (customerChanged) await assertCustomer(tx, org.id, customerId);
    const vehicleId = input.vehicle_id !== undefined ? input.vehicle_id : customerChanged ? null : cur.vehicle_id;
    if (vehicleId && (vehicleId !== cur.vehicle_id || customerChanged))
      await assertVehicle(tx, org.id, customerId, vehicleId);

    const start = input.start_at ? parseInstant(input.start_at, 'start_at') : cur.start_at;
    const duration = input.duration_min ?? Math.round((cur.end_at.getTime() - cur.start_at.getTime()) / 60_000);
    const end = new Date(start.getTime() + duration * 60_000);
    const techIds = input.technician_ids ? [...new Set(input.technician_ids)] : curTechs;
    // Only newly added technicians must be active: editing a job of someone who has since been
    // deactivated must keep working.
    await assertTechnicians(
      tx,
      org.id,
      techIds,
      techIds.filter((t) => !curTechs.includes(t)),
    );
    const status = input.status ?? cur.status;
    const timeChanged = start.getTime() !== cur.start_at.getTime() || end.getTime() !== cur.end_at.getTime();
    const techChanged = !sameSet(techIds, curTechs);

    if (!input.force && BUSY.includes(status) && (timeChanged || techChanged || !BUSY.includes(cur.status))) {
      const conflicts = await findConflicts(tx, org.id, techIds, [{ start, end }], [id]);
      if (conflicts.length) throw conflictError(org, conflicts);
    }

    let items: ResolvedItem[] | null = null;
    if (input.items) {
      items = await resolveItems(tx, org.id, input.items);
      await replaceItems(tx, org.id, id, items);
    }
    if (techChanged) await replaceTechnicians(tx, org.id, id, techIds);

    await tx.query(
      `UPDATE appointments
          SET customer_id = $3, vehicle_id = $4, start_at = $5, end_at = $6, status = $7, location = $8, notes = $9,
              discount_cents = $10, rescheduled_at = CASE WHEN $11 THEN now() ELSE rescheduled_at END,
              version = version + 1, updated_at = now()
        WHERE org_id = $1 AND id = $2`,
      [
        org.id,
        id,
        customerId,
        vehicleId,
        start,
        end,
        status,
        input.location !== undefined ? input.location : cur.location,
        input.notes !== undefined ? input.notes : cur.notes,
        input.discount_cents ?? cur.discount_cents,
        timeChanged,
      ],
    );
    const warnings = await applyStatusTransition(tx, org, id, cur.status, status, auth.userId);
    if (cur.status === 'completed' && status === 'completed' && (items || input.discount_cents !== undefined)) {
      const inv = await one<{ number: string }>(
        tx,
        `SELECT number FROM invoices WHERE org_id = $1 AND appointment_id = $2 AND status <> 'void'`,
        [org.id, id],
      );
      if (inv)
        warnings.push(
          `Invoice ${inv.number} was already issued and was not changed. Use "Void & reissue" on the invoice to update it.`,
        );
    }

    // Customer messages
    const future = start > new Date();
    const n = org.settings.notifications;
    if (timeChanged || status === 'canceled' || customerChanged) {
      // Reminders/confirmations planned for the old time or old customer are no longer valid.
      await cancelPending(tx, id, ['reminder', 'confirmation', 'rescheduled']);
    }
    if (input.notify && future) {
      // Re-booking a cancelled/no-show job tells the customer again; reopening a completed job does not.
      const reinstated = (cur.status === 'canceled' || cur.status === 'no_show') && UPCOMING.includes(status);
      if (status === 'canceled' && cur.status !== 'canceled' && n.cancellation_enabled) {
        await enqueueAppointmentMessage(tx, org, env, id, 'canceled', { automatic: true });
      } else if (reinstated && n.confirmation_enabled) {
        await enqueueAppointmentMessage(tx, org, env, id, 'confirmation', { automatic: false });
      } else if ((timeChanged || customerChanged) && UPCOMING.includes(status) && n.reschedule_enabled) {
        await enqueueAppointmentMessage(tx, org, env, id, customerChanged ? 'confirmation' : 'rescheduled', {
          automatic: !customerChanged,
        });
      }
    }

    // "This and following" edits on a recurring booking.
    let affected = 1;
    if (input.scope === 'future' && cur.series_id && cur.series_index !== null) {
      affected += await propagateToFuture(tx, ctx, cur, {
        start,
        duration,
        techIds,
        items,
        vehicleId,
        location: input.location !== undefined ? input.location : cur.location,
        notes: input.notes !== undefined ? input.notes : cur.notes,
        discount: input.discount_cents ?? cur.discount_cents,
        force: input.force,
        techChanged,
        timeChanged,
      });
    }

    await logActivity(tx, {
      orgId: org.id,
      userId: auth.userId,
      entityType: 'appointment',
      entityId: id,
      action: status !== cur.status ? `status:${status}` : 'updated',
      details: {
        fields: Object.keys(input).filter((k) => !['version', 'scope', 'notify', 'force'].includes(k)),
        ...(timeChanged ? { rescheduled: true } : {}),
        ...(affected > 1 ? { occurrences: affected } : {}),
      },
    });
    return { warnings, affected };
  });
}

async function propagateToFuture(
  tx: Client,
  ctx: Ctx,
  cur: AppointmentRow,
  next: {
    start: Date;
    duration: number;
    techIds: string[];
    items: ResolvedItem[] | null;
    vehicleId: string | null;
    location: string | null;
    notes: string | null;
    discount: number;
    force: boolean;
    techChanged: boolean;
    timeChanged: boolean;
  },
): Promise<number> {
  const { org } = ctx;
  const series = await one<SeriesRow>(tx, 'SELECT * FROM appointment_series WHERE org_id = $1 AND id = $2 FOR UPDATE', [
    org.id,
    cur.series_id,
  ]);
  if (!series) return 0;
  const tz = series.timezone;
  const oldLocal = DateTime.fromJSDate(cur.start_at).setZone(tz);
  const newLocal = DateTime.fromJSDate(next.start).setZone(tz);
  const dayShift = Math.round(newLocal.startOf('day').diff(oldLocal.startOf('day'), 'days').days);
  const shift = (dt: DateTime) =>
    dt.plus({ days: dayShift }).set({ hour: newLocal.hour, minute: newLocal.minute, second: 0, millisecond: 0 });

  const later = await many<{ id: string; start_at: Date }>(
    tx,
    `SELECT id, start_at FROM appointments
      WHERE org_id = $1 AND series_id = $2 AND series_index > $3 AND status IN ('pending', 'confirmed')
      ORDER BY series_index FOR UPDATE`,
    [org.id, cur.series_id, cur.series_index],
  );
  const planned = later.map((a) => {
    const start = next.timeChanged ? shift(DateTime.fromJSDate(a.start_at).setZone(tz)).toJSDate() : a.start_at;
    return { id: a.id, start, end: new Date(start.getTime() + next.duration * 60_000) };
  });
  if (!next.force && (next.timeChanged || next.techChanged)) {
    const conflicts = await findConflicts(tx, org.id, next.techIds, planned, [cur.id, ...planned.map((p) => p.id)]);
    if (conflicts.length) throw conflictError(org, conflicts);
  }
  const itemRows = next.items?.map(({ duration_min: _d, ...rest }) => rest) ?? null;
  for (const p of planned) {
    await tx.query(
      `UPDATE appointments SET start_at = $2, end_at = $3, vehicle_id = $4, location = $5, notes = $6, discount_cents = $7,
              version = version + 1, updated_at = now()
        WHERE id = $1`,
      [p.id, p.start, p.end, next.vehicleId, next.location, next.notes, next.discount],
    );
    if (itemRows) await replaceItems(tx, org.id, p.id, itemRows);
    if (next.techChanged) await replaceTechnicians(tx, org.id, p.id, next.techIds);
  }
  const template: SeriesTemplate = {
    ...series.template,
    vehicle_id: next.vehicleId,
    technician_ids: next.techIds,
    notes: next.notes,
    location: next.location,
    discount_cents: next.discount,
    ...(itemRows ? { items: itemRows } : {}),
  };
  const anchor = next.timeChanged
    ? toLocalString(shift(DateTime.fromISO(series.anchor_local.replace(' ', 'T'), { zone: tz })))
    : series.anchor_local;
  await tx.query(
    `UPDATE appointment_series SET template = $2, anchor_local = $3, duration_min = $4, updated_at = now() WHERE id = $1`,
    [series.id, JSON.stringify(template), anchor, next.duration],
  );
  return planned.length;
}

/** Status change used by technicians (and the quick actions in the UI). */
export async function setStatus(pool: Pool, ctx: Ctx, id: string, to: Status, notify = false) {
  const { org, auth, env } = ctx;
  const admin = auth.role === 'owner' || auth.role === 'admin';
  return withTx(pool, async (tx) => {
    await lockOrgBookings(tx, org.id);
    const cur = await lockAppointment(tx, org.id, id);
    if (!admin) {
      const assigned = await one(
        tx,
        'SELECT 1 FROM appointment_technicians WHERE appointment_id = $1 AND user_id = $2',
        [id, auth.userId],
      );
      if (!assigned) throw notFound('Appointment');
      const allowed =
        (['pending', 'confirmed'].includes(cur.status) && ['in_progress', 'completed'].includes(to)) ||
        (cur.status === 'in_progress' && to === 'completed');
      if (!allowed) throw forbidden('Technicians can start and complete their own jobs only');
    }
    if (cur.status === to) return { warnings: [] as string[], version: cur.version };
    const row = await one<{ version: number }>(
      tx,
      `UPDATE appointments SET status = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING version`,
      [id, to],
    );
    const warnings = await applyStatusTransition(tx, org, id, cur.status, to, auth.userId);
    if (to === 'canceled') {
      await cancelPending(tx, id, ['reminder', 'confirmation', 'rescheduled']);
      if (notify && admin && cur.start_at > new Date() && org.settings.notifications.cancellation_enabled) {
        await enqueueAppointmentMessage(tx, org, env, id, 'canceled', { automatic: true });
      }
    }
    await logActivity(tx, {
      orgId: org.id,
      userId: auth.userId,
      entityType: 'appointment',
      entityId: id,
      action: `status:${to}`,
      details: { from: cur.status },
    });
    return { warnings, version: row!.version };
  });
}

/**
 * Deletes a booking (or this and all later occurrences of a series). Completed/invoiced jobs are
 * kept for the record. Returns storage keys of deleted photos for the caller to remove after commit.
 */
export async function deleteAppointment(pool: Pool, ctx: Ctx, id: string, scope: 'this' | 'future') {
  const { org, auth } = ctx;
  return withTx(pool, async (tx) => {
    const cur = await lockAppointment(tx, org.id, id);
    let targets: string[];
    if (scope === 'future' && cur.series_id && cur.series_index !== null) {
      targets = (
        await many<{ id: string }>(
          tx,
          `SELECT a.id FROM appointments a
            WHERE a.org_id = $1 AND a.series_id = $2 AND a.series_index >= $3 AND a.status <> 'completed'
              AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.appointment_id = a.id AND i.status <> 'void')
            FOR UPDATE`,
          [org.id, cur.series_id, cur.series_index],
        )
      ).map((r) => r.id);
      // Stop generating new occurrences from here on.
      await tx.query(
        `UPDATE appointment_series SET active = false, ends_after = LEAST(COALESCE(ends_after, $2), $2), updated_at = now() WHERE id = $1`,
        [cur.series_id, cur.series_index],
      );
    } else {
      if (cur.status === 'completed')
        throw conflict('completed_job', 'Completed jobs are kept for your records and cannot be deleted.');
      const inv = await one(tx, `SELECT 1 FROM invoices WHERE appointment_id = $1 AND status <> 'void'`, [id]);
      if (inv)
        throw conflict('has_invoice', 'This job has an invoice. Void the invoice first, or cancel the job instead.');
      targets = [id];
    }
    const photos = await many<{ storage_key: string; thumb_key: string }>(
      tx,
      'SELECT storage_key, thumb_key FROM photos WHERE org_id = $1 AND appointment_id = ANY($2::uuid[])',
      [org.id, targets],
    );
    await tx.query('DELETE FROM appointments WHERE org_id = $1 AND id = ANY($2::uuid[])', [org.id, targets]);
    await logActivity(tx, {
      orgId: org.id,
      userId: auth.userId,
      entityType: 'appointment',
      entityId: id,
      action: 'deleted',
      details: { count: targets.length, scope },
    });
    return { deleted: targets.length, storageKeys: photos.flatMap((p) => [p.storage_key, p.thumb_key]) };
  });
}

/** Scheduler job: keeps every active series generated SERIES_HORIZON_DAYS ahead. Idempotent. */
export async function extendAllSeries(pool: Pool, now: Date = new Date()): Promise<number> {
  const rows = await many<{ id: string }>(pool, 'SELECT id FROM appointment_series WHERE active ORDER BY created_at');
  const horizon = DateTime.fromJSDate(now).plus({ days: SERIES_HORIZON_DAYS });
  let created = 0;
  for (const { id } of rows) {
    created += await withTx(pool, async (tx) => {
      const s = await one<SeriesRow & { customer_archived: boolean }>(
        tx,
        `SELECT s.*, c.archived_at IS NOT NULL AS customer_archived
           FROM appointment_series s JOIN customers c ON c.org_id = s.org_id AND c.id = s.customer_id
          WHERE s.id = $1 AND s.active FOR UPDATE OF s SKIP LOCKED`,
        [id],
      );
      if (!s) return 0;
      if (s.customer_archived) {
        await tx.query('UPDATE appointment_series SET active = false, updated_at = now() WHERE id = $1', [id]);
        return 0;
      }
      const occurrences = computeOccurrences(s, s.next_index, horizon);
      if (!occurrences.length) {
        if (seriesFinished(s, s.next_index))
          await tx.query('UPDATE appointment_series SET active = false, updated_at = now() WHERE id = $1', [id]);
        return 0;
      }
      // Template references may have changed since the series was created.
      const t = s.template;
      const vehicle = t.vehicle_id
        ? await one(tx, 'SELECT 1 FROM vehicles WHERE org_id = $1 AND id = $2 AND customer_id = $3', [
            s.org_id,
            t.vehicle_id,
            s.customer_id,
          ])
        : null;
      const techs = t.technician_ids.length
        ? (
            await many<{ id: string }>(
              tx,
              'SELECT id FROM users WHERE org_id = $1 AND active AND id = ANY($2::uuid[])',
              [s.org_id, t.technician_ids],
            )
          ).map((r) => r.id)
        : [];
      const serviceIds = t.items.map((i) => i.service_id).filter((v): v is string => Boolean(v));
      const liveServices = new Set(
        serviceIds.length
          ? (
              await many<{ id: string }>(tx, 'SELECT id FROM services WHERE org_id = $1 AND id = ANY($2::uuid[])', [
                s.org_id,
                serviceIds,
              ])
            ).map((r) => r.id)
          : [],
      );
      const items = t.items.map((i) => ({
        ...i,
        service_id: i.service_id && liveServices.has(i.service_id) ? i.service_id : null,
      }));
      let n = 0;
      for (const occ of occurrences) {
        const newId = await insertAppointment(
          tx,
          s.org_id,
          {
            customer_id: s.customer_id,
            vehicle_id: vehicle ? t.vehicle_id : null,
            series_id: s.id,
            series_index: occ.index,
            start: occ.start,
            end: occ.end,
            status: t.status,
            location: t.location,
            notes: t.notes,
            discount_cents: t.discount_cents,
            created_by: null,
          },
          items,
          techs,
        );
        if (newId) n++;
      }
      const nextIndex = occurrences[occurrences.length - 1]!.index + 1;
      await tx.query('UPDATE appointment_series SET next_index = $2, active = $3, updated_at = now() WHERE id = $1', [
        id,
        nextIndex,
        !seriesFinished(s, nextIndex),
      ]);
      return n;
    });
  }
  return created;
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export const LIST_SELECT = `
  SELECT a.id, a.start_at, a.end_at, a.status, a.customer_id, c.name AS customer_name, c.phone AS customer_phone,
         a.vehicle_id, NULLIF(concat_ws(' ', v.make, v.model), '') AS vehicle, v.plate, a.location, a.notes,
         a.series_id, a.version,
         COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'color', u.color) ORDER BY u.name)
                     FROM appointment_technicians t JOIN users u ON u.id = t.user_id WHERE t.appointment_id = a.id), '[]'::json) AS technicians,
         (SELECT string_agg(i.name, ' + ' ORDER BY i.position) FROM appointment_items i WHERE i.appointment_id = a.id) AS services,
         GREATEST(0, (SELECT COALESCE(SUM(i.quantity * i.unit_price_cents), 0) FROM appointment_items i WHERE i.appointment_id = a.id) - a.discount_cents)::int AS value_cents,
         inv.id AS invoice_id, inv.status AS invoice_status,
         (SELECT count(*) FROM photos p WHERE p.appointment_id = a.id)::int AS photo_count
    FROM appointments a
    JOIN customers c ON c.org_id = a.org_id AND c.id = a.customer_id
    LEFT JOIN vehicles v ON v.org_id = a.org_id AND v.id = a.vehicle_id
    LEFT JOIN invoices inv ON inv.org_id = a.org_id AND inv.appointment_id = a.id AND inv.status <> 'void'`;

export async function listAppointments(
  db: Db,
  orgId: string,
  f: { from: Date; to: Date; technicianId?: string; customerId?: string; status?: Status; onlyForUser?: string },
) {
  const where = ['a.org_id = $1', 'a.start_at < $3', 'a.end_at > $2'];
  const params: unknown[] = [orgId, f.from, f.to];
  const techFilter = f.onlyForUser ?? f.technicianId;
  if (techFilter) {
    params.push(techFilter);
    where.push(
      `EXISTS (SELECT 1 FROM appointment_technicians t WHERE t.appointment_id = a.id AND t.user_id = $${params.length})`,
    );
  }
  if (f.customerId) {
    params.push(f.customerId);
    where.push(`a.customer_id = $${params.length}`);
  }
  if (f.status) {
    params.push(f.status);
    where.push(`a.status = $${params.length}`);
  }
  return many(db, `${LIST_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.start_at LIMIT 3000`, params);
}

export async function getAppointmentDetail(db: Db, org: OrgContext, id: string, viewer: AuthContext) {
  const admin = viewer.role === 'owner' || viewer.role === 'admin';
  const a = await one<
    Record<string, unknown> & {
      id: string;
      discount_cents: number;
      invoice_id: string | null;
      series_id: string | null;
    }
  >(
    db,
    `SELECT a.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, c.address AS customer_address,
            c.notes AS customer_notes, v.make, v.model, v.year, v.plate, v.vin, v.color AS vehicle_color,
            s.freq AS series_freq, s.interval AS series_interval, s.active AS series_active,
            inv.id AS invoice_id, inv.number AS invoice_number, inv.status AS invoice_status, inv.total_cents AS invoice_total_cents,
            inv.paid_cents AS invoice_paid_cents
       FROM appointments a
       JOIN customers c ON c.org_id = a.org_id AND c.id = a.customer_id
       LEFT JOIN vehicles v ON v.org_id = a.org_id AND v.id = a.vehicle_id
       LEFT JOIN appointment_series s ON s.id = a.series_id
       LEFT JOIN invoices inv ON inv.org_id = a.org_id AND inv.appointment_id = a.id AND inv.status <> 'void'
      WHERE a.org_id = $1 AND a.id = $2`,
    [org.id, id],
  );
  if (!a) throw notFound('Appointment');
  const technicians = await many<{ id: string; name: string; color: string; active: boolean }>(
    db,
    `SELECT u.id, u.name, u.color, u.active FROM appointment_technicians t JOIN users u ON u.id = t.user_id
      WHERE t.appointment_id = $1 ORDER BY u.name`,
    [id],
  );
  // Employees only see jobs they are assigned to (404, not 403, so ids can't be probed).
  if (!admin && !technicians.some((t) => t.id === viewer.userId)) throw notFound('Appointment');
  const items = await many<{
    id: string;
    service_id: string | null;
    name: string;
    unit_price_cents: number;
    quantity: number;
  }>(
    db,
    'SELECT id, service_id, name, unit_price_cents, quantity FROM appointment_items WHERE appointment_id = $1 ORDER BY position',
    [id],
  );
  const photos = await many(
    db,
    `SELECT p.id, p.kind, p.width, p.height, p.created_at, u.name AS uploaded_by_name
       FROM photos p LEFT JOIN users u ON u.id = p.uploaded_by
      WHERE p.org_id = $1 AND p.appointment_id = $2 ORDER BY CASE p.kind WHEN 'before' THEN 0 ELSE 1 END, p.created_at`,
    [org.id, id],
  );
  const inv = org.settings.invoicing;
  const totals = computeTotals(items, a.discount_cents, inv.tax_rate_bp, inv.prices_include_tax);
  const extra = admin
    ? {
        notifications: await many(
          db,
          `SELECT id, kind, channel, recipient, status, error, attempts, created_at, sent_at, next_attempt_at
             FROM notifications WHERE org_id = $1 AND appointment_id = $2 ORDER BY created_at DESC LIMIT 50`,
          [org.id, id],
        ),
        activity: await many(
          db,
          `SELECT l.action, l.details, l.created_at, u.name AS user_name FROM activity_log l LEFT JOIN users u ON u.id = l.user_id
            WHERE l.org_id = $1 AND l.entity_type = 'appointment' AND l.entity_id = $2 ORDER BY l.created_at DESC LIMIT 50`,
          [org.id, id],
        ),
      }
    : {};
  if (!admin) {
    // Technicians don't need billing details.
    delete a.invoice_total_cents;
    delete a.invoice_paid_cents;
    delete a.customer_email;
  }
  return { ...a, technicians, items, photos, totals, ...extra };
}
