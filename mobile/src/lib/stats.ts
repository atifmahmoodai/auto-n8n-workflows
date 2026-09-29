import { sumMoney } from "./format";
import type { ReceiptSummary } from "./types";

export type MonthStats = {
  currency: string;
  thisMonth: number;
  lastMonth: number;
  receiptCount: number;
  otherCurrencies: number;
};

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Spending for the current and previous month in the user's most used currency. */
export function monthStats(receipts: ReceiptSummary[], now = new Date()): MonthStats | null {
  if (receipts.length === 0) return null;
  const current = monthKey(now);
  const previous = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));

  const counts = new Map<string, number>();
  for (const r of receipts) counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
  const currency = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];

  const inMonth = (key: string) => receipts.filter((r) => r.purchaseDate.startsWith(key));
  const thisMonthAll = inMonth(current);
  const thisMonth = thisMonthAll.filter((r) => r.currency === currency);
  const lastMonth = inMonth(previous).filter((r) => r.currency === currency);

  return {
    currency,
    thisMonth: sumMoney(thisMonth.map((r) => r.total)),
    lastMonth: sumMoney(lastMonth.map((r) => r.total)),
    receiptCount: thisMonthAll.length,
    otherCurrencies: thisMonthAll.length - thisMonth.length,
  };
}
