import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAdmin } from '../auth/session.js';
import { LIST_SELECT } from '../appointments/service.js';
import { many, one } from '../db/pool.js';
import { loadOrg } from '../lib/org.js';

interface MonthRow {
  month: string;
  invoiced_cents: number;
  collected_cents: number;
  bookings: number;
  completed: number;
  canceled: number;
  no_shows: number;
  new_customers: number;
}

export function registerReportRoutes(app: FastifyInstance, deps: AppDeps) {
  const { pool } = deps;

  app.get('/reports/dashboard', async (req) => {
    const auth = requireAdmin(req);
    const org = await loadOrg(pool, auth.orgId);
    const { months } = z.object({ months: z.coerce.number().int().min(1).max(24).default(12) }).parse(req.query);
    const tz = org.timezone;
    const now = DateTime.now().setZone(tz);
    const firstMonth = now.startOf('month').minus({ months: months - 1 });
    const rangeStart = firstMonth.toJSDate();
    const rangeStartDate = firstMonth.toISODate();
    const today = now.toISODate();
    const monthStart = now.startOf('month');
    // Month-to-date vs the same number of days last month (comparing a whole previous month to a
    // half-finished current one always looks like a drop).
    const prevStart = monthStart.minus({ months: 1 });
    const prevSameDay = DateTime.min(prevStart.endOf('month'), prevStart.plus({ days: now.day - 1 }).endOf('day'));
    const yearAgo = now.minus({ months: 12 }).toJSDate();

    const series = await many<{ month: string; metric: string; value: number }>(
      pool,
      `SELECT to_char(issue_date, 'YYYY-MM') AS month, 'invoiced' AS metric, sum(total_cents)::int AS value
         FROM invoices WHERE org_id = $1 AND status <> 'void' AND issue_date >= $3::date GROUP BY 1
       UNION ALL
       SELECT to_char(paid_at AT TIME ZONE $2, 'YYYY-MM'), 'collected', sum(amount_cents)::int
         FROM payments WHERE org_id = $1 AND paid_at >= $4 GROUP BY 1
       UNION ALL
       SELECT to_char(start_at AT TIME ZONE $2, 'YYYY-MM'), 'bookings', count(*) FILTER (WHERE status <> 'canceled')::int
         FROM appointments WHERE org_id = $1 AND start_at >= $4 AND start_at < now() + interval '400 days' GROUP BY 1
       UNION ALL
       SELECT to_char(start_at AT TIME ZONE $2, 'YYYY-MM'), 'completed', count(*) FILTER (WHERE status = 'completed')::int
         FROM appointments WHERE org_id = $1 AND start_at >= $4 GROUP BY 1
       UNION ALL
       SELECT to_char(start_at AT TIME ZONE $2, 'YYYY-MM'), 'canceled', count(*) FILTER (WHERE status = 'canceled')::int
         FROM appointments WHERE org_id = $1 AND start_at >= $4 GROUP BY 1
       UNION ALL
       SELECT to_char(start_at AT TIME ZONE $2, 'YYYY-MM'), 'no_shows', count(*) FILTER (WHERE status = 'no_show')::int
         FROM appointments WHERE org_id = $1 AND start_at >= $4 GROUP BY 1
       UNION ALL
       SELECT to_char(created_at AT TIME ZONE $2, 'YYYY-MM'), 'new_customers', count(*)::int
         FROM customers WHERE org_id = $1 AND created_at >= $4 GROUP BY 1`,
      [auth.orgId, tz, rangeStartDate, rangeStart],
    );
    const monthly: MonthRow[] = [];
    for (let i = 0; i < months; i++) {
      const key = firstMonth.plus({ months: i }).toFormat('yyyy-LL');
      const row: MonthRow = { month: key, invoiced_cents: 0, collected_cents: 0, bookings: 0, completed: 0, canceled: 0, no_shows: 0, new_customers: 0 };
      for (const s of series.filter((x) => x.month === key)) {
        const field = (s.metric === 'invoiced' || s.metric === 'collected' ? `${s.metric}_cents` : s.metric) as keyof MonthRow;
        (row[field] as number) = s.value;
      }
      monthly.push(row);
    }

    const [kpi, retention, topCustomers, topServices, technicians, lowStock, todayJobs] = await Promise.all([
      one<Record<string, number>>(
        pool,
        `SELECT
           (SELECT COALESCE(sum(total_cents), 0) FROM invoices WHERE org_id = $1 AND status <> 'void' AND issue_date >= $2::date)::int AS invoiced_mtd,
           (SELECT COALESCE(sum(total_cents), 0) FROM invoices WHERE org_id = $1 AND status <> 'void' AND issue_date >= $3::date AND issue_date <= $4::date)::int AS invoiced_prev_mtd,
           (SELECT COALESCE(sum(amount_cents), 0) FROM payments WHERE org_id = $1 AND paid_at >= $5)::int AS collected_mtd,
           (SELECT count(*) FROM appointments WHERE org_id = $1 AND status <> 'canceled' AND start_at >= $5 AND start_at < $6)::int AS bookings_this_month,
           (SELECT count(*) FROM appointments WHERE org_id = $1 AND status IN ('pending', 'confirmed') AND start_at > now())::int AS upcoming,
           (SELECT COALESCE(sum(total_cents - paid_cents), 0) FROM invoices WHERE org_id = $1 AND status = 'open')::int AS outstanding_cents,
           (SELECT COALESCE(sum(total_cents - paid_cents), 0) FROM invoices WHERE org_id = $1 AND status = 'open' AND due_date < $7::date)::int AS overdue_cents,
           (SELECT COALESCE(round(avg(total_cents)), 0) FROM invoices WHERE org_id = $1 AND status <> 'void' AND issue_date >= $7::date - 90)::int AS avg_job_cents,
           (SELECT count(*) FROM customers WHERE org_id = $1 AND archived_at IS NULL)::int AS customers`,
        [
          auth.orgId,
          monthStart.toISODate(),
          prevStart.toISODate(),
          prevSameDay.toISODate(),
          monthStart.toJSDate(),
          monthStart.plus({ months: 1 }).toJSDate(),
          today,
        ],
      ),
      // Repeat-customer rate over the last 12 months: of the customers who had a completed job, how
      // many came back for another one.
      one<{ customers: number; repeat: number; no_show_rate: number }>(
        pool,
        `SELECT count(*)::int AS customers, count(*) FILTER (WHERE n >= 2)::int AS repeat,
                (SELECT CASE WHEN count(*) = 0 THEN 0 ELSE round(100.0 * count(*) FILTER (WHERE status = 'no_show') / count(*), 1) END
                   FROM appointments WHERE org_id = $1 AND start_at >= $2 AND start_at < now() AND status IN ('completed', 'no_show'))::float AS no_show_rate
           FROM (SELECT customer_id, count(*) AS n FROM appointments
                  WHERE org_id = $1 AND status = 'completed' AND start_at >= $2 GROUP BY customer_id) t`,
        [auth.orgId, yearAgo],
      ),
      many(
        pool,
        `SELECT c.id, c.name, count(*)::int AS invoices, sum(i.total_cents)::int AS revenue_cents
           FROM invoices i JOIN customers c ON c.org_id = i.org_id AND c.id = i.customer_id
          WHERE i.org_id = $1 AND i.status <> 'void' AND i.issue_date >= $2::date
          GROUP BY c.id, c.name ORDER BY revenue_cents DESC, invoices DESC LIMIT 10`,
        [auth.orgId, rangeStartDate],
      ),
      many(
        pool,
        `SELECT COALESCE(s.name, i.name) AS name, count(DISTINCT a.id)::int AS jobs, sum(i.quantity * i.unit_price_cents)::int AS revenue_cents
           FROM appointment_items i
           JOIN appointments a ON a.id = i.appointment_id
           LEFT JOIN services s ON s.id = i.service_id
          WHERE a.org_id = $1 AND a.status = 'completed' AND a.start_at >= $2
          GROUP BY COALESCE(s.name, i.name) ORDER BY jobs DESC, revenue_cents DESC LIMIT 10`,
        [auth.orgId, rangeStart],
      ),
      // Job value is shared equally between technicians on the job.
      many(
        pool,
        `SELECT u.id, u.name, u.color, count(*)::int AS jobs,
                COALESCE(sum(v.value / v.techs), 0)::int AS revenue_cents,
                COALESCE(round(avg(EXTRACT(EPOCH FROM (a.completed_at - a.started_at)) / 60) FILTER (WHERE a.started_at IS NOT NULL AND a.completed_at > a.started_at)), 0)::int AS avg_minutes
           FROM appointment_technicians t
           JOIN users u ON u.id = t.user_id
           JOIN appointments a ON a.id = t.appointment_id
           CROSS JOIN LATERAL (
             SELECT GREATEST(0, COALESCE((SELECT sum(quantity * unit_price_cents) FROM appointment_items WHERE appointment_id = a.id), 0) - a.discount_cents) AS value,
                    (SELECT count(*) FROM appointment_technicians WHERE appointment_id = a.id) AS techs
           ) v
          WHERE a.org_id = $1 AND a.status = 'completed' AND a.start_at >= $2
          GROUP BY u.id, u.name, u.color ORDER BY jobs DESC`,
        [auth.orgId, rangeStart],
      ),
      many(pool, `SELECT id, name, quantity, unit, low_threshold FROM inventory_items WHERE org_id = $1 AND quantity <= low_threshold ORDER BY name`, [auth.orgId]),
      many(pool, `${LIST_SELECT} WHERE a.org_id = $1 AND a.start_at >= $2 AND a.start_at < $3 ORDER BY a.start_at`, [
        auth.orgId,
        now.startOf('day').toJSDate(),
        now.startOf('day').plus({ days: 1 }).toJSDate(),
      ]),
    ]);

    return {
      generated_at: new Date().toISOString(),
      timezone: tz,
      currency: org.currency,
      monthly,
      kpi,
      retention: {
        customers: retention?.customers ?? 0,
        repeat_customers: retention?.repeat ?? 0,
        repeat_rate: retention?.customers ? Math.round((1000 * (retention.repeat ?? 0)) / retention.customers) / 10 : 0,
        no_show_rate: retention?.no_show_rate ?? 0,
      },
      top_customers: topCustomers,
      top_services: topServices,
      technicians,
      low_stock: lowStock,
      today: todayJobs,
    };
  });
}
