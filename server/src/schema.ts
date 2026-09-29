import { z } from "zod";

export const ITEM_CATEGORIES = [
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

export const ReceiptItemSchema = z.object({
  name: z.string().describe("Human-readable item name, expanded from receipt abbreviations where obvious"),
  quantity: z.number().describe("Quantity purchased (weight in kg/lb for weighed items, otherwise count). 1 if not printed"),
  unit_price: z.number().nullable().describe("Price per unit if printed or derivable, otherwise null"),
  total_price: z.number().describe("Line total as printed. Negative for discounts/coupons"),
  category: z.enum(ITEM_CATEGORIES),
});

export const ExtractedReceiptSchema = z.object({
  is_receipt: z.boolean().describe("False when the image is not a purchase receipt or is unreadable"),
  merchant: z.string().nullable(),
  purchase_date: z.string().nullable().describe("ISO date YYYY-MM-DD, null if not printed"),
  currency: z.string().describe("ISO 4217 code, inferred from symbols/country; USD if unknown"),
  items: z.array(ReceiptItemSchema),
  subtotal: z.number().nullable(),
  tax: z.number().nullable(),
  total: z.number().nullable(),
  payment_method: z.string().nullable().describe("e.g. 'Visa ****1234', 'Cash', null if not printed"),
  notes: z.string().nullable().describe("Short note about unreadable parts or doubts, null if none"),
});

export type ExtractedReceipt = z.infer<typeof ExtractedReceiptSchema>;

export const ALLOWED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/** Claude accepts images up to 5 MB each. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const ParseRequestSchema = z.object({
  imageBase64: z
    .string()
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "imageBase64 must be raw base64 without a data: prefix")
    .refine((b64) => Math.floor((b64.length * 3) / 4) <= MAX_IMAGE_BYTES, "Image is larger than 5 MB"),
  mediaType: z.enum(ALLOWED_MEDIA_TYPES),
});

export type ParseRequest = z.infer<typeof ParseRequestSchema>;
