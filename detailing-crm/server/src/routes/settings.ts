import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAdmin } from '../auth/session.js';
import { withTx } from '../db/pool.js';
import { logActivity } from '../lib/activity.js';
import { badRequest } from '../lib/errors.js';
import { loadOrg } from '../lib/org.js';
import { isValidCountry, normalizePhone } from '../lib/phone.js';
import { settingsSchema } from '../lib/settings.js';
import { TEMPLATE_PLACEHOLDERS } from '../lib/template.js';
import { isValidZone } from '../lib/time.js';
import { ProviderError } from '../notifications/providers.js';
import { validCurrency } from './auth.js';

type Json = Record<string, unknown>;

function deepMerge(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' ? deepMerge(cur as Json, v as Json) : v;
  }
  return out;
}

export function registerSettingsRoutes(app: FastifyInstance, deps: AppDeps) {
  const { pool, providers } = deps;

  async function payload(orgId: string) {
    const org = await loadOrg(pool, orgId);
    return {
      org: { name: org.name, timezone: org.timezone, currency: org.currency, country: org.country },
      settings: org.settings,
      providers: { sms: providers.smsEnabled, email: providers.emailEnabled },
      placeholders: TEMPLATE_PLACEHOLDERS,
    };
  }

  app.get('/settings', async (req) => payload(requireAdmin(req).orgId));

  app.put('/settings', async (req) => {
    const auth = requireAdmin(req);
    const body = z
      .object({
        org: z
          .object({
            name: z.string().trim().min(1).max(120).optional(),
            timezone: z.string().refine(isValidZone, 'Unknown time zone').optional(),
            currency: z.string().toUpperCase().refine(validCurrency, 'Unknown currency code').optional(),
            country: z.string().toUpperCase().refine(isValidCountry, 'Unknown country code').optional(),
          })
          .default({}),
        settings: z.record(z.unknown()).default({}),
      })
      .parse(req.body);
    await withTx(pool, async (tx) => {
      const cur = await tx.query<{ settings: Json; country: string }>('SELECT settings, country FROM organizations WHERE id = $1 FOR UPDATE', [auth.orgId]);
      const merged = deepMerge(cur.rows[0]?.settings ?? {}, body.settings);
      const settings = settingsSchema.parse(merged); // throws 400 with field paths on bad values
      const country = body.org.country ?? cur.rows[0]?.country ?? 'GB';
      if (settings.business.phone) settings.business.phone = normalizePhone(settings.business.phone, country) ?? '';
      await tx.query(
        `UPDATE organizations SET name = COALESCE($2, name), timezone = COALESCE($3, timezone), currency = COALESCE($4, currency),
                country = COALESCE($5, country), settings = $6, updated_at = now()
          WHERE id = $1`,
        [auth.orgId, body.org.name ?? null, body.org.timezone ?? null, body.org.currency ?? null, body.org.country ?? null, JSON.stringify(settings)],
      );
      await logActivity(tx, {
        orgId: auth.orgId,
        userId: auth.userId,
        entityType: 'settings',
        entityId: auth.orgId,
        action: 'updated',
        details: { sections: [...Object.keys(body.org), ...Object.keys(body.settings)] },
      });
    });
    return payload(auth.orgId);
  });

  /** Sends a real test message immediately (bypassing the queue) to check provider credentials. */
  app.post('/settings/test-message', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const auth = requireAdmin(req);
    const org = await loadOrg(pool, auth.orgId);
    const body = z.object({ channel: z.enum(['sms', 'email']), to: z.string().trim().min(3).max(200) }).parse(req.body);
    try {
      if (body.channel === 'sms') {
        const to = normalizePhone(body.to, org.country);
        if (!to) throw badRequest('Enter a phone number');
        const r = await providers.sendSms(to, `Test message from ${org.name}. SMS is working.`);
        return { status: r.status, to };
      }
      const to = z.string().email('Enter a valid email address').parse(body.to);
      const r = await providers.sendEmail({
        to,
        subject: `Test email from ${org.name}`,
        text: 'Email is working.',
        fromName: org.name,
        replyTo: org.settings.business.email || null,
      });
      return { status: r.status, to };
    } catch (err) {
      if (err instanceof ProviderError) throw badRequest(`The provider rejected the message: ${err.message}`);
      throw err;
    }
  });
}
