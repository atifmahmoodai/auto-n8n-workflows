export const CATEGORIES = [
  "groceries",
  "produce",
  "meat_seafood",
  "dairy",
  "bakery",
  "beverages",
  "snacks",
  "household",
  "personal_care",
  "health",
  "baby",
  "pet",
  "electronics",
  "clothing",
  "dining",
  "fuel",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export type ReceiptItem = {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number | null;
  totalPrice: number;
  category: Category;
};

export type SyncStatus = "pending" | "synced" | "failed";

export type Receipt = {
  id: string;
  merchant: string;
  purchaseDate: string; // YYYY-MM-DD
  currency: string;
  subtotal: number | null;
  tax: number | null;
  total: number;
  paymentMethod: string | null;
  notes: string | null;
  imageUri: string | null;
  items: ReceiptItem[];
  createdAt: string; // ISO timestamp
  syncStatus: SyncStatus;
  syncError: string | null;
};

export type ReceiptSummary = Omit<Receipt, "items"> & { itemCount: number };

/** Shape returned by the server (mirrors server/src/schema.ts). */
export type ExtractedReceipt = {
  is_receipt: boolean;
  merchant: string | null;
  purchase_date: string | null;
  currency: string;
  items: {
    name: string;
    quantity: number;
    unit_price: number | null;
    total_price: number;
    category: Category;
  }[];
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  payment_method: string | null;
  notes: string | null;
};
