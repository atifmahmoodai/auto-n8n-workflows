import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createGoogleVerifier } from "./auth.js";
import { createClaudeExtractor } from "./extract.js";
import { RateLimiter } from "./rateLimit.js";

const audiences = (process.env.GOOGLE_CLIENT_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const app = createApp({
  verifyToken: createGoogleVerifier(audiences),
  extract: createClaudeExtractor(),
  limiter: new RateLimiter(Number(process.env.SCANS_PER_HOUR ?? 60), 60 * 60 * 1000),
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Receipt server listening on :${info.port}`);
});
