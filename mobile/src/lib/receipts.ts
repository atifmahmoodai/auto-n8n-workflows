import { randomUUID } from "expo-crypto";
import { deleteReceipt, getReceipt, insertReceipt } from "./db";
import { isValidIsoDate, roundMoney, sumMoney, todayIso } from "./format";
import { deleteReceiptImage, persistReceiptImage } from "./image";
import { syncReceipt } from "./sync";
import { CATEGORIES, type Category, type ExtractedReceipt, type Receipt, type ReceiptItem } from "./types";

export type Draft = {
  merchant: string;
  purchaseDate: string;
  currency: string;
  tax: number | null;
  total: number | null;
  paymentMethod: string | null;
  notes: string | null;
  items: ReceiptItem[];
};

function normalizeCategory(value: string): Category {
  return (CATEGORIES as readonly string[]).includes(value) ? (value as Category) : "other";
}

export function draftFromExtraction(x: ExtractedReceipt): Draft {
  const currency = /^[A-Z]{3}$/.test(x.currency?.toUpperCase() ?? "") ? x.currency.toUpperCase() : "USD";
  return {
    merchant: x.merchant?.trim() || "Unknown store",
    purchaseDate: x.purchase_date && isValidIsoDate(x.purchase_date) ? x.purchase_date : todayIso(),
    currency,
    tax: x.tax,
    total: x.total,
    paymentMethod: x.payment_method,
    notes: x.notes,
    items: x.items.map((item) => ({
      id: randomUUID(),
      name: item.name.trim() || "Item",
      quantity: item.quantity > 0 ? item.quantity : 1,
      unitPrice: item.unit_price,
      totalPrice: roundMoney(item.total_price),
      category: normalizeCategory(item.category),
    })),
  };
}

export function itemsTotal(draft: Pick<Draft, "items">): number {
  return sumMoney(draft.items.map((i) => i.totalPrice));
}

/** The printed total if present, otherwise items + tax. */
export function effectiveTotal(draft: Draft): number {
  if (draft.total !== null) return roundMoney(draft.total);
  return sumMoney([itemsTotal(draft), draft.tax ?? 0]);
}

/**
 * True when the printed total matches neither items alone (tax-inclusive receipts, e.g. VAT)
 * nor items + tax. Usually means a line was misread.
 */
export function totalsMismatch(draft: Draft): boolean {
  if (draft.total === null || draft.items.length === 0) return false;
  const items = itemsTotal(draft);
  const withTax = sumMoney([items, draft.tax ?? 0]);
  const close = (a: number, b: number) => Math.abs(a - b) <= 0.01;
  return !close(draft.total, items) && !close(draft.total, withTax);
}

export function validateDraft(draft: Draft): string | null {
  if (!draft.merchant.trim()) return "Add the store name.";
  if (!isValidIsoDate(draft.purchaseDate)) return "Enter the date as YYYY-MM-DD.";
  if (!/^[A-Z]{3}$/.test(draft.currency)) return "Currency must be a 3-letter code like USD.";
  if (draft.items.some((i) => !i.name.trim())) return "Every item needs a name.";
  return null;
}

/** Saves locally first (works offline), then syncs to Google Sheets in the background. */
export async function saveDraft(draft: Draft, cacheImageUri: string | null): Promise<string> {
  const id = randomUUID();
  let imageUri: string | null = null;
  if (cacheImageUri) {
    try {
      imageUri = persistReceiptImage(cacheImageUri, id);
    } catch (error) {
      console.warn("Could not keep receipt photo", error);
    }
  }
  const receipt: Receipt = {
    id,
    merchant: draft.merchant.trim(),
    purchaseDate: draft.purchaseDate,
    currency: draft.currency,
    subtotal: itemsTotal(draft),
    tax: draft.tax,
    total: effectiveTotal(draft),
    paymentMethod: draft.paymentMethod?.trim() || null,
    notes: draft.notes?.trim() || null,
    imageUri,
    items: draft.items.map((i) => ({ ...i, name: i.name.trim() })),
    createdAt: new Date().toISOString(),
    syncStatus: "pending",
    syncError: null,
  };
  try {
    await insertReceipt(receipt);
  } catch (error) {
    deleteReceiptImage(imageUri);
    throw error;
  }
  void syncReceipt(id);
  return id;
}

export async function removeReceipt(id: string): Promise<void> {
  const receipt = await getReceipt(id);
  await deleteReceipt(id);
  deleteReceiptImage(receipt?.imageUri ?? null);
}
