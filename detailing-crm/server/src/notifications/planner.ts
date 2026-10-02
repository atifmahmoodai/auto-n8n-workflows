import { DateTime } from 'luxon';
import type { Pool } from '../db/pool.js';
import { many, one, withTx } from '../db/pool.js';
import { loadOrg, type OrgContext } from '../lib/org.js';
import { deferOutOfQuietHours } from '../lib/time.js';
import { enqueueAppointmentMessage, type MessageEnv } from './messages.js';

export interface PlanResult {
  reminders: number;
  followups: number;
}

function quietAdjusted(org: OrgContext, now: Date): Date {
  const n = org.settings.notifications;
  return deferOutOfQuietHours(
    DateTime.fromJSDate(now).setZone(org.timezone),
    n.quiet_hours_start,
    n.quiet_hours_end,
  ).toJSDate();
}

/**
 * Plans reminders for jobs entering the reminder window. Skips jobs whose customer already received
 * the details inside that window (booked or moved at short notice), so nobody gets a confirmation and
 * a reminder seconds apart. Each appointment is planned in its own transaction with a row lock, so a
 * concurrent edit can never interleave with planning.
 */
async function planReminders(pool: Pool, org: OrgContext, env: MessageEnv, now: Date): Promise<number> {
  const hours = org.settings.notifications.reminder_hours;
  const due = await many<{ id: string }>(
    pool,
    `SELECT id FROM appointments
      WHERE org_id = $1 AND status IN ('pending', 'confirmed')
        AND start_at > $2 AND start_at <= $2::timestamptz + make_interval(hours => $3)
        AND reminder_planned_for IS DISTINCT FROM start_at`,
    [org.id, now, hours],
  );
  let planned = 0;
  for (const { id } of due) {
    planned += await withTx(pool, async (tx) => {
      const a = await one<{ start_at: Date; recently_informed: boolean }>(
        tx,
        `SELECT a.start_at,
                EXISTS (SELECT 1 FROM notifications n
                         WHERE n.appointment_id = a.id AND n.kind IN ('confirmation', 'rescheduled')
                           AND n.status NOT IN ('failed', 'skipped', 'canceled')
                           AND n.created_at >= a.start_at - make_interval(hours => $3)) AS recently_informed
           FROM appointments a
          WHERE a.id = $1 AND a.org_id = $2 AND a.status IN ('pending', 'confirmed')
            AND a.reminder_planned_for IS DISTINCT FROM a.start_at
          FOR UPDATE SKIP LOCKED`,
        [id, org.id, hours],
      );
      if (!a) return 0;
      let count = 0;
      const sendAt = quietAdjusted(org, now);
      // A reminder that quiet hours would push past the start time is pointless: skip it.
      if (!a.recently_informed && sendAt < a.start_at) {
        count = await enqueueAppointmentMessage(tx, org, env, id, 'reminder', { automatic: true, sendAt });
      }
      await tx.query('UPDATE appointments SET reminder_planned_for = start_at WHERE id = $1', [id]);
      return count > 0 ? 1 : 0;
    });
  }
  return planned;
}

/** Plans the post-job follow-up (review request / offer). Only for jobs completed in the last 3 days. */
async function planFollowups(pool: Pool, org: OrgContext, env: MessageEnv, now: Date): Promise<number> {
  const hours = org.settings.notifications.followup_hours;
  const due = await many<{ id: string }>(
    pool,
    `SELECT id FROM appointments
      WHERE org_id = $1 AND status = 'completed' AND followup_planned_at IS NULL
        AND completed_at <= $2::timestamptz - make_interval(hours => $3)
        AND completed_at > $2::timestamptz - make_interval(hours => $3 + 72)`,
    [org.id, now, hours],
  );
  let planned = 0;
  for (const { id } of due) {
    planned += await withTx(pool, async (tx) => {
      const locked = await one<{ id: string }>(
        tx,
        `SELECT id FROM appointments WHERE id = $1 AND status = 'completed' AND followup_planned_at IS NULL FOR UPDATE SKIP LOCKED`,
        [id],
      );
      if (!locked) return 0;
      const count = await enqueueAppointmentMessage(tx, org, env, id, 'followup', {
        automatic: true,
        sendAt: quietAdjusted(org, now),
      });
      await tx.query('UPDATE appointments SET followup_planned_at = now() WHERE id = $1', [id]);
      return count > 0 ? 1 : 0;
    });
  }
  return planned;
}

export async function planScheduledMessages(pool: Pool, env: MessageEnv, now: Date = new Date()): Promise<PlanResult> {
  const result: PlanResult = { reminders: 0, followups: 0 };
  const orgs = await many<{ id: string }>(pool, 'SELECT id FROM organizations ORDER BY created_at');
  for (const { id } of orgs) {
    const org = await loadOrg(pool, id);
    if (org.settings.notifications.reminder_enabled) result.reminders += await planReminders(pool, org, env, now);
    if (org.settings.notifications.followup_enabled) result.followups += await planFollowups(pool, org, env, now);
  }
  return result;
}
