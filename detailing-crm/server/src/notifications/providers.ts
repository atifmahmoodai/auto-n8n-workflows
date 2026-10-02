import type { Config } from '../config.js';

export interface SendResult {
  status: 'sent' | 'simulated';
  providerId?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string | null;
  replyTo?: string | null;
  fromName?: string | null;
  headers?: Record<string, string>;
  attachments?: Array<{ filename: string; content: Buffer; type: string }>;
}

/** permanent=true means retrying cannot help (bad number, unsubscribed, bad credentials). */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly permanent: boolean,
    public readonly providerCode?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface Providers {
  smsEnabled: boolean;
  emailEnabled: boolean;
  sendSms(to: string, body: string): Promise<SendResult>;
  sendEmail(msg: EmailMessage): Promise<SendResult>;
}

type FetchFn = typeof fetch;

export function createProviders(config: Config, fetchFn: FetchFn = fetch): Providers {
  const statusCallback = `${config.PUBLIC_URL}/api/webhooks/twilio/status`;

  async function sendSms(to: string, body: string): Promise<SendResult> {
    if (!config.twilioEnabled) return { status: 'simulated' };
    const form = new URLSearchParams({ To: to, Body: body });
    if (config.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', config.TWILIO_MESSAGING_SERVICE_SID);
    else form.set('From', config.TWILIO_FROM_NUMBER ?? '');
    if (/^https:\/\//.test(config.PUBLIC_URL)) form.set('StatusCallback', statusCallback);
    let res: Response;
    try {
      res = await fetchFn(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.TWILIO_ACCOUNT_SID ?? '')}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form,
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (err) {
      throw new ProviderError(`Twilio unreachable: ${(err as Error).message}`, false);
    }
    const payload = (await res.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
    if (!res.ok) {
      const code = payload.code ? String(payload.code) : undefined;
      // 4xx (bad number, unsubscribed recipient 21610, bad credentials) won't succeed on retry; 429/5xx might.
      const permanent = res.status !== 429 && res.status < 500;
      throw new ProviderError(
        `Twilio ${res.status}${code ? ` (${code})` : ''}: ${payload.message ?? 'request failed'}`,
        permanent,
        code,
      );
    }
    return { status: 'sent', providerId: payload.sid };
  }

  async function sendEmail(msg: EmailMessage): Promise<SendResult> {
    if (!config.sendgridEnabled) return { status: 'simulated' };
    const content: Array<{ type: string; value: string }> = [{ type: 'text/plain', value: msg.text }];
    if (msg.html) content.push({ type: 'text/html', value: msg.html });
    const body = {
      personalizations: [{ to: [{ email: msg.to }] }],
      from: { email: config.EMAIL_FROM, name: msg.fromName || config.EMAIL_FROM_NAME },
      ...(msg.replyTo ? { reply_to: { email: msg.replyTo } } : {}),
      subject: msg.subject,
      content,
      ...(msg.headers && Object.keys(msg.headers).length ? { headers: msg.headers } : {}),
      ...(msg.attachments?.length
        ? {
            attachments: msg.attachments.map((a) => ({
              content: a.content.toString('base64'),
              filename: a.filename,
              type: a.type,
              disposition: 'attachment',
            })),
          }
        : {}),
    };
    let res: Response;
    try {
      res = await fetchFn('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new ProviderError(`SendGrid unreachable: ${(err as Error).message}`, false);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      const permanent = res.status !== 429 && res.status < 500;
      throw new ProviderError(`SendGrid ${res.status}: ${text || 'request failed'}`, permanent, String(res.status));
    }
    return { status: 'sent', providerId: res.headers.get('x-message-id') ?? undefined };
  }

  return { smsEnabled: config.twilioEnabled, emailEnabled: config.sendgridEnabled, sendSms, sendEmail };
}
