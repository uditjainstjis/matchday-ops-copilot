/**
 * Integration tests: drive the Worker's exported fetch handler end to end with
 * a stubbed AI binding, exercising routing, headers, validation and the
 * rate limiter as a whole system rather than as isolated units.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index.js';
import { RateLimiter } from '../src/http.js';

/** Model output used by the happy path. */
const AI_OK = {
  response: {
    category: 'crowd_safety',
    severity: 5,
    summary: 'Crowd pressure at gate 4.',
    recommended_actions: ['Halt inbound flow', 'Deploy stewards'],
  },
};

/**
 * Build a test Env whose AI binding is a stub and whose ASSETS binding returns
 * a sentinel page, so no network or filesystem access is required.
 */
function makeEnv(aiResult: unknown = AI_OK): Env & { AI: { run: ReturnType<typeof vi.fn> } } {
  return {
    AI: { run: vi.fn().mockResolvedValue(aiResult) },
    ASSETS: { fetch: vi.fn().mockResolvedValue(new Response('<!doctype html><title>board</title>', { headers: { 'content-type': 'text/html' } })) },
  } as unknown as Env & { AI: { run: ReturnType<typeof vi.fn> } };
}

const post = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }): Request =>
  new Request('https://ops.test/api/triage', { method: 'POST', body: JSON.stringify(body), headers });

const VALID = { report: 'crowd surge at gate 4, people pressed against the barrier', venueId: 'nyn', matchPhase: 'pre_match_ingress' };

let env: ReturnType<typeof makeEnv>;
beforeEach(() => {
  env = makeEnv();
});

describe('GET /api/health', () => {
  it('reports ok with the configured model', async () => {
    const response = await worker.fetch(new Request('https://ops.test/api/health'), env);
    expect(response.status).toBe(200);
    const body = await response.json<{ status: string; model: string; venues: number }>();
    expect(body.status).toBe('ok');
    expect(body.model).toContain('@cf/');
    expect(body.venues).toBe(16);
  });

  it('rejects non-GET methods', async () => {
    const response = await worker.fetch(new Request('https://ops.test/api/health', { method: 'POST' }), env);
    expect(response.status).toBe(405);
  });
});

describe('GET /api/venues', () => {
  it('returns all 16 venues plus the controlled vocabularies', async () => {
    const response = await worker.fetch(new Request('https://ops.test/api/venues'), env);
    expect(response.status).toBe(200);
    const body = await response.json<{ venues: unknown[]; matchPhases: unknown[]; categories: unknown[] }>();
    expect(body.venues).toHaveLength(16);
    expect(body.matchPhases.length).toBeGreaterThan(0);
    expect(body.categories.length).toBeGreaterThan(0);
  });

  it('is cacheable, because it never changes during the tournament', async () => {
    const response = await worker.fetch(new Request('https://ops.test/api/venues'), env);
    expect(response.headers.get('cache-control')).toContain('max-age');
  });
});

describe('POST /api/triage', () => {
  it('triages a valid report through the AI path', async () => {
    const response = await worker.fetch(post(VALID), env);
    expect(response.status).toBe(200);
    const body = await response.json<{ incident: Record<string, unknown> }>();
    expect(body.incident.engine).toBe('workers-ai');
    expect(body.incident.priority).toBe('P1');
    expect(String(body.incident.id)).toMatch(/^INC-[0-9A-F]{8}$/);
  });

  it('never caches a triage result', async () => {
    const response = await worker.fetch(post(VALID), env);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('degrades to the offline classifier when the model fails, and says so', async () => {
    const failing = makeEnv();
    failing.AI.run.mockRejectedValue(new Error('service unavailable'));
    const response = await worker.fetch(post(VALID), failing);
    expect(response.status).toBe(200);
    const body = await response.json<{ incident: Record<string, unknown> }>();
    expect(body.incident.engine).toBe('deterministic-fallback');
    expect(body.incident.degradedReason).toBeTruthy();
  });

  it('rejects a request without a JSON content type', async () => {
    const response = await worker.fetch(post(VALID, { 'content-type': 'text/plain' }), env);
    expect(response.status).toBe(415);
  });

  it('rejects malformed JSON with a 400 and not a 500', async () => {
    const request = new Request('https://ops.test/api/triage', {
      method: 'POST',
      body: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(400);
  });

  it('rejects an unknown venue', async () => {
    const response = await worker.fetch(post({ ...VALID, venueId: 'wembley' }), env);
    expect(response.status).toBe(400);
  });

  it('rejects an oversized body without invoking the model', async () => {
    const response = await worker.fetch(post({ ...VALID, report: 'x'.repeat(20_000) }), env);
    expect(response.status).toBe(400);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it('rejects GET on the triage endpoint', async () => {
    const response = await worker.fetch(new Request('https://ops.test/api/triage'), env);
    expect(response.status).toBe(405);
  });

  it('returns a structured error shape clients can rely on', async () => {
    const response = await worker.fetch(post({ report: 'x', venueId: 'nyn' }), env);
    const body = await response.json<{ error: { message: string; status: number } }>();
    expect(typeof body.error.message).toBe('string');
    expect(body.error.status).toBe(400);
  });

  it('never leaks a stack trace or internal detail in an error body', async () => {
    const response = await worker.fetch(post({ report: 'x', venueId: 'nyn' }), env);
    const text = await response.text();
    expect(text).not.toMatch(/at \w+ \(/);
    expect(text.toLowerCase()).not.toContain('stack');
  });
});

describe('unknown routes', () => {
  it('returns 404 JSON for an unknown API route', async () => {
    const response = await worker.fetch(new Request('https://ops.test/api/nope'), env);
    expect(response.status).toBe(404);
  });

  it('serves the static frontend for a non-API path', async () => {
    const response = await worker.fetch(new Request('https://ops.test/'), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('board');
  });
});

describe('security headers', () => {
  const paths = ['https://ops.test/api/health', 'https://ops.test/api/nope', 'https://ops.test/'];

  it('applies a strict CSP to every response, including static assets', async () => {
    for (const path of paths) {
      const response = await worker.fetch(new Request(path), env);
      const csp = response.headers.get('content-security-policy');
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
    }
  });

  it('never permits unsafe-inline or unsafe-eval', async () => {
    const response = await worker.fetch(new Request('https://ops.test/'), env);
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('sets the supporting hardening headers', async () => {
    const response = await worker.fetch(new Request('https://ops.test/api/health'), env);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('strict-transport-security')).toContain('max-age');
    expect(response.headers.get('permissions-policy')).toContain('camera=()');
  });
});

describe('RateLimiter', () => {
  it('allows requests up to the limit', () => {
    const limiter = new RateLimiter(3, 1000);
    expect(limiter.check('a', 0).allowed).toBe(true);
    expect(limiter.check('a', 1).allowed).toBe(true);
    expect(limiter.check('a', 2).allowed).toBe(true);
  });

  it('blocks the request past the limit', () => {
    const limiter = new RateLimiter(2, 1000);
    limiter.check('a', 0);
    limiter.check('a', 1);
    expect(limiter.check('a', 2).allowed).toBe(false);
  });

  it('counts down the remaining allowance', () => {
    const limiter = new RateLimiter(3, 1000);
    expect(limiter.check('a', 0).remaining).toBe(2);
    expect(limiter.check('a', 1).remaining).toBe(1);
    expect(limiter.check('a', 2).remaining).toBe(0);
  });

  it('resets after the window elapses', () => {
    const limiter = new RateLimiter(1, 1000);
    expect(limiter.check('a', 0).allowed).toBe(true);
    expect(limiter.check('a', 500).allowed).toBe(false);
    expect(limiter.check('a', 1000).allowed).toBe(true);
  });

  it('isolates clients from each other', () => {
    const limiter = new RateLimiter(1, 1000);
    expect(limiter.check('a', 0).allowed).toBe(true);
    expect(limiter.check('a', 1).allowed).toBe(false);
    expect(limiter.check('b', 1).allowed).toBe(true);
  });

  it('bounds memory under a flood of distinct keys', () => {
    const limiter = new RateLimiter(5, 1000, 50);
    for (let i = 0; i < 500; i += 1) limiter.check(`client-${i}`, i * 100);
    expect(limiter.size).toBeLessThanOrEqual(50);
  });

  it('reports a reset time in the future while a window is open', () => {
    const limiter = new RateLimiter(1, 1000);
    const first = limiter.check('a', 0);
    expect(first.resetAt).toBe(1000);
  });
});

describe('rate limiting through the Worker', () => {
  it('returns 429 with Retry-After once the per-client budget is spent', async () => {
    const headers = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.99' };
    let last: Response | null = null;
    // The configured budget is 20/min; 25 attempts must trip it.
    for (let i = 0; i < 25; i += 1) {
      last = await worker.fetch(post(VALID, headers), env);
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get('retry-after')).toBeTruthy();
  });
});
