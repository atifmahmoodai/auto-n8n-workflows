import type { Db } from '../db/pool.js';
import { many, one } from '../db/pool.js';
import { signPayload } from '../lib/crypto.js';
import type { OrgContext } from '../lib/org.js';
import { escapeHtml, renderTemplate } from '../lib/template.js';
import { formatForCustomer } from '../lib/time.js';
import { enqueue, type NotificationKind } from './outbox.js';

export type AppointmentMessageKind = 'confirmation' | 'reminder' | 'rescheduled' | 'canceled' | 'followup';

/** Marketing messages need marketing consent and must carry an opt-out (UK PECR / GDPR). */
const MARKETING: ReadonlySet<AppointmentMessageKind> = new Set(['followup']);

const SUBJECTS: Record<AppointmentMessageKind, string> = {
  confirmation: 'Booking confirmed: {service} on {date}',
  reminder: 'Reminder: {service} on {datetime}',
  rescheduled: 'Your appointment has moved to {datetime}',
  canceled: 'Your appointment on {date} has been cancelled',
  followup: 'Thanks for choosing {business_name}',
};

export interface MessageEnv {
  publicUrl: string;
  secret: string;
}

interface ApptRow {
  id: string;
  customer_id: string;
  start_at: Date;
  status: string;
  location: string | null;
  customer_name: string;
  email: string | null;
  phone: string | null;
  sms_opt_in: boolean;
  email_opt_in: boolean;
  marketing_opt_in: boolean;
  archived: boolean;
  vehicle: string | null;
  services: string | null;
}

export function unsubscribeUrl(env: MessageEnv, orgId: string, customerId: string): string {
  return `${env.publicUrl}/api/public/unsubscribe/${signPayload(env.secret, { o: orgId, c: customerId })}`;
}

async function loadAppointment(db: Db, orgId: string, appointmentId: string): Promise<ApptRow | undefined> {
  return one<ApptRow>(
    db,
    `SELECT a.id, a.customer_id, a.start_at, a.status, a.location,
            c.name AS customer_name, c.email, c.phone, c.sms_opt_in, c.email_opt_in, c.marketing_opt_in,
            c.archived_at IS NOT NULL AS archived,
            NULLIF(concat_ws(' ', v.year::text, v.make, v.model, CASE WHEN v.plate IS NOT NULL THEN '(' || v.plate || ')' END), '') AS vehicle,
            (SELECT string_agg(i.name, ' + ' ORDER BY i.position) FROM appointment_items i WHERE i.appointment_id = a.id) AS services
       FROM appointments a
       JOIN customers c ON c.org_id = a.org_id AND c.id = a.customer_id
       LEFT JOIN vehicles v ON v.org_id = a.org_id AND v.id = a.vehicle_id
      WHERE a.org_id = $1 AND a.id = $2`,
    [orgId, appointmentId],
  );
}

function emailHtml(
  org: OrgContext,
  text: string,
  details: Array<[string, string]>,
  extra: { footerHtml?: string; actionHtml?: string } = {},
): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const rows = details
    .filter(([, v]) => v)
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#6b7280">${escapeHtml(k)}</td><td style="padding:6px 0;font-weight:600">${escapeHtml(v)}</td></tr>`,
    )
    .join('');
  const contact = [org.settings.business.phone, org.settings.business.email, org.settings.business.website]
    .filter(Boolean)
    .map(escapeHtml)
    .join(' &middot; ');
  return `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:28px">
<tr><td><h1 style="margin:0 0 18px;font-size:20px">${escapeHtml(org.name)}</h1>${paragraphs}
${rows ? `<table role="presentation" style="margin:8px 0 4px;font-size:14px">${rows}</table>` : ''}${extra.actionHtml ?? ''}</td></tr></table>
<p style="font-size:12px;color:#6b7280;margin:16px 0 0">${contact}${extra.footerHtml ?? ''}</p>
</td></tr></table></body></html>`;
}

/**
 * Renders and enqueues an appointment message on every channel the customer has consented to.
 * Returns the number of messages queued (0 when there is no contact detail/consent, or deduped).
 */
export async function enqueueAppointmentMessage(
  db: Db,
  org: OrgContext,
  env: MessageEnv,
  appointmentId: string,
  kind: AppointmentMessageKind,
  opts: { automatic: boolean; sendAt?: Date },
): Promise<number> {
  const a = await loadAppointment(db, org.id, appointmentId);
  if (!a) return 0;
  if (opts.automatic && a.archived) return 0;
  const marketing = MARKETING.has(kind);
  if (marketing && !a.marketing_opt_in) return 0;

  const when = formatForCustomer(a.start_at, org.timezone, org.settings.locale);
  const vars = {
    customer_name: a.customer_name,
    customer_first_name: a.customer_name.trim().split(/\s+/)[0] ?? a.customer_name,
    business_name: org.name,
    business_phone: org.settings.business.phone,
    service: a.services ?? 'appointment',
    vehicle: a.vehicle ?? '',
    date: when.date,
    time: when.time,
    datetime: when.datetime,
    location: a.location ?? '',
    review_link: org.settings.notifications.review_link,
    offer: org.settings.notifications.followup_offer,
  };
  const text = renderTemplate(org.settings.templates[kind], vars);
  const startMs = a.start_at.getTime();
  const key = (channel: string) => {
    if (!opts.automatic) return null; // manual sends are always allowed through
    if (kind === 'reminder' || kind === 'rescheduled') return `${kind}:${a.id}:${startMs}:${channel}`;
    return `${kind}:${a.id}:${channel}`;
  };
  const meta = { start_at: a.start_at.toISOString() };
  let queued = 0;

  if (a.phone && a.sms_opt_in) {
    const body = marketing ? `${text}\nReply STOP to opt out.` : text;
    const id = await enqueue(db, {
      orgId: org.id,
      kind,
      channel: 'sms',
      recipient: a.phone,
      body,
      appointmentId: a.id,
      customerId: a.customer_id,
      meta,
      dedupeKey: key('sms'),
      sendAt: opts.sendAt,
    });
    if (id) queued++;
  }

  if (a.email && a.email_opt_in) {
    const unsub = marketing ? unsubscribeUrl(env, org.id, a.customer_id) : null;
    const details: Array<[string, string]> =
      kind === 'followup'
        ? []
        : [
            ['When', when.datetime],
            ['Service', vars.service],
            ['Vehicle', vars.vehicle],
            ['Location', vars.location],
          ];
    const footer = unsub
      ? `<br><a href="${escapeHtml(unsub)}" style="color:#6b7280">Unsubscribe from offers and review requests</a>`
      : '';
    const id = await enqueue(db, {
      orgId: org.id,
      kind,
      channel: 'email',
      recipient: a.email,
      subject: renderTemplate(SUBJECTS[kind], vars),
      body: unsub ? `${text}\n\nUnsubscribe: ${unsub}` : text,
      html: emailHtml(org, text, details, { footerHtml: footer }),
      appointmentId: a.id,
      customerId: a.customer_id,
      meta: unsub ? { ...meta, unsubscribe_url: unsub } : meta,
      dedupeKey: key('email'),
      sendAt: opts.sendAt,
    });
    if (id) queued++;
  }
  return queued;
}

/** Staff-facing email (invites, password resets, alerts). */
export async function enqueueStaffEmail(
  db: Db,
  org: OrgContext,
  msg: { kind: NotificationKind; to: string; subject: string; text: string; action?: { label: string; url: string } },
): Promise<void> {
  const button = msg.action
    ? `<p style="margin:22px 0"><a href="${escapeHtml(msg.action.url)}" style="background:#2563eb;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(msg.action.label)}</a></p>`
    : '';
  const html = emailHtml(org, msg.text, [], { actionHtml: button });
  await enqueue(db, {
    orgId: org.id,
    kind: msg.kind,
    channel: 'email',
    recipient: msg.to,
    subject: msg.subject,
    body: msg.action ? `${msg.text}\n\n${msg.action.label}: ${msg.action.url}` : msg.text,
    html,
  });
}

/** Low-stock alert to every active owner/admin (email, and SMS when they have a phone number). */
export async function enqueueLowStockAlert(
  db: Db,
  org: OrgContext,
  items: Array<{ name: string; quantity: number; unit: string; low_threshold: number }>,
): Promise<void> {
  if (!org.settings.notifications.low_stock_alerts || items.length === 0) return;
  const lines = items.map((i) => `- ${i.name}: ${i.quantity} ${i.unit} left (alert level ${i.low_threshold})`);
  const text = `These supplies are running low:\n${lines.join('\n')}`;
  const admins = await many<{ email: string; phone: string | null }>(
    db,
    `SELECT email, phone FROM users WHERE org_id = $1 AND active AND role IN ('owner', 'admin')`,
    [org.id],
  );
  const emails = new Set(admins.map((a) => a.email));
  if (org.settings.business.email) emails.add(org.settings.business.email.toLowerCase());
  for (const to of emails) {
    await enqueue(db, {
      orgId: org.id,
      kind: 'low_stock',
      channel: 'email',
      recipient: to,
      subject: `Low stock: ${items.map((i) => i.name).join(', ')}`,
      body: text,
      html: emailHtml(org, text, []),
    });
  }
  for (const phone of new Set(admins.map((a) => a.phone).filter((p): p is string => Boolean(p)))) {
    await enqueue(db, {
      orgId: org.id,
      kind: 'low_stock',
      channel: 'sms',
      recipient: phone,
      body: `${org.name}: ${text}`,
    });
  }
}
