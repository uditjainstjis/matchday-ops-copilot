/**
 * HTTP concerns: security headers, typed JSON responses, and rate limiting.
 *
 * SECURITY: every response leaving this Worker passes through
 * {@link withSecurityHeaders}, so a header can never be forgotten on a new
 * route. The CSP is strict-by-default and the frontend is written to comply
 * with it (no inline handlers, no inline styles, no eval, no CDN).
 */

/**
 * Content Security Policy.
 *
 * - `default-src 'none'` denies everything, then each capability is granted
 *   back explicitly, so a future asset type fails closed rather than open.
 * - No `unsafe-inline` and no `unsafe-eval`: this is what actually blocks
 *   reflected-XSS payloads from executing, including any that a language model
 *   might be induced to emit.
 * - `frame-ancestors 'none'` prevents the operations board being clickjacked
 *   into a hostile page.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

/** Headers applied to every single response. */
const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': CSP,
  // Stops MIME sniffing turning a JSON error into executable script.
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  // The board needs no device APIs; denying them shrinks the blast radius.
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
});

/**
 * Clone a response with the security header set applied.
 *
 * @param response Response to harden.
 * @returns A new Response with identical body and status.
 */
export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Build a JSON response.
 *
 * @param body Serialisable payload.
 * @param status HTTP status code.
 * @param extraHeaders Additional headers such as cache directives.
 */
export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

/**
 * Build an error response in a stable machine-readable shape.
 *
 * SECURITY: the message is always one of our own literals. Internal error
 * details and stack traces are never echoed to a client.
 *
 * @param message Safe, human-readable message.
 * @param status HTTP status code.
 */
export function errorJson(message: string, status: number): Response {
  return json({ error: { message, status } }, status);
}

/** Per-client state for the fixed-window rate limiter. */
interface Window {
  count: number;
  resetAt: number;
}

/**
 * In-memory fixed-window rate limiter.
 *
 * SECURITY: Workers AI inference is the expensive resource here; without a
 * limit a single client can exhaust the account's free-tier neurons and take
 * the board down for every venue. Per-isolate memory is the right trade for a
 * hackathon-scale deployment: it costs zero storage round-trips, and because
 * Cloudflare pins a client to a colo the limit is effective in practice. A
 * production deployment would swap this for a Durable Object to make the count
 * globally exact; the interface is designed so that is a drop-in change.
 *
 * Memory is bounded by {@link RateLimiter.maxTrackedClients} with eviction of
 * expired windows, so a spoofed-IP flood cannot grow the map without limit.
 */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  /**
   * @param limit Maximum requests allowed per window.
   * @param windowMs Window length in milliseconds.
   * @param maxTrackedClients Hard cap on tracked keys, to bound memory.
   */
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxTrackedClients = 10_000,
  ) {}

  /**
   * Record a request and report whether it is allowed.
   *
   * @param key Client identifier, normally the CF-Connecting-IP header.
   * @param now Current epoch milliseconds; injected for deterministic tests.
   * @returns Whether the request is allowed, how many remain, and when the
   *          window resets (used to populate `Retry-After`).
   */
  check(key: string, now: number = Date.now()): { allowed: boolean; remaining: number; resetAt: number } {
    const existing = this.windows.get(key);

    if (existing === undefined || now >= existing.resetAt) {
      if (this.windows.size >= this.maxTrackedClients) this.evictExpired(now);
      const resetAt = now + this.windowMs;
      this.windows.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.limit - 1, resetAt };
    }

    if (existing.count >= this.limit) {
      return { allowed: false, remaining: 0, resetAt: existing.resetAt };
    }

    existing.count += 1;
    return { allowed: true, remaining: this.limit - existing.count, resetAt: existing.resetAt };
  }

  /** Number of tracked clients. Exposed for tests and diagnostics. */
  get size(): number {
    return this.windows.size;
  }

  /**
   * Drop windows that have already expired.
   *
   * @param now Current epoch milliseconds.
   */
  private evictExpired(now: number): void {
    for (const [key, window] of this.windows) {
      if (now >= window.resetAt) this.windows.delete(key);
    }
    // If everything is still live, drop the oldest entry so the map is always
    // bounded even under a sustained distributed flood.
    if (this.windows.size >= this.maxTrackedClients) {
      const oldest = this.windows.keys().next();
      if (!oldest.done) this.windows.delete(oldest.value);
    }
  }
}

/**
 * Derive a stable rate-limit key for a request.
 *
 * @param request Incoming request.
 * @returns The client IP from Cloudflare's trusted header, or a shared bucket
 *          when absent. `CF-Connecting-IP` is set by the edge and cannot be
 *          spoofed by the client, unlike `X-Forwarded-For`, which is why we
 *          never read the latter.
 */
export function rateLimitKey(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'unknown-client';
}
