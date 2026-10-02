import { buildApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { loadConfig, type Config } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { createLocalStorage } from './lib/storage.js';
import { createProviders } from './notifications/providers.js';

async function main() {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const pool = createPool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_MAX, ssl: config.DATABASE_SSL });
  // An idle client losing its connection emits on the pool; without a listener that would crash the process.
  pool.on('error', (err) => console.error('postgres pool error:', err.message));

  await migrate(pool, (msg) => console.warn(msg));

  const app = await buildApp({
    config,
    pool,
    storage: createLocalStorage(config.UPLOAD_DIR),
    providers: createProviders(config),
  });
  await bootstrap(pool, config, app.log);

  if (config.isProduction && !config.httpsOnly) {
    app.log.warn('PUBLIC_URL is not https:// - run behind TLS in production so sessions and customer data are encrypted in transit');
  }
  if (!config.twilioEnabled) app.log.warn('Twilio is not configured: SMS messages will be simulated (logged, not sent)');
  if (!config.sendgridEnabled) app.log.warn('SendGrid is not configured: emails will be simulated (logged, not sent)');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      app.log.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 25_000);
    force.unref();
    try {
      await app.close(); // stops accepting connections, finishes in-flight requests, stops the scheduler
      await pool.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => app.log.error({ err }, 'unhandled promise rejection'));
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'uncaught exception - exiting');
    process.exit(1);
  });

  await app.listen({ host: config.HOST, port: config.PORT });
  if (config.SCHEDULER_ENABLED) app.scheduler.start();
}

main().catch((err) => {
  console.error('failed to start:', err);
  process.exit(1);
});
