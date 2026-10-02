import type { Db } from '../db/pool.js';
import { one } from '../db/pool.js';

export type NotificationKind =
  | 'confirmation'
  | 'reminder'
  | 'rescheduled'
  | 'canceled'
  | 'followup'
  | 'invoice'
  | 'low_stock'
  | 'invite'
  | 'password_reset'
  | 'test';

/** Messages whose body contains a secret link: never shown in the message log, wiped after sending. */
export const SECRET_KINDS: ReadonlySet<NotificationKind> = new Set(['invite', 'password_reset']);

export interface OutboxMessage {
  orgId: string;
  kind: NotificationKind;
  channel: 'sms' | 'email';
  recipient: string;
  subject?: string | null;
  body: string;
  html?: string | null;
  appointmentId?: string | null;
  customerId?: string | null;
  invoiceId?: string | null;
  meta?: Record<string, unknown>;
  /** Same key twice => the second enqueue is a no-op. Makes scheduled sends idempotent. */
  dedupeKey?: string | null;
  sendAt?: Date;
}

/** Inserts into the outbox. Returns the new id, or null when an identical (deduped) message exists. */
export async function enqueue(db: Db, msg: OutboxMessage): Promise<string | null> {
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO notifications
       (org_id, kind, channel, recipient, subject, body, html, appointment_id, customer_id, invoice_id, meta, dedupe_key, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      msg.orgId,
      msg.kind,
      msg.channel,
      msg.recipient,
      msg.subject ?? null,
      msg.body,
      msg.html ?? null,
      msg.appointmentId ?? null,
      msg.customerId ?? null,
      msg.invoiceId ?? null,
      JSON.stringify(msg.meta ?? {}),
      msg.dedupeKey ?? null,
      msg.sendAt ?? new Date(),
    ],
  );
  return row?.id ?? null;
}

/** Cancels messages for an appointment that have not gone out yet (e.g. reminders for a moved/cancelled job). */
export async function cancelPending(db: Db, appointmentId: string, kinds: NotificationKind[]): Promise<void> {
  await db.query(
    `UPDATE notifications SET status = 'canceled', updated_at = now()
      WHERE appointment_id = $1 AND kind = ANY($2) AND status = 'queued'`,
    [appointmentId, kinds],
  );
}
