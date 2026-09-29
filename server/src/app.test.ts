import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { ExtractionError } from "./extract.js";
import { RateLimiter } from "./rateLimit.js";
import type { ExtractedReceipt } from "./schema.js";

const receipt: ExtractedReceipt = {
  is_receipt: true,
  merchant: "Fresh Market",
  purchase_date: "2026-09-28",
  currency: "USD",
  items: [{ name: "Bananas", quantity: 1.2, unit_price: 0.59, total_price: 0.71, category: "produce" }],
  subtotal: 0.71,
  tax: 0,
  total: 0.71,
  payment_method: null,
  notes: null,
};

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function setup(overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
  const extract = vi.fn(async () => receipt);
  const app = createApp({
    verifyToken: async (t) => {
      if (t !== "good") throw new Error("bad token");
      return { userId: "u1", email: "a@b.c" };
    },
    extract,
    limiter: new RateLimiter(100, 60_000),
    ...overrides,
  });
  const post = (body: unknown, token = "good") =>
    app.request("/v1/receipts/parse", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { app, extract, post };
}

describe("POST /v1/receipts/parse", () => {
  it("returns the extracted receipt", async () => {
    const { post, extract } = setup();
    const res = await post({ imageBase64: PNG_1PX, mediaType: "image/png" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ receipt });
    expect(extract).toHaveBeenCalledWith({ imageBase64: PNG_1PX, mediaType: "image/png" });
  });

  it("rejects missing or invalid tokens", async () => {
    const { app, post } = setup();
    expect((await app.request("/v1/receipts/parse", { method: "POST" })).status).toBe(401);
    expect((await post({ imageBase64: PNG_1PX, mediaType: "image/png" }, "bad")).status).toBe(401);
  });

  it("validates the payload", async () => {
    const { post, extract } = setup();
    expect((await post({ imageBase64: "data:image/png;base64,abc", mediaType: "image/png" })).status).toBe(400);
    expect((await post({ imageBase64: PNG_1PX, mediaType: "image/gif" })).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    expect(extract).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies", async () => {
    const { post } = setup();
    const res = await post({ imageBase64: "A".repeat(8 * 1024 * 1024), mediaType: "image/jpeg" });
    expect(res.status).toBe(413);
  });

  it("maps extraction errors to their status", async () => {
    const { post } = setup({
      extract: async () => {
        throw new ExtractionError("nope", "not_a_receipt", 422);
      },
    });
    const res = await post({ imageBase64: PNG_1PX, mediaType: "image/png" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "not_a_receipt", message: "nope" });
  });

  it("rate limits per user", async () => {
    const { post } = setup({ limiter: new RateLimiter(1, 60_000) });
    expect((await post({ imageBase64: PNG_1PX, mediaType: "image/png" })).status).toBe(200);
    const res = await post({ imageBase64: PNG_1PX, mediaType: "image/png" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });
});

describe("RateLimiter", () => {
  it("resets after the window", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 1000, () => now);
    expect(limiter.take("k")).toBe(0);
    expect(limiter.take("k")).toBe(1);
    now = 1000;
    expect(limiter.take("k")).toBe(0);
  });
});
