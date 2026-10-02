import { DateTime, IANAZone } from 'luxon';
import { badRequest } from './errors.js';

export type Freq = 'weekly' | 'monthly';

export function isValidZone(tz: string): boolean {
  return IANAZone.isValidZone(tz);
}

export function toDateTime(value: Date | string, tz: string): DateTime {
  const dt = typeof value === 'string' ? DateTime.fromISO(value, { zone: 'utc' }) : DateTime.fromJSDate(value);
  return dt.setZone(tz);
}

/** Parses an ISO instant (must carry Z or an offset) into a Date; 400 on garbage. */
export function parseInstant(value: string, field = 'date'): Date {
  const dt = DateTime.fromISO(value, { setZone: true });
  if (!dt.isValid || !/(Z|[+-]\d\d:?\d\d)$/i.test(value))
    throw badRequest(`${field} must be an ISO-8601 timestamp with a time zone`);
  return dt.toJSDate();
}

/** "2026-10-06T10:00" (wall clock in tz) -> luxon DateTime in tz. Times inside a DST gap move forward. */
export function fromLocal(local: string, tz: string): DateTime {
  const dt = DateTime.fromISO(local, { zone: tz });
  if (!dt.isValid) throw badRequest(`Invalid local date/time "${local}"`);
  return dt;
}

/** Wall-clock representation used for appointment_series.anchor_local ("YYYY-MM-DDTHH:mm:ss"). */
export function toLocalString(dt: DateTime): string {
  return dt.toFormat("yyyy-LL-dd'T'HH:mm:ss");
}

/**
 * Start of occurrence #index of a series, computed from the anchor each time (never by repeated
 * addition) so monthly series on the 31st come back to the 31st after a short month, and the
 * wall-clock time is preserved across daylight-saving changes.
 */
export function occurrenceStart(
  anchorLocal: string,
  tz: string,
  freq: Freq,
  interval: number,
  index: number,
): DateTime {
  const anchor = fromLocal(anchorLocal.replace(' ', 'T'), tz);
  return freq === 'weekly' ? anchor.plus({ weeks: interval * index }) : anchor.plus({ months: interval * index });
}

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Moves a send time out of quiet hours (e.g. 20:00–08:00, which wraps midnight) to the end of the
 * quiet period. Returns the time unchanged when it is already inside the allowed window.
 */
export function deferOutOfQuietHours(at: DateTime, quietStart: string, quietEnd: string): DateTime {
  const start = minutesOfDay(quietStart);
  const end = minutesOfDay(quietEnd);
  if (start === end) return at; // quiet hours disabled
  const now = at.hour * 60 + at.minute;
  const inQuiet = start < end ? now >= start && now < end : now >= start || now < end;
  if (!inQuiet) return at;
  let target = at.set({ hour: Math.floor(end / 60), minute: end % 60, second: 0, millisecond: 0 });
  if (target <= at) target = target.plus({ days: 1 });
  return target;
}

export function formatForCustomer(
  value: Date,
  tz: string,
  locale: string,
): { date: string; time: string; datetime: string } {
  const dt = DateTime.fromJSDate(value).setZone(tz).setLocale(locale);
  const date = dt.toLocaleString({ weekday: 'long', day: 'numeric', month: 'long' });
  const time = dt.toLocaleString(DateTime.TIME_SIMPLE);
  return { date, time, datetime: `${date} at ${time}` };
}

/** Today's date in the organisation's zone as YYYY-MM-DD. */
export function localToday(tz: string, now: Date = new Date()): string {
  return DateTime.fromJSDate(now).setZone(tz).toISODate() ?? '';
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value).isValid;
}
