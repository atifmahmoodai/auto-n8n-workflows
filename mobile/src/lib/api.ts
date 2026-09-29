import { withGoogleTokens } from "./auth";
import { config } from "./config";
import { isUnauthorized, readError, request } from "./http";
import type { ExtractedReceipt } from "./types";

export async function parseReceiptImage(imageBase64: string, mediaType: "image/jpeg"): Promise<ExtractedReceipt> {
  return withGoogleTokens(async ({ idToken }) => {
    const response = await request(`${config.apiUrl}/v1/receipts/parse`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ imageBase64, mediaType }),
      timeoutMs: 120_000, // reading a long receipt can take a while
    });
    if (!response.ok) throw await readError(response, "We couldn't read this receipt. Please try again.");
    const body = (await response.json()) as { receipt: ExtractedReceipt };
    return body.receipt;
  }, isUnauthorized);
}
