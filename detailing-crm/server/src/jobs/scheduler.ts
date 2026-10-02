import type { FastifyBaseLogger } from 'fastify';
import { extendAllSeries } from '../appointments/service.js';
import type { Config } from '../config.js';
import type { Pool } from '../db/pool.js';
import { renderInvoicePdf } from '../invoices/pdf.js';
import { getInvoiceDetail } from '../invoices/service.js';
import { loadOrg } from '../lib/org.js';
import type { Storage } from '../lib/storage.js';
import { planScheduledMessages } from '../notifications/planner.js';
import type { Providers } from '../notifications/providers.js';
import { processOutbox, recoverStuck, type WorkerDeps } from '../notifications/worker.js';

export interface RunResult {
  series_occurrences: number;
  reminders: number;
  followups: number;
  messages_processed: number;
}

export interface Scheduler {
  start(): void;
  stop(): Promise<void>;
  /** Runs one full cycle now. Concurrent callers share the cycle already in progress. */
  runOnce(now?: Date): Promise<RunResult>;
}

export function createScheduler(deps: { pool: Pool; providers: Providers; storage: Storage; config: Config; log: FastifyBaseLogger }): Scheduler {
  const { pool, config, log } = deps;
  const env = { publicUrl: config.PUBLIC_URL, secret: config.APP_SECRET };
  const worker: WorkerDeps = {
    pool,
    providers: deps.providers,
    log,
    renderInvoicePdf: async (orgId, invoiceId) => {
      const [invoice, org] = await Promise.all([getInvoiceDetail(pool, orgId, invoiceId), loadOrg(pool, orgId)]);
      return { filename: `${invoice.number}.pdf`, content: await renderInvoicePdf(invoice, org, deps.storage) };
    },
  };
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<RunResult> | null = null;
  let lastCleanup = 0;

  async function cycle(now: Date): Promise<RunResult> {
    const series = await extendAllSeries(pool, now);
    const planned = await planScheduledMessages(pool, env, now);
    await recoverStuck(pool);
    let processed = 0;
    for (let i = 0; i < 20; i++) {
      const n = await processOutbox(worker);
      processed += n;
      if (n === 0) break;
    }
    if (Date.now() - lastCleanup > 60 * 60 * 1000) {
      lastCleanup = Date.now();
      await pool.query('DELETE FROM sessions WHERE expires_at < now()');
      await pool.query(`DELETE FROM auth_tokens WHERE expires_at < now() - interval '7 days'`);
    }
    return { series_occurrences: series, reminders: planned.reminders, followups: planned.followups, messages_processed: processed };
  }

  function runOnce(now: Date = new Date()): Promise<RunResult> {
    if (!running) {
      running = cycle(now).finally(() => {
        running = null;
      });
    }
    return running;
  }

  return {
    start() {
      if (timer) return;
      const tick = () =>
        runOnce().catch((err) => {
          log.error({ err }, 'scheduler cycle failed');
        });
      timer = setInterval(tick, config.SCHEDULER_INTERVAL_SECONDS * 1000);
      timer.unref();
      setTimeout(tick, 3000).unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (running) await running.catch(() => undefined);
    },
    runOnce,
  };
}
