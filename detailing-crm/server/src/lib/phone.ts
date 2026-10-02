import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { badRequest } from './errors.js';

/**
 * Normalises user-entered phone numbers ("07700 900123", "+44 7700 900123", "(020) 7946 0958")
 * to E.164 ("+447700900123"), which is what Twilio requires.
 * Returns null for empty input; throws a 400 for numbers that cannot be valid.
 */
export function normalizePhone(input: string | null | undefined, defaultCountry: string): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  const country = (isSupportedCountry(defaultCountry) ? defaultCountry : 'GB') as CountryCode;
  const parsed = parsePhoneNumberFromString(raw, country);
  if (!parsed || !parsed.isValid()) {
    throw badRequest(`"${raw}" is not a valid phone number`, { fields: { phone: 'Enter a valid phone number' } });
  }
  return parsed.number;
}

export function isValidCountry(code: string): boolean {
  return isSupportedCountry(code);
}
