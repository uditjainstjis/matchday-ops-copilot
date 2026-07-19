/**
 * Input validation and sanitisation for every untrusted boundary.
 *
 * SECURITY: this module is the single place where request bodies are turned
 * into typed values. Nothing downstream re-parses raw input. Two distinct
 * threats are handled here:
 *   1. Prompt injection - operator text is untrusted and is delimited and
 *      stripped of instruction-like control sequences before reaching the model.
 *   2. Output-side injection - control characters are removed so that text
 *      echoed back into the DOM (via textContent, never innerHTML) and into
 *      JSON cannot smuggle terminators.
 */

import {
  MAX_REPORT_CHARS,
  MIN_REPORT_CHARS,
  isMatchPhase,
  type MatchPhase,
} from './domain.js';
import { findVenue, type Venue } from './venues.js';

/** A successfully validated triage request. */
export interface TriageRequest {
  readonly report: string;
  readonly venue: Venue;
  readonly matchPhase: MatchPhase;
}

/** Discriminated result so callers cannot forget to handle the failure path. */
export type ValidationResult =
  | { readonly ok: true; readonly value: TriageRequest }
  | { readonly ok: false; readonly error: string };

/**
 * Control characters that must never survive into a prompt, a log line or a
 * JSON payload. Kept as an explicit class (rather than a broad `\W` sweep) so
 * legitimate multilingual reports - a tournament in three countries receives
 * Spanish, French and English text - are not mangled.
 *
 * eslint no-control-regex is disabled deliberately and only here: matching
 * control characters is the entire purpose of this pattern. The rule exists to
 * catch them appearing by accident, which is the opposite of this case.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060\uFEFF]/g;

/**
 * Phrases used in the overwhelming majority of prompt-injection attempts.
 * They are neutralised (not rejected) because a genuine steward should never
 * be blocked from filing an incident by an over-eager filter; a false
 * rejection during a crowd surge is far more dangerous than a scrubbed word.
 */
const INJECTION_PATTERNS: readonly RegExp[] = Object.freeze([
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/gi,
  /disregard\s+(?:all\s+)?(?:previous|prior|above)/gi,
  /you\s+are\s+now\s+(?:a|an)\s+/gi,
  /system\s*(?:prompt|message)\s*[:=]/gi,
  /<\s*\/?\s*(?:system|assistant|user)\s*>/gi,
  /\[\s*\/?\s*(?:INST|SYS)\s*\]/gi,
  /```/g,
]);

/**
 * Strip control characters, collapse runs of whitespace and neutralise known
 * prompt-injection phrasing.
 *
 * @param raw Untrusted text of any shape.
 * @returns Clean single-spaced text, safe to embed in a delimited prompt.
 *          Complexity is O(n) in the input length, and the input length is
 *          hard-capped by {@link validateTriageRequest} before this runs.
 */
export function sanitiseText(raw: string): string {
  let text = raw.replace(CONTROL_CHARS, ' ');
  for (const pattern of INJECTION_PATTERNS) {
    text = text.replace(pattern, '[redacted]');
  }
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Validate a parsed JSON body into a {@link TriageRequest}.
 *
 * Rejects rather than coerces: an unknown venue id is an operator error worth
 * surfacing, not something to silently default, because routing an incident to
 * the wrong stadium is a safety failure.
 *
 * @param body Result of `JSON.parse` on the request body. May be anything.
 * @returns A discriminated result; the error string is safe to show a user and
 *          never contains echoed input.
 */
export function validateTriageRequest(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }

  const record = body as Record<string, unknown>;

  const rawReport = record['report'];
  if (typeof rawReport !== 'string') {
    return { ok: false, error: 'Field "report" is required and must be a string.' };
  }
  // Length is checked on the RAW string before sanitising, so an attacker
  // cannot smuggle a megabyte of control characters past the cap.
  if (rawReport.length > MAX_REPORT_CHARS) {
    return { ok: false, error: `Report must be ${MAX_REPORT_CHARS} characters or fewer.` };
  }

  const report = sanitiseText(rawReport);
  if (report.length < MIN_REPORT_CHARS) {
    return { ok: false, error: `Report must contain at least ${MIN_REPORT_CHARS} characters of text.` };
  }

  const venue = findVenue(record['venueId']);
  if (venue === null) {
    return { ok: false, error: 'Field "venueId" must be one of the 16 host venue ids.' };
  }

  const phase = record['matchPhase'] ?? 'pre_match_ingress';
  if (!isMatchPhase(phase)) {
    return { ok: false, error: 'Field "matchPhase" is not a recognised match phase.' };
  }

  return { ok: true, value: { report, venue, matchPhase: phase } };
}

/**
 * Safely parse a request body with a hard byte cap.
 *
 * SECURITY: an unbounded `request.json()` lets a client pin CPU and memory in
 * the isolate. We read the body as text, reject early on `content-length`, and
 * never let a parse error escape as a 500.
 *
 * @param request Incoming request.
 * @param maxBytes Hard limit on the body size in bytes.
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    return { ok: false, error: 'Request body too large.' };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, error: 'Could not read request body.' };
  }
  if (text.length > maxBytes) {
    return { ok: false, error: 'Request body too large.' };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: 'Request body is not valid JSON.' };
  }
}
