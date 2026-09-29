import { appendReceiptToSheet } from "../sheets";
import type { Receipt } from "../types";

const mockSettings = new Map<string, string>();
jest.mock("../db", () => ({
  getSetting: jest.fn(async (k: string) => mockSettings.get(k) ?? null),
  setSetting: jest.fn(async (k: string, v: string) => void mockSettings.set(k, v)),
}));
jest.mock("../auth", () => ({
  withGoogleTokens: (fn: (t: { idToken: string; accessToken: string }) => Promise<unknown>) =>
    fn({ idToken: "id", accessToken: "access" }),
}));


const receipt: Receipt = {
  id: "r1",
  merchant: "Shop",
  purchaseDate: "2026-09-28",
  currency: "USD",
  subtotal: 3,
  tax: null,
  total: 3,
  paymentMethod: null,
  notes: null,
  imageUri: null,
  items: [{ id: "i1", name: "=HYPERLINK(\"x\")", quantity: 1, unitPrice: 3, totalPrice: 3, category: "dairy" }],
  createdAt: "2026-09-28T10:00:00.000Z",
  syncStatus: "pending",
  syncError: null,
};

type Call = { url: string; method: string; body: any };
let calls: Call[];

function mockFetch(handler: (call: Call) => { status: number; body: unknown }) {
  calls = [];
  globalThis.fetch = jest.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const { status, body } = handler(call);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

beforeEach(() => mockSettings.clear());

it("creates the spreadsheet on first sync and appends both rows in one batch", async () => {
  mockFetch((c) => {
    if (c.method === "POST" && c.url.endsWith("/spreadsheets")) return { status: 200, body: { spreadsheetId: "S1" } };
    if (c.url.includes("/values/")) return { status: 200, body: {} };
    return { status: 200, body: {} };
  });

  await appendReceiptToSheet(receipt);

  expect(mockSettings.get("spreadsheetId")).toBe("S1");
  const batch = calls.find((c) => c.url.endsWith("/S1:batchUpdate"))!;
  expect(batch.body.requests).toHaveLength(2);
  const [receiptRows, itemRows] = batch.body.requests.map((r: any) => r.appendCells);
  expect(receiptRows.sheetId).toBe(1);
  expect(itemRows.sheetId).toBe(2);
  // Date stored as a real Sheets date serial (2026-09-28).
  expect(receiptRows.rows[0].values[1].userEnteredValue).toEqual({ numberValue: 46293 });
  // Item names are literal strings, never formulas.
  expect(itemRows.rows[0].values[3].userEnteredValue).toEqual({ stringValue: '=HYPERLINK("x")' });
});

it("skips the append if the receipt is already in the sheet", async () => {
  mockSettings.set("spreadsheetId", "S1");
  mockFetch((c) =>
    c.url.includes("/values/") ? { status: 200, body: { values: [["Receipt ID", "r1"]] } } : { status: 200, body: {} },
  );
  await appendReceiptToSheet(receipt);
  expect(calls.some((c) => c.url.includes(":batchUpdate"))).toBe(false);
});

it("recreates the spreadsheet if the saved one is gone", async () => {
  mockSettings.set("spreadsheetId", "OLD");
  mockFetch((c) => {
    if (c.url.includes("/OLD?")) return { status: 404, body: { error: { code: 404, message: "not found", status: "NOT_FOUND" } } };
    if (c.method === "POST" && c.url.endsWith("/spreadsheets")) return { status: 200, body: { spreadsheetId: "NEW" } };
    return { status: 200, body: {} };
  });
  await appendReceiptToSheet(receipt);
  expect(mockSettings.get("spreadsheetId")).toBe("NEW");
});

it("surfaces Google errors", async () => {
  mockSettings.set("spreadsheetId", "S1");
  mockFetch(() => ({ status: 500, body: { error: { code: 500, message: "backend error", status: "INTERNAL" } } }));
  await expect(appendReceiptToSheet(receipt)).rejects.toMatchObject({ status: 500, message: "backend error" });
});
