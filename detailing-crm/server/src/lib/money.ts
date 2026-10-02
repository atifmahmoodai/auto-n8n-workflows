export interface LineItem {
  quantity: number;
  unit_price_cents: number;
}

export interface Totals {
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  total_cents: number;
}

/** Round half away from zero (commercial rounding) on integer minor units. */
function roundHalfUp(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

/**
 * Invoice arithmetic in integer minor units.
 * - pricesIncludeTax (typical UK consumer pricing): the total is the discounted subtotal and the tax
 *   is the portion contained in it: tax = total * rate / (1 + rate).
 * - otherwise tax is added on top of the discounted subtotal.
 * The discount can never exceed the subtotal.
 */
export function computeTotals(
  items: LineItem[],
  discountCents: number,
  taxRateBp: number,
  pricesIncludeTax: boolean,
): Totals {
  const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unit_price_cents, 0);
  const discount = Math.min(Math.max(0, discountCents), subtotal);
  const net = subtotal - discount;
  if (taxRateBp <= 0) return { subtotal_cents: subtotal, discount_cents: discount, tax_cents: 0, total_cents: net };
  if (pricesIncludeTax) {
    const tax = roundHalfUp((net * taxRateBp) / (10_000 + taxRateBp));
    return { subtotal_cents: subtotal, discount_cents: discount, tax_cents: tax, total_cents: net };
  }
  const tax = roundHalfUp((net * taxRateBp) / 10_000);
  return { subtotal_cents: subtotal, discount_cents: discount, tax_cents: tax, total_cents: net + tax };
}

export function formatMoney(cents: number, currency: string, locale = 'en-GB'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}
