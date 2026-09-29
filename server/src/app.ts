import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { TokenVerifier, AuthenticatedUser } from "./auth.js";
import { ExtractionError, type ReceiptExtractor } from "./extract.js";
import type { RateLimiter } from "./rateLimit.js";
import { ParseRequestSchema } from "./schema.js";

type Deps = { verifyToken: TokenVerifier; extract: ReceiptExtractor; limiter: RateLimiter };
type Env = { Variables: { user: AuthenticatedUser } };

export function createApp({ verifyToken, extract, limiter }: Deps) {
  const app = new Hono<Env>();

  app.use(secureHeaders());

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) return c.json({ error: "unauthorized", message: "Sign in required." }, 401);
    try {
      c.set("user", await verifyToken(token));
    } catch {
      return c.json({ error: "unauthorized", message: "Your session expired. Please sign in again." }, 401);
    }
    const retryAfter = limiter.take(c.get("user").userId);
    if (retryAfter > 0) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "rate_limited", message: "Too many scans. Please wait a moment." }, 429);
    }
    await next();
  });

  app.post(
    "/v1/receipts/parse",
    // base64 inflates by 4/3, plus JSON overhead
    bodyLimit({
      maxSize: 7 * 1024 * 1024 + 1024,
      onError: (c) => c.json({ error: "too_large", message: "Image is too large." }, 413),
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "bad_request", message: "Body must be JSON." }, 400);
      }
      const parsed = ParseRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "Invalid request." }, 400);
      }
      try {
        const receipt = await extract(parsed.data);
        return c.json({ receipt });
      } catch (error) {
        if (error instanceof ExtractionError) {
          return c.json({ error: error.code, message: error.message }, error.status);
        }
        console.error("Unexpected extraction failure", error);
        return c.json({ error: "internal", message: "Something went wrong. Please try again." }, 500);
      }
    },
  );

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}
