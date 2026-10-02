import { DateTime } from 'luxon';
import type { Client, Db } from '../db/pool.js';
import { many, one } from '../db/pool.js';
import { logActivity } from '../lib/activity.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { computeTotals } from '../lib/money.js';
import type { OrgContext } from '../lib/org.js';
import { localToday } from '../lib/time.js';

export interface BillTo {
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  vehicle: string | null;
  vin: string | null;
}

export interface InvoiceRow {
  id: string;
  org_id: string;
  number: string;
  customer_id: string;
  appointment_id: string | null;
  status: 'open' | 'paid' | 'void';
  issue_date: string;
  due_date: string;
  bill_to: BillTo;
  subtotal_cents: number;
  discount_cents: number;
  tax_rate_bp: number;
  prices_include_tax: boolean;
  tax_cents: number;
  total_cents: number;
  paid_cents: number;
  notes: string | null;
  paid_at: Date | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Date;
}

/** Next gap-free invoice number. The row lock on the organisation serialises concurrent issuers. */
async function nextInvoiceNumber(tx: Client, org: OrgContext): Promise<string> {
  const row = await one<{ invoice_seq: number }>(
    tx,
    'UPDATE organizations SET invoice_seq = invoice_seq + 1 WHERE id = $1 RETURNING invoice_seq',
    [org.id],
  );
  if (!row) throw notFound('Organisation');
  return `${org.settings.invoicing.prefix}${String(row.invoice_seq).padStart(5, '0')}`;
}

/**
 * Issues an invoice from a completed job: line items, discount and tax are copied (snapshotted) so
 * later edits to the job or price list never alter an issued invoice. Idempotent: returns the
 * existing active invoice if there is one. Returns null when the job has nothing billable.
 */
export async function issueInvoiceForAppointment(
  tx: Client,
  org: OrgContext,
  appointmentId: string,
  userId: string | null,
): Promise<{ id: string; number: string; created: boolean } | null> {
  const existing = await one<{ id: string; number: string }>(
    tx,
    `SELECT id, number FROM invoices WHERE org_id = $1 AND appointment_id = $2 AND status <> 'void'`,
    [org.id, appointmentId],
  );
  if (existing) return { ...existing, created: false };

  const a = await one<{
    customer_id: string;
    discount_cents: number;
    notes: string | null;
    name: string;
    email: string | null;
    phone: string | null;
    address: string | null;
    vehicle: string | null;
    vin: string | null;
  }>(
    tx,
    `SELECT a.customer_id, a.discount_cents, a.notes, c.name, c.email, c.phone, c.address,
            NULLIF(concat_ws(' ', v.year::text, v.make, v.model, CASE WHEN v.plate IS NOT NULL THEN '(' || v.plate || ')' END), '') AS vehicle,
            v.vin
       FROM appointments a
       JOIN customers c ON c.org_id = a.org_id AND c.id = a.customer_id
       LEFT JOIN vehicles v ON v.org_id = a.org_id AND v.id = a.vehicle_id
      WHERE a.org_id = $1 AND a.id = $2`,
    [org.id, appointmentId],
  );
  if (!a) throw notFound('Appointment');
  const items = await many<{ name: string; quantity: number; unit_price_cents: number }>(
    tx,
    'SELECT name, quantity, unit_price_cents FROM appointment_items WHERE appointment_id = $1 ORDER BY position',
    [appointmentId],
  );
  if (items.length === 0) return null;

  const inv = org.settings.invoicing;
  const totals = computeTotals(items, a.discount_cents, inv.tax_rate_bp, inv.prices_include_tax);
  const issueDate = localToday(org.timezone);
  const dueDate = DateTime.fromISO(issueDate).plus({ days: inv.payment_terms_days }).toISODate();
  const number = await nextInvoiceNumber(tx, org);
  const billTo: BillTo = {
    name: a.name,
    email: a.email,
    phone: a.phone,
    address: a.address,
    vehicle: a.vehicle,
    vin: a.vin,
  };
  const created = await one<{ id: string }>(
    tx,
    `INSERT INTO invoices (org_id, number, customer_id, appointment_id, issue_date, due_date, bill_to, subtotal_cents,
                           discount_cents, tax_rate_bp, prices_include_tax, tax_cents, total_cents, notes, status, paid_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
    [
      org.id,
      number,
      a.customer_id,
      appointmentId,
      issueDate,
      dueDate,
      JSON.stringify(billTo),
      totals.subtotal_cents,
      totals.discount_cents,
      inv.tax_rate_bp,
      inv.prices_include_tax,
      totals.tax_cents,
      totals.total_cents,
      inv.footer || null,
      // A zero-total job (e.g. fully discounted) is settled on issue.
      totals.total_cents === 0 ? 'paid' : 'open',
      totals.total_cents === 0 ? new Date() : null,
    ],
  );
  if (!created) throw new Error('invoice insert returned no row');
  let position = 0;
  for (const item of items) {
    await tx.query(
      `INSERT INTO invoice_items (org_id, invoice_id, description, quantity, unit_price_cents, total_cents, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        org.id,
        created.id,
        item.name,
        item.quantity,
        item.unit_price_cents,
        item.quantity * item.unit_price_cents,
        position++,
      ],
    );
  }
  await logActivity(tx, {
    orgId: org.id,
    userId,
    entityType: 'invoice',
    entityId: created.id,
    action: 'issued',
    details: { number, appointment_id: appointmentId },
  });
  return { id: created.id, number, created: true };
}

async function lockInvoice(tx: Client, orgId: string, invoiceId: string): Promise<InvoiceRow> {
  const inv = await one<InvoiceRow>(tx, 'SELECT * FROM invoices WHERE org_id = $1 AND id = $2 FOR UPDATE', [
    orgId,
    invoiceId,
  ]);
  if (!inv) throw notFound('Invoice');
  return inv;
}

export async function voidInvoice(
  tx: Client,
  orgId: string,
  invoiceId: string,
  reason: string,
  userId: string | null,
): Promise<void> {
  const inv = await lockInvoice(tx, orgId, invoiceId);
  if (inv.status === 'void') return;
  if (inv.paid_cents > 0) {
    throw conflict(
      'invoice_has_payments',
      'This invoice has payments recorded. Remove the payments (or refund them) before voiding it.',
    );
  }
  await tx.query(
    `UPDATE invoices SET status = 'void', voided_at = now(), void_reason = $3, updated_at = now() WHERE org_id = $1 AND id = $2`,
    [orgId, invoiceId, reason.slice(0, 300)],
  );
  await logActivity(tx, {
    orgId,
    userId,
    entityType: 'invoice',
    entityId: invoiceId,
    action: 'voided',
    details: { reason: reason.slice(0, 300) },
  });
}

async function refreshPaidState(tx: Client, orgId: string, invoiceId: string): Promise<void> {
  await tx.query(
    `UPDATE invoices i
        SET paid_cents = p.total,
            status = CASE WHEN i.status = 'void' THEN 'void' WHEN p.total >= i.total_cents THEN 'paid' ELSE 'open' END,
            paid_at = CASE WHEN p.total >= i.total_cents THEN COALESCE(i.paid_at, now()) ELSE NULL END,
            updated_at = now()
       FROM (SELECT COALESCE(SUM(amount_cents), 0)::int AS total FROM payments WHERE invoice_id = $2) p
      WHERE i.org_id = $1 AND i.id = $2`,
    [orgId, invoiceId],
  );
}

export async function recordPayment(
  tx: Client,
  orgId: string,
  invoiceId: string,
  input: {
    amount_cents: number;
    method: 'cash' | 'card' | 'bank_transfer' | 'other';
    paid_at?: Date;
    reference?: string | null;
  },
  userId: string,
): Promise<string> {
  const inv = await lockInvoice(tx, orgId, invoiceId);
  if (inv.status === 'void') throw conflict('invoice_void', 'Payments cannot be recorded against a void invoice');
  const balance = inv.total_cents - inv.paid_cents;
  if (balance <= 0) throw conflict('invoice_paid', 'This invoice is already paid in full');
  if (input.amount_cents > balance) {
    throw badRequest(`The amount is more than the balance due (${(balance / 100).toFixed(2)})`, {
      fields: { amount_cents: 'More than the balance due' },
    });
  }
  const row = await one<{ id: string }>(
    tx,
    `INSERT INTO payments (org_id, invoice_id, amount_cents, method, paid_at, reference, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [orgId, invoiceId, input.amount_cents, input.method, input.paid_at ?? new Date(), input.reference ?? null, userId],
  );
  await refreshPaidState(tx, orgId, invoiceId);
  await logActivity(tx, {
    orgId,
    userId,
    entityType: 'invoice',
    entityId: invoiceId,
    action: 'payment_recorded',
    details: { amount_cents: input.amount_cents, method: input.method },
  });
  return row!.id;
}

export async function deletePayment(
  tx: Client,
  orgId: string,
  invoiceId: string,
  paymentId: string,
  userId: string,
): Promise<void> {
  await lockInvoice(tx, orgId, invoiceId);
  const deleted = await one<{ amount_cents: number }>(
    tx,
    'DELETE FROM payments WHERE org_id = $1 AND invoice_id = $2 AND id = $3 RETURNING amount_cents',
    [orgId, invoiceId, paymentId],
  );
  if (!deleted) throw notFound('Payment');
  await refreshPaidState(tx, orgId, invoiceId);
  await logActivity(tx, {
    orgId,
    userId,
    entityType: 'invoice',
    entityId: invoiceId,
    action: 'payment_removed',
    details: { amount_cents: deleted.amount_cents },
  });
}

export async function getInvoiceDetail(db: Db, orgId: string, invoiceId: string) {
  const invoice = await one<InvoiceRow & { customer_name: string; appointment_start_at: Date | null }>(
    db,
    `SELECT i.*, c.name AS customer_name, a.start_at AS appointment_start_at
       FROM invoices i
       JOIN customers c ON c.org_id = i.org_id AND c.id = i.customer_id
       LEFT JOIN appointments a ON a.org_id = i.org_id AND a.id = i.appointment_id
      WHERE i.org_id = $1 AND i.id = $2`,
    [orgId, invoiceId],
  );
  if (!invoice) throw notFound('Invoice');
  const [items, payments, photos] = await Promise.all([
    many<{ description: string; quantity: number; unit_price_cents: number; total_cents: number }>(
      db,
      'SELECT description, quantity, unit_price_cents, total_cents FROM invoice_items WHERE invoice_id = $1 ORDER BY position',
      [invoiceId],
    ),
    many<{
      id: string;
      amount_cents: number;
      method: string;
      paid_at: Date;
      reference: string | null;
      recorded_by_name: string | null;
    }>(
      db,
      `SELECT p.id, p.amount_cents, p.method, p.paid_at, p.reference, u.name AS recorded_by_name
         FROM payments p LEFT JOIN users u ON u.id = p.recorded_by
        WHERE p.invoice_id = $1 ORDER BY p.paid_at`,
      [invoiceId],
    ),
    invoice.appointment_id
      ? many<{ id: string; kind: 'before' | 'after'; thumb_key: string }>(
          db,
          `SELECT id, kind, thumb_key FROM photos WHERE org_id = $1 AND appointment_id = $2
            ORDER BY CASE kind WHEN 'before' THEN 0 ELSE 1 END, created_at`,
          [orgId, invoice.appointment_id],
        )
      : Promise.resolve([]),
  ]);
  return { ...invoice, items, payments, photos };
}

export type InvoiceDetail = Awaited<ReturnType<typeof getInvoiceDetail>>;
