import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from '../db/pool.js';
import { many, one } from '../db/pool.js';
import { loadOrg, type OrgContext } from '../lib/org.js';
import { SECRET_KINDS, type NotificationKind } from './outbox.js';
import { ProviderError, type Providers, type SendResult } from './providers.js';

export const MAX_ATTEMPTS = 5;
/** Minutes to wait before retry n (after attempt 1, 2, 3, 4). */
const BACKOFF_MINUTES = [1, 5, 15, 60];

interface NotificationRow {
  id: string;
  org_id: string;
  appointment_id: string | null;
  customer_id: string | null;
  invoice_id: string | null;
  kind: NotificationKind;
  channel: 'sms' | 'email';
  recipient: string;
  subject: string | null;
  body: string;
  html: string | null;
  meta: Record<string, unknown>;
  attempts: number;
}

export interface WorkerDeps {
  pool: Pool;
  providers: Providers;
  log: FastifyBaseLogger;
  renderInvoicePdf: (orgId: string, invoiceId: string) => Promise<{ filename: string; content: Buffer }>;
}

const APPOINTMENT_KINDS: ReadonlySet<NotificationKind> = new Set([
  'confirmation',
  'reminder',
  'rescheduled',
  'canceled',
  'followup',
]);

/** Re-checks, right before sending, that the message still makes sense (consent, job not moved/cancelled). */
async function reasonToSkip(pool: Pool, n: NotificationRow): Promise<string | null> {
  if (n.customer_id) {
    const c = await one<{ sms_opt_in: boolean; email_opt_in: boolean; marketing_opt_in: boolean }>(
      pool,
      'SELECT sms_opt_in, email_opt_in, marketing_opt_in FROM customers WHERE id = $1',
      [n.customer_id],
    );
    if (!c) return 'Customer no longer exists';
    if (n.channel === 'sms' && !c.sms_opt_in) return 'Customer opted out of SMS';
    if (n.channel === 'email' && !c.email_opt_in) return 'Customer opted out of email';
    if (n.kind === 'followup' && !c.marketing_opt_in) return 'Customer opted out of marketing messages';
  }
  if (!APPOINTMENT_KINDS.has(n.kind)) return null;
  if (!n.appointment_id) return 'Appointment was deleted';
  const a = await one<{ status: string; start_at: Date }>(
    pool,
    'SELECT status, start_at FROM appointments WHERE id = $1',
    [n.appointment_id],
  );
  if (!a) return 'Appointment was deleted';
  const plannedStart = typeof n.meta.start_at === 'string' ? n.meta.start_at : null;
  switch (n.kind) {
    case 'reminder':
      if (!['pending', 'confirmed'].includes(a.status)) return `Appointment is ${a.status}`;
      if (a.start_at.getTime() <= Date.now()) return 'Appointment already started';
      if (plannedStart && plannedStart !== a.start_at.toISOString()) return 'Appointment was rescheduled';
      return null;
    case 'confirmation':
    case 'rescheduled':
      if (a.status === 'canceled') return 'Appointment was cancelled';
      if (plannedStart && plannedStart !== a.start_at.toISOString()) return 'Appointment was rescheduled again';
      return null;
    case 'canceled':
      return a.status === 'canceled' ? null : 'Appointment was reinstated';
    case 'followup':
      return a.status === 'completed' ? null : `Appointment is ${a.status}`;
    default:
      return null;
  }
}

async function send(deps: WorkerDeps, n: NotificationRow, org: OrgContext): Promise<SendResult> {
  if (n.channel === 'sms') return deps.providers.sendSms(n.recipient, n.body);
  const headers: Record<string, string> = {};
  if (typeof n.meta.unsubscribe_url === 'string') {
    headers['List-Unsubscribe'] = `<${n.meta.unsubscribe_url}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  const attachments = [];
  if (n.kind === 'invoice' && n.invoice_id) {
    const pdf = await deps.renderInvoicePdf(n.org_id, n.invoice_id);
    attachments.push({ ...pdf, type: 'application/pdf' });
  }
  return deps.providers.sendEmail({
    to: n.recipient,
    subject: n.subject ?? org.name,
    text: n.body,
    html: n.html,
    fromName: org.name,
    replyTo: org.settings.business.email || null,
    headers,
    attachments,
  });
}

async function deliver(deps: WorkerDeps, n: NotificationRow, orgs: Map<string, OrgContext>): Promise<void> {
  const { pool, log } = deps;
  const skip = await reasonToSkip(pool, n);
  if (skip) {
    await pool.query(
      `UPDATE notifications SET status = 'skipped', error = $2, locked_at = NULL, updated_at = now() WHERE id = $1`,
      [n.id, skip],
    );
    return;
  }
  let org = orgs.get(n.org_id);
  if (!org) {
    org = await loadOrg(pool, n.org_id);
    orgs.set(n.org_id, org);
  }
  try {
    const result = await send(deps, n, org);
    await pool.query(
      `UPDATE notifications
          SET status = $2, provider_id = $3, sent_at = now(), error = NULL, locked_at = NULL, updated_at = now(),
              body = CASE WHEN $4 THEN '[redacted]' ELSE body END,
              html = CASE WHEN $4 THEN NULL ELSE html END
        WHERE id = $1`,
      [n.id, result.status, result.providerId ?? null, SECRET_KINDS.has(n.kind)],
    );
    log.info(
      { notificationId: n.id, kind: n.kind, channel: n.channel, status: result.status },
      'notification delivered',
    );
  } catch (err) {
    const permanent = err instanceof ProviderError && err.permanent;
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    if (err instanceof ProviderError && err.providerCode === '21610' && n.customer_id) {
      // Twilio: the recipient has replied STOP to our number. Respect it everywhere.
      await pool.query('UPDATE customers SET sms_opt_in = false, updated_at = now() WHERE id = $1', [n.customer_id]);
    }
    if (permanent || n.attempts >= MAX_ATTEMPTS) {
      await pool.query(
        `UPDATE notifications SET status = 'failed', error = $2, locked_at = NULL, updated_at = now() WHERE id = $1`,
        [n.id, message],
      );
      log.warn(
        { notificationId: n.id, kind: n.kind, channel: n.channel, err: message },
        'notification failed permanently',
      );
    } else {
      const wait = BACKOFF_MINUTES[Math.min(n.attempts - 1, BACKOFF_MINUTES.length - 1)] ?? 60;
      await pool.query(
        `UPDATE notifications SET status = 'queued', error = $2, locked_at = NULL, updated_at = now(),
                next_attempt_at = now() + make_interval(mins => $3) WHERE id = $1`,
        [n.id, message, wait],
      );
      log.warn(
        { notificationId: n.id, attempt: n.attempts, retryInMinutes: wait, err: message },
        'notification failed, will retry',
      );
    }
  }
}

/**
 * Claims due messages atomically (FOR UPDATE SKIP LOCKED: safe with several workers/replicas) and
 * delivers them. Returns how many were processed.
 */
export async function processOutbox(deps: WorkerDeps, batchSize = 25): Promise<number> {
  const claimed = await many<NotificationRow>(
    deps.pool,
    `UPDATE notifications n
        SET status = 'sending', locked_at = now(), attempts = n.attempts + 1, updated_at = now()
      WHERE n.id IN (SELECT id FROM notifications
                      WHERE status = 'queued' AND next_attempt_at <= now()
                      ORDER BY next_attempt_at
                      LIMIT $1
                      FOR UPDATE SKIP LOCKED)
      RETURNING n.id, n.org_id, n.appointment_id, n.customer_id, n.invoice_id, n.kind, n.channel, n.recipient,
                n.subject, n.body, n.html, n.meta, n.attempts`,
    [batchSize],
  );
  const orgs = new Map<string, OrgContext>();
  for (const n of claimed) {
    try {
      await deliver(deps, n, orgs);
    } catch (err) {
      // Unexpected (e.g. DB hiccup): leave it for stuck-message recovery rather than crash the loop.
      deps.log.error({ err, notificationId: n.id }, 'notification delivery crashed');
    }
  }
  return claimed.length;
}

/** Messages stuck in "sending" (process died mid-send) go back to the queue. */
export async function recoverStuck(pool: Pool): Promise<number> {
  const res = await pool.query(
    `UPDATE notifications SET status = 'queued', locked_at = NULL, next_attempt_at = now(), updated_at = now()
      WHERE status = 'sending' AND locked_at < now() - interval '10 minutes'`,
  );
  return res.rowCount ?? 0;
}
