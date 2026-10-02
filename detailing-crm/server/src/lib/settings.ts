import { z } from 'zod';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)');
const optionalText = (max: number) => z.string().trim().max(max).default('');

/**
 * Per-organisation settings stored as JSONB. Every field has a default, so older rows keep working
 * when new settings are added: parseSettings() always returns a complete object.
 */
export const settingsSchema = z.object({
  business: z
    .object({
      email: z.union([z.literal(''), z.string().trim().email()]).default(''),
      phone: optionalText(40),
      address: optionalText(300),
      website: optionalText(200),
      vat_number: optionalText(40),
    })
    .default({}),
  locale: z.string().trim().min(2).max(20).default('en-GB'),
  booking: z
    .object({
      default_status: z.enum(['pending', 'confirmed']).default('confirmed'),
      default_duration_min: z.number().int().min(5).max(1440).default(60),
    })
    .default({}),
  notifications: z
    .object({
      confirmation_enabled: z.boolean().default(true),
      reminder_enabled: z.boolean().default(true),
      reminder_hours: z.number().int().min(1).max(168).default(24),
      followup_enabled: z.boolean().default(true),
      followup_hours: z.number().int().min(0).max(720).default(2),
      reschedule_enabled: z.boolean().default(true),
      cancellation_enabled: z.boolean().default(true),
      quiet_hours_start: hhmm.default('20:00'),
      quiet_hours_end: hhmm.default('08:00'),
      review_link: z.union([z.literal(''), z.string().trim().url()]).default(''),
      followup_offer: optionalText(200).default('10% off your next detail - just mention this message.'),
      low_stock_alerts: z.boolean().default(true),
    })
    .default({}),
  templates: z
    .object({
      confirmation: z
        .string()
        .max(1000)
        .default(
          'Hi {customer_first_name}, your {service} with {business_name} is booked for {datetime}. Need to change it? Call {business_phone}.',
        ),
      reminder: z
        .string()
        .max(1000)
        .default(
          'Reminder: {customer_first_name}, your {service} with {business_name} is on {datetime}. See you then!',
        ),
      rescheduled: z
        .string()
        .max(1000)
        .default(
          'Hi {customer_first_name}, your {service} with {business_name} has moved to {datetime}. Questions? Call {business_phone}.',
        ),
      canceled: z
        .string()
        .max(1000)
        .default(
          'Hi {customer_first_name}, your {service} with {business_name} on {datetime} has been cancelled. Call {business_phone} to rebook.',
        ),
      followup: z
        .string()
        .max(1000)
        .default(
          'Thanks for choosing {business_name}, {customer_first_name}! We would love a quick review: {review_link} {offer}',
        ),
    })
    .default({}),
  invoicing: z
    .object({
      prefix: z
        .string()
        .trim()
        .max(12)
        .regex(/^[A-Za-z0-9\-_/]*$/, 'Letters, numbers, - _ / only')
        .default('INV-'),
      tax_rate_bp: z.number().int().min(0).max(10000).default(0),
      prices_include_tax: z.boolean().default(true),
      payment_terms_days: z.number().int().min(0).max(120).default(0),
      footer: optionalText(1000).default('Thank you for your business!'),
    })
    .default({}),
});

export type OrgSettings = z.infer<typeof settingsSchema>;

/**
 * Settings from the database with defaults filled in. Each section is parsed independently, so one
 * invalid stored value only resets its own section instead of the whole configuration.
 */
export function parseSettings(raw: unknown): OrgSettings {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const [key, section] of Object.entries(settingsSchema.shape)) {
    const parsed = section.safeParse(stored[key]);
    out[key] = parsed.success ? parsed.data : section.parse(undefined);
  }
  return out as OrgSettings;
}

export const DEFAULT_SETTINGS: OrgSettings = settingsSchema.parse({});
