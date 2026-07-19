/**
 * Matchday Ops Copilot - Worker entrypoint.
 *
 * Problem: during a FIFA World Cup 2026 match, a venue operations centre
 * receives hundreds of unstructured reports from stewards, medics and security
 * staff, in three languages, across 16 venues. Turning that stream into
 * prioritised, routed, actionable incidents is the bottleneck. This Worker does
 * exactly that: generative AI reads the free text, deterministic policy decides
 * what happens next.
 *
 * Routing table:
 *   GET  /api/health   - liveness and configuration echo
 *   GET  /api/venues   - the 16 host venues and tournament shape
 *   POST /api/triage   - triage one free-text incident report
 *   *                  - static frontend, served from the edge cache
 */

import { MATCH_PHASES, CATEGORIES } from './domain.js';
import { errorJson, json, rateLimitKey, RateLimiter, withSecurityHeaders } from './http.js';
import { MODEL, triage } from './triage.js';
import { readJsonBody, validateTriageRequest } from './validate.js';
import { TOURNAMENT, VENUES } from './venues.js';

export interface Env {
  /** Workers AI binding. Injected by the platform; no key is stored in the repo. */
  readonly AI: Ai;
  /** Static asset binding for the operations board frontend. */
  readonly ASSETS: Fetcher;
}

/** Maximum request body size in bytes. Generous for text, hostile to abuse. */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * Triage requests allowed per client per minute. Sized so a whole shift of
 * stewards at one venue is comfortable, while a scripted flood is not.
 */
const TRIAGE_RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

/**
 * Module-scope limiter. Lives for the isolate's lifetime, which is precisely
 * the behaviour we want: no storage round-trip on the hot path.
 */
const limiter = new RateLimiter(TRIAGE_RATE_LIMIT, RATE_WINDOW_MS);

/**
 * Generate an incident id.
 *
 * `crypto.randomUUID` is used rather than a counter because ids are shown to
 * operators and must not leak volume information or collide across isolates.
 *
 * @returns An id of the form `INC-3F2A9C11`.
 */
function newIncidentId(): string {
  return `INC-${crypto.randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
}

/**
 * Handle POST /api/triage.
 *
 * @param request Incoming request.
 * @param env Worker bindings.
 * @returns A JSON response containing one fully routed incident.
 */
async function handleTriage(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return errorJson('Content-Type must be application/json.', 415);
  }

  const gate = limiter.check(rateLimitKey(request));
  if (!gate.allowed) {
    const retryAfter = Math.max(1, Math.ceil((gate.resetAt - Date.now()) / 1000));
    return json(
      { error: { message: 'Rate limit exceeded. Slow down and retry shortly.', status: 429 } },
      429,
      { 'retry-after': String(retryAfter) },
    );
  }

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return errorJson(body.error, 400);

  const validated = validateTriageRequest(body.value);
  if (!validated.ok) return errorJson(validated.error, 400);

  const incident = await triage(env.AI, validated.value, newIncidentId());

  return json({ incident }, 200, {
    // Triage output is per-incident and must never be cached by an
    // intermediary; a stale P1 on an operator's screen is a safety hazard.
    'cache-control': 'no-store',
    'x-ratelimit-remaining': String(gate.remaining),
  });
}

/**
 * Handle GET /api/venues.
 *
 * @returns The 16 host venues plus the controlled vocabularies the client needs
 *          to render its form, in one round trip rather than three.
 */
function handleVenues(): Response {
  return json(
    { tournament: TOURNAMENT, venues: VENUES, matchPhases: MATCH_PHASES, categories: CATEGORIES },
    200,
    // Static for the tournament's duration: cache hard at the edge and in the
    // browser so this endpoint costs effectively nothing after first load.
    { 'cache-control': 'public, max-age=3600, s-maxage=86400' },
  );
}

export default {
  /**
   * Worker fetch handler.
   *
   * @param request Incoming request.
   * @param env Bindings.
   * @returns A hardened response; every path passes through the security
   *          header wrapper, including the static asset path.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      let response: Response;

      if (url.pathname === '/api/health') {
        response =
          request.method === 'GET'
            ? json(
                { status: 'ok', model: MODEL, venues: VENUES.length, tournament: TOURNAMENT.name },
                200,
                { 'cache-control': 'no-store' },
              )
            : errorJson('Method not allowed.', 405);
      } else if (url.pathname === '/api/venues') {
        response = request.method === 'GET' ? handleVenues() : errorJson('Method not allowed.', 405);
      } else if (url.pathname === '/api/triage') {
        response =
          request.method === 'POST'
            ? await handleTriage(request, env)
            : errorJson('Method not allowed. Use POST.', 405);
      } else {
        response = errorJson('No such endpoint.', 404);
      }

      return withSecurityHeaders(response);
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
} satisfies ExportedHandler<Env>;
