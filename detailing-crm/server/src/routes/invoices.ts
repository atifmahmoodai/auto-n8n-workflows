import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAdmin } from '../auth/session.js';
import { many, one, withTx } from '../db/pool.js';
import { renderInvoicePdf } from '../invoices/pdf.js';
import { deletePayment, getInvoiceDetail, issueInvoiceForAppointment, recordPayment, voidInvoice } from '../invoices/service.js';
import { toCsv } from '../lib/csv.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { idParam, likePattern, zPage, zText } from '../lib/http.js';
import { formatMoney } from '../lib/money.js';
import { loadOrg } from '../lib/org.js';
import { isIsoDate, localToday } from '../lib/time.js';
import { enqueue } from '../notifications/outbox.js';

const isoDate = z.string().refine(isIsoDate, 'Use YYYY-MM-DD');

export function registerInvoiceRoutes(app: FastifyInstance, deps: AppDeps) {
  const { pool, storage } = deps;

  app.get('/invoices', async (req) => {
    const auth = requireAdmin(req);
    const org = await loadOrg(pool, auth.orgId);
    const qs = zPage
      .extend({
        status: z.enum(['all', 'open', 'overdue', 'paid', 'void']).default('all'),
        q: z.string().trim().max(100).default(''),
        customer_id: z.string().uuid().optional(),
      })
      .parse(req.query);
    const where = ['i.org_id = $1'];
    const params: unknown[] = [auth.orgId];
    if (qs.status === 'overdue') {
      params.push(localToday(org.timezone));
      where.push(`i.status = 'open' AND i.due_date < $${params.length}`);
    } else if (qs.status !== 'all') {
      params.push(qs.status);
      where.push(`i.status = $${params.length}`);
    }
    if (qs.customer_id) {
      params.push(qs.customer_id);
      where.push(`i.customer_id = $${params.length}`);
    }
    if (qs.q) {
      params.push(likePattern(qs.q));
      where.push(`(i.number ILIKE $${params.length} ESCAPE '\\' OR c.name ILIKE $${params.length} ESCAPE '\\')`);
    }
    params.push(qs.page_size, (qs.page - 1) * qs.page_size);
    const rows = await many<Record<string, unknown> & { total: number }>(
      pool,
      `SELECT i.id, i.number, i.status, i.issue_date, i.due_date, i.total_cents, i.paid_cents, i.customer_id, i.appointment_id,
              c.name AS customer_name, count(*) OVER ()::int AS total
         FROM invoices i JOIN customers c ON c.org_id = i.org_id AND c.id = i.customer_id
        WHERE ${where.join(' AND ')}
        ORDER BY i.issue_date DESC, i.number DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const totals = await one<{ open_cents: number; overdue_cents: number }>(
      pool,
      `SELECT COALESCE(sum(total_cents - paid_cents) FILTER (WHERE status = 'open'), 0)::int AS open_cents,
              COALESCE(sum(total_cents - paid_cents) FILTER (WHERE status = 'open' AND due_date < $2), 0)::int AS overdue_cents
         FROM invoices WHERE org_id = $1`,
      [auth.orgId, localToday(org.timezone)],
    );
    return { items: rows.map(({ total: _t, ...r }) => r), total: rows[0]?.total ?? 0, page: qs.page, page_size: qs.page_size, summary: totals };
  });

  app.get('/invoices/export.csv', async (req, reply) => {
    const auth = requireAdmin(req);
    const qs = z.object({ from: isoDate.optional(), to: isoDate.optional() }).parse(req.query);
    const rows = await many<Record<string, string | number | null>>(
      pool,
      `SELECT i.number, i.issue_date, i.due_date, i.status, c.name AS customer, i.subtotal_cents, i.discount_cents, i.tax_cents,
              i.total_cents, i.paid_cents, to_char(i.paid_at, 'YYYY-MM-DD') AS paid_on
         FROM invoices i JOIN customers c ON c.org_id = i.org_id AND c.id = i.customer_id
        WHERE i.org_id = $1 AND ($2::date IS NULL OR i.issue_date >= $2) AND ($3::date IS NULL OR i.issue_date <= $3)
        ORDER BY i.issue_date, i.number`,
      [auth.orgId, qs.from ?? null, qs.to ?? null],
    );
    const money = (v: string | number | null | undefined) => ((Number(v) || 0) / 100).toFixed(2);
    const csv = toCsv(
      ['Number', 'Issued', 'Due', 'Status', 'Customer', 'Subtotal', 'Discount', 'Tax', 'Total', 'Paid', 'Balance', 'Paid on'],
      rows.map((r) => [
        r.number, r.issue_date, r.due_date, r.status, r.customer, money(r.subtotal_cents), money(r.discount_cents), money(r.tax_cents),
        money(r.total_cents), money(r.paid_cents), money(r.status === 'void' ? 0 : Number(r.total_cents) - Number(r.paid_cents)), r.paid_on,
      ]),
    );
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="invoices-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(csv);
  });

  app.get('/invoices/:id', async (req) => {
    const auth = requireAdmin(req);
    const inv = await getInvoiceDetail(pool, auth.orgId, idParam(req, 'id', 'Invoice'));
    return { ...inv, photos: inv.photos.map(({ thumb_key: _k, ...p }) => p) };
  });

  app.get('/invoices/:id/pdf', async (req, reply) => {
    const auth = requireAdmin(req);
    const org = await loadOrg(pool, auth.orgId);
    const inv = await getInvoiceDetail(pool, auth.orgId, idParam(req, 'id', 'Invoice'));
    const pdf = await renderInvoicePdf(inv, org, storage);
    const disposition = (req.query as { download?: string }).download ? 'attachment' : 'inline';
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `${disposition}; filename="${inv.number.replace(/[^A-Za-z0-9\-_]/g, '_')}.pdf"`)
      .header('Cache-Control', 'private, no-store')
      .send(pdf);
  });

  app.post('/invoices/:id/payments', async (req, reply) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Invoice');
    const body = z
      .object({
        amount_cents: z.number().int().min(1).max(100_000_000),
        method: z.enum(['cash', 'card', 'bank_transfer', 'other']),
        paid_at: z.string().datetime({ offset: true }).optional(),
        reference: zText(120),
      })
      .parse(req.body);
    const paidAt = body.paid_at ? new Date(body.paid_at) : undefined;
    if (paidAt && paidAt.getTime() > Date.now() + 5 * 60_000) throw badRequest('The payment date cannot be in the future');
    await withTx(pool, (tx) => recordPayment(tx, auth.orgId, id, { ...body, paid_at: paidAt }, auth.userId));
    return reply.code(201).send(await getInvoiceDetail(pool, auth.orgId, id));
  });

  app.delete('/invoices/:id/payments/:paymentId', async (req) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Invoice');
    const paymentId = idParam(req, 'paymentId', 'Payment');
    await withTx(pool, (tx) => deletePayment(tx, auth.orgId, id, paymentId, auth.userId));
    return getInvoiceDetail(pool, auth.orgId, id);
  });

  app.post('/invoices/:id/void', async (req) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Invoice');
    const { reason } = z.object({ reason: z.string().trim().min(1, 'Give a reason').max(300) }).parse(req.body);
    await withTx(pool, (tx) => voidInvoice(tx, auth.orgId, id, reason, auth.userId));
    return getInvoiceDetail(pool, auth.orgId, id);
  });

  /** Void an unpaid invoice and issue a fresh one from the job's current line items. */
  app.post('/invoices/:id/reissue', async (req) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Invoice');
    const org = await loadOrg(pool, auth.orgId);
    const created = await withTx(pool, async (tx) => {
      const inv = await one<{ appointment_id: string | null; status: string }>(tx, 'SELECT appointment_id, status FROM invoices WHERE org_id = $1 AND id = $2 FOR UPDATE', [auth.orgId, id]);
      if (!inv) throw notFound('Invoice');
      if (!inv.appointment_id) throw badRequest('This invoice is not linked to a job');
      const job = await one<{ status: string }>(tx, 'SELECT status FROM appointments WHERE id = $1', [inv.appointment_id]);
      if (job?.status !== 'completed') throw badRequest('Only completed jobs can be invoiced');
      if (inv.status !== 'void') await voidInvoice(tx, auth.orgId, id, 'Reissued with corrected details', auth.userId);
      const fresh = await issueInvoiceForAppointment(tx, org, inv.appointment_id, auth.userId);
      if (!fresh) throw badRequest('The job has no priced items to invoice');
      return fresh;
    });
    return getInvoiceDetail(pool, auth.orgId, created.id);
  });

  /** Issue the invoice for a completed job that doesn't have one yet (e.g. items were added later). */
  app.post('/appointments/:id/invoice', async (req, reply) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Appointment');
    const org = await loadOrg(pool, auth.orgId);
    const result = await withTx(pool, async (tx) => {
      const job = await one<{ status: string }>(tx, 'SELECT status FROM appointments WHERE org_id = $1 AND id = $2 FOR UPDATE', [auth.orgId, id]);
      if (!job) throw notFound('Appointment');
      if (job.status !== 'completed') throw badRequest('Mark the job as completed first');
      const inv = await issueInvoiceForAppointment(tx, org, id, auth.userId);
      if (!inv) throw badRequest('The job has no priced items to invoice');
      return inv;
    });
    return reply.code(result.created ? 201 : 200).send(await getInvoiceDetail(pool, auth.orgId, result.id));
  });

  app.post('/invoices/:id/send', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const auth = requireAdmin(req);
    const id = idParam(req, 'id', 'Invoice');
    const org = await loadOrg(pool, auth.orgId);
    const inv = await getInvoiceDetail(pool, auth.orgId, id);
    if (inv.status === 'void') throw conflict('invoice_void', 'Void invoices cannot be sent');
    const customer = await one<{ email: string | null; email_opt_in: boolean }>(pool, 'SELECT email, email_opt_in FROM customers WHERE id = $1', [inv.customer_id]);
    if (!customer?.email) throw badRequest("This customer doesn't have an email address");
    const balance = inv.total_cents - inv.paid_cents;
    const money = (c: number) => formatMoney(c, org.currency, org.settings.locale);
    const due = DateTime.fromISO(inv.due_date).setLocale(org.settings.locale).toLocaleString(DateTime.DATE_FULL);
    const text = [
      `Hi ${inv.bill_to.name.split(/\s+/)[0]},`,
      `Please find attached invoice ${inv.number} for ${money(inv.total_cents)}.`,
      balance > 0 ? `Amount due: ${money(balance)} by ${due}.` : 'This invoice has been paid in full - thank you!',
      org.settings.invoicing.footer,
    ]
      .filter(Boolean)
      .join('\n\n');
    // Invoices are transactional, so they are sent even if the customer opted out of marketing.
    await enqueue(pool, {
      orgId: auth.orgId,
      kind: 'invoice',
      channel: 'email',
      recipient: customer.email,
      subject: `Invoice ${inv.number} from ${org.name}`,
      body: text,
      customerId: inv.customer_id,
      invoiceId: inv.id,
    });
    return { ok: true, to: customer.email };
  });
}
