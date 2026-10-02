import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { signPayload, verifySignedPayload, hashPassword, verifyPassword } from '../src/lib/crypto.js';
import { toCsv } from '../src/lib/csv.js';
import { computeTotals } from '../src/lib/money.js';
import { normalizePhone } from '../src/lib/phone.js';
import { parseSettings } from '../src/lib/settings.js';
import { renderTemplate } from '../src/lib/template.js';
import { deferOutOfQuietHours, occurrenceStart } from '../src/lib/time.js';
import { twilioSignature } from '../src/routes/webhooks.js';

describe('money (integer pence, v1 used floats)', () => {
  it('adds amounts exactly', () => {
    const t = computeTotals([{ quantity: 1, unit_price_cents: 10 }, { quantity: 1, unit_price_cents: 20 }], 0, 0, true);
    expect(t.total_cents).toBe(30); // 0.1 + 0.2 = 0.30000000000000004 in floats
  });
  it('extracts VAT from inclusive prices', () => {
    expect(computeTotals([{ quantity: 2, unit_price_cents: 5000 }], 1000, 2000, true)).toEqual({
      subtotal_cents: 10000,
      discount_cents: 1000,
      tax_cents: 1500,
      total_cents: 9000,
    });
  });
  it('adds VAT on top of exclusive prices and rounds half up', () => {
    expect(computeTotals([{ quantity: 1, unit_price_cents: 1234 }], 0, 2000, false)).toEqual({
      subtotal_cents: 1234,
      discount_cents: 0,
      tax_cents: 247, // 246.8
      total_cents: 1481,
    });
  });
  it('never lets a discount exceed the subtotal', () => {
    expect(computeTotals([{ quantity: 1, unit_price_cents: 500 }], 9999, 2000, true)).toMatchObject({ discount_cents: 500, total_cents: 0, tax_cents: 0 });
  });
});

describe('time', () => {
  const at = (local: string) => DateTime.fromISO(local, { zone: 'Europe/London' });
  it('defers sends out of quiet hours that wrap midnight', () => {
    expect(deferOutOfQuietHours(at('2027-03-09T22:30'), '20:00', '08:00').toISO()).toBe(at('2027-03-10T08:00').toISO());
    expect(deferOutOfQuietHours(at('2027-03-10T06:15'), '20:00', '08:00').toISO()).toBe(at('2027-03-10T08:00').toISO());
    expect(deferOutOfQuietHours(at('2027-03-10T12:00'), '20:00', '08:00').toISO()).toBe(at('2027-03-10T12:00').toISO());
    expect(deferOutOfQuietHours(at('2027-03-10T23:00'), '00:00', '00:00').toISO()).toBe(at('2027-03-10T23:00').toISO());
  });
  it('computes occurrences from the anchor (no drift after short months, DST-safe)', () => {
    const s = (i: number) => occurrenceStart('2027-01-31T09:30:00', 'Europe/London', 'monthly', 1, i).toFormat('yyyy-LL-dd HH:mm');
    expect([0, 1, 2, 3].map(s)).toEqual(['2027-01-31 09:30', '2027-02-28 09:30', '2027-03-31 09:30', '2027-04-30 09:30']);
    const w = (i: number) => occurrenceStart('2027-03-23T10:00:00', 'Europe/London', 'weekly', 1, i);
    expect(w(0).toUTC().toFormat('HH:mm')).toBe('10:00'); // GMT
    expect(w(1).toUTC().toFormat('HH:mm')).toBe('09:00'); // BST after 28 March
    expect(w(1).toFormat('HH:mm')).toBe('10:00');
  });
});

describe('helpers', () => {
  it('renders templates and leaves unknown placeholders visible', () => {
    expect(renderTemplate('Hi {customer_first_name}, {unknown}!  See   you {date}', { customer_first_name: 'Jo', date: 'Friday' })).toBe(
      'Hi Jo, {unknown}! See you Friday',
    );
  });
  it('writes safe CSV', () => {
    expect(toCsv(['a', 'b'], [['=1+1', 'x,"y"'], [null, -5]])).toBe(`\uFEFFa,b\r\n'=1+1,"x,""y"""\r\n,-5\r\n`);
  });
  it('normalises phone numbers per country', () => {
    expect(normalizePhone('07911 123456', 'GB')).toBe('+447911123456');
    expect(normalizePhone('(415) 555-2671', 'US')).toBe('+14155552671');
    expect(normalizePhone('  ', 'GB')).toBeNull();
    expect(() => normalizePhone('0791', 'GB')).toThrow(/not a valid phone number/);
  });
  it('matches Twilio’s documented request signature', () => {
    const sig = twilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', {
      CallSid: 'CA1234567890ABCDE',
      Caller: '+12349013030',
      Digits: '1234',
      From: '+12349013030',
      To: '+18005551212',
    });
    expect(sig).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  });
  it('signs and verifies unsubscribe tokens; tampering fails', () => {
    const token = signPayload('secret', { o: 'org', c: 'cust' });
    expect(verifySignedPayload('secret', token)).toEqual({ o: 'org', c: 'cust' });
    expect(verifySignedPayload('other', token)).toBeNull();
    expect(verifySignedPayload('secret', `${token.slice(0, -2)}xx`)).toBeNull();
  });
  it('hashes passwords with scrypt and verifies them', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('anything', null)).toBe(false);
  });
  it('keeps valid settings sections when one stored section is invalid', () => {
    const s = parseSettings({ invoicing: { tax_rate_bp: 2000 }, notifications: { reminder_hours: 'banana' } });
    expect(s.invoicing.tax_rate_bp).toBe(2000);
    expect(s.notifications.reminder_hours).toBe(24);
  });
});

describe('configuration', () => {
  const base = { DATABASE_URL: 'postgres://u@h/db' };
  it('fails fast with every problem listed', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'mysql://x', TWILIO_ACCOUNT_SID: 'AC1' })).toThrow(
      /DATABASE_URL[\s\S]*APP_SECRET[\s\S]*TWILIO_AUTH_TOKEN/,
    );
  });
  it('treats empty variables as unset and derives https behaviour from PUBLIC_URL', () => {
    const c = loadConfig({ ...base, TWILIO_ACCOUNT_SID: '', PUBLIC_URL: 'https://app.example.com/' });
    expect(c.twilioEnabled).toBe(false);
    expect(c.httpsOnly).toBe(true);
    expect(c.PUBLIC_URL).toBe('https://app.example.com');
    expect(loadConfig(base).httpsOnly).toBe(false);
  });
});
