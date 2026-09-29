import type { Category } from "./types";

const moneyFormatters = new Map<string, Intl.NumberFormat>();

export function formatMoney(amount: number, currency: string): string {
  let formatter = moneyFormatters.get(currency);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat(undefined, { style: "currency", currency });
    } catch {
      // Unknown/invalid ISO code from OCR: fall back to a plain number with the code.
      return `${currency} ${amount.toFixed(2)}`;
    }
    moneyFormatters.set(currency, formatter);
  }
  return formatter.format(amount);
}

/** Rounds to cents to avoid floating point drift when summing prices. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function sumMoney(values: number[]): number {
  return roundMoney(values.reduce((acc, v) => acc + Math.round(v * 100), 0) / 100);
}

/** Parses user input like "1,99" or "$ 12.50". Returns null for empty or invalid input. */
export function parseAmount(input: string): number | null {
  let cleaned = input.replace(/[^\d.,-]/g, "");
  // Whichever separator comes last is the decimal one: "1,234.50" and "1.234,50" both work.
  const decimalIndex = Math.max(cleaned.lastIndexOf("."), cleaned.lastIndexOf(","));
  if (decimalIndex >= 0) {
    cleaned = cleaned.slice(0, decimalIndex).replace(/[.,]/g, "") + "." + cleaned.slice(decimalIndex + 1);
  }
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function todayIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function formatDate(iso: string): string {
  if (!isValidIsoDate(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function formatQuantity(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toFixed(3).replace(/0+$/, "");
}

const CATEGORY_LABELS: Record<Category, string> = {
  groceries: "Groceries",
  produce: "Produce",
  meat_seafood: "Meat & Seafood",
  dairy: "Dairy",
  bakery: "Bakery",
  beverages: "Beverages",
  snacks: "Snacks",
  household: "Household",
  personal_care: "Personal Care",
  health: "Health",
  baby: "Baby",
  pet: "Pet",
  electronics: "Electronics",
  clothing: "Clothing",
  dining: "Dining",
  fuel: "Fuel",
  other: "Other",
};

export function categoryLabel(category: Category): string {
  return CATEGORY_LABELS[category] ?? "Other";
}

export function greeting(date = new Date()): string {
  const h = date.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}
