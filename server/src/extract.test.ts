import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { createClaudeExtractor, ExtractionError } from "./extract.js";

function fakeClient(reply: { text: string; stop_reason?: string }) {
  const requests: any[] = [];
  const client = new Anthropic({
    apiKey: "test",
    maxRetries: 0,
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: reply.text }],
          stop_reason: reply.stop_reason ?? "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  return { client, requests };
}

const valid = {
  is_receipt: true,
  merchant: "Shop",
  purchase_date: "2026-09-01",
  currency: "USD",
  items: [{ name: "Milk", quantity: 1, unit_price: 2.5, total_price: 2.5, category: "dairy" }],
  subtotal: 2.5,
  tax: null,
  total: 2.5,
  payment_method: "Cash",
  notes: null,
};

describe("createClaudeExtractor", () => {
  it("sends the image with a JSON schema and returns the parsed receipt", async () => {
    const { client, requests } = fakeClient({ text: JSON.stringify(valid) });
    const result = await createClaudeExtractor(client)({ imageBase64: "AAAA", mediaType: "image/jpeg" });
    expect(result).toEqual(valid);

    const body = requests[0];
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.fallbacks).toBe("default");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.output_config.format.schema.properties.items.type).toBe("array");
    expect(body.messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
    });
  });

  it("rejects non-receipts", async () => {
    const { client } = fakeClient({ text: JSON.stringify({ ...valid, is_receipt: false, items: [] }) });
    await expect(createClaudeExtractor(client)({ imageBase64: "AAAA", mediaType: "image/jpeg" })).rejects.toMatchObject({
      code: "not_a_receipt",
    });
  });

  it("surfaces refusals as ExtractionError", async () => {
    const { client } = fakeClient({ text: "", stop_reason: "refusal" });
    await expect(createClaudeExtractor(client)({ imageBase64: "AAAA", mediaType: "image/jpeg" })).rejects.toBeInstanceOf(
      ExtractionError,
    );
  });

  it("treats truncated output as unreadable", async () => {
    const { client } = fakeClient({ text: '{"is_receipt": true, "items": [', stop_reason: "max_tokens" });
    await expect(createClaudeExtractor(client)({ imageBase64: "AAAA", mediaType: "image/jpeg" })).rejects.toMatchObject({
      code: "unparseable",
    });
  });
});
