import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ExtractedReceiptSchema, type ExtractedReceipt, type ParseRequest } from "./schema.js";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";

const SYSTEM_PROMPT = `You read photos of shopping receipts (groceries, pharmacies, restaurants, fuel, retail) and return their contents as structured data.

Rules:
- List every purchased line item in the order printed. Do not merge or skip lines.
- Expand obvious abbreviations into readable names ("ORG BNNA" -> "Organic Bananas"), but never invent items that are not on the receipt.
- For weighed items, quantity is the weight and unit_price is the price per weight unit.
- Discounts, coupons and savings printed as their own lines become items with a negative total_price.
- Deposits, bag fees and service charges are items too. Tax is reported in "tax", not as an item.
- Copy subtotal, tax and total exactly as printed; do not "fix" them if they disagree with the item sum.
- Dates: convert to YYYY-MM-DD. If the day/month order is ambiguous, use the store's country convention.
- If a value is not printed or unreadable, use null rather than guessing, and mention it briefly in notes.
- If the image is not a receipt, set is_receipt to false and return an empty items list.`;

// Parsed by hand rather than with messages.parse(): parse() throws a generic error on
// refusals and truncated output, and we want to map those to user-facing messages.
function parseReceipt(content: Anthropic.Beta.BetaContentBlock[]): ExtractedReceipt | null {
  const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  try {
    const result = ExtractedReceiptSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export type ReceiptExtractor = (input: ParseRequest) => Promise<ExtractedReceipt>;

export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly code: "refused" | "unparseable" | "not_a_receipt" | "upstream",
    readonly status: 422 | 502 | 503,
  ) {
    super(message);
  }
}

export function createClaudeExtractor(client = new Anthropic()): ReceiptExtractor {
  return async ({ imageBase64, mediaType }) => {
    let response;
    try {
      response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: {
          effort: "medium",
          format: betaZodOutputFormat(ExtractedReceiptSchema),
        },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
              { type: "text", text: "Extract this receipt." },
            ],
          },
        ],
      });
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        throw new ExtractionError("The receipt reader is busy. Please try again in a moment.", "upstream", 503);
      }
      if (error instanceof Anthropic.APIError) {
        console.error(`Anthropic API error ${error.status}: ${error.message}`);
        throw new ExtractionError("The receipt reader is unavailable right now.", "upstream", 502);
      }
      throw error;
    }

    if (response.stop_reason === "refusal") {
      throw new ExtractionError("This image could not be processed.", "refused", 422);
    }
    const receipt = response.stop_reason === "end_turn" ? parseReceipt(response.content) : null;
    if (!receipt) {
      throw new ExtractionError("The receipt could not be read. Try a clearer photo.", "unparseable", 422);
    }
    if (!receipt.is_receipt) {
      throw new ExtractionError("That doesn't look like a receipt. Try again with the whole receipt in frame.", "not_a_receipt", 422);
    }
    return receipt;
  };
}
