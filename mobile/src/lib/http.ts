export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof HttpError && error.status === 401;
}

/** fetch with a timeout and friendly network errors. */
export async function request(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    if (controller.signal.aborted) throw new HttpError(0, "The request timed out. Check your connection and try again.");
    throw new HttpError(0, "You appear to be offline. Check your connection and try again.");
  } finally {
    clearTimeout(timer);
  }
}

export async function readError(response: Response, fallback: string): Promise<HttpError> {
  let message = fallback;
  let code: string | undefined;
  try {
    const body = await response.json();
    // Our server: { error, message }. Google APIs: { error: { code, message, status } }.
    if (typeof body?.message === "string") message = body.message;
    if (typeof body?.error?.message === "string") message = body.error.message;
    if (typeof body?.error === "string") code = body.error;
    if (typeof body?.error?.status === "string") code = body.error.status;
  } catch {
    // non-JSON body; keep fallback
  }
  return new HttpError(response.status, message, code);
}
