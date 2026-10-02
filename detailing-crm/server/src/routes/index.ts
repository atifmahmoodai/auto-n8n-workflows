import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { registerAppointmentRoutes } from './appointments.js';
import { registerAuthRoutes } from './auth.js';
import { registerCustomerRoutes } from './customers.js';
import { registerInventoryRoutes } from './inventory.js';
import { registerInvoiceRoutes } from './invoices.js';
import { registerNotificationRoutes } from './notifications.js';
import { registerReportRoutes } from './reports.js';
import { registerServiceRoutes } from './services.js';
import { registerSettingsRoutes } from './settings.js';
import { registerUserRoutes } from './users.js';
import { registerWebhookRoutes } from './webhooks.js';

export function registerRoutes(api: FastifyInstance, deps: AppDeps & { scheduler: Scheduler }) {
  registerAuthRoutes(api, deps);
  registerUserRoutes(api, deps);
  registerCustomerRoutes(api, deps);
  registerServiceRoutes(api, deps);
  registerAppointmentRoutes(api, deps);
  registerInvoiceRoutes(api, deps);
  registerInventoryRoutes(api, deps);
  registerReportRoutes(api, deps);
  registerSettingsRoutes(api, deps);
  registerNotificationRoutes(api, deps);
  registerWebhookRoutes(api, deps);
}
