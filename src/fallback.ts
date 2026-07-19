/**
 * Deterministic keyword classifier - the graceful-degradation path.
 *
 * This runs whenever Workers AI is unavailable, times out, is rate limited or
 * returns unparseable output. It is intentionally simple and fully offline so
 * that the operations board NEVER shows a blank screen during a live match.
 * When it is used, the API response says so explicitly (`engine:
 * "deterministic-fallback"`) and the UI renders a visible degraded-mode banner
 * - an operator must always know whether a machine or a rule table classified
 * the incident in front of them.
 *
 * It also doubles as the location extractor for the AI path, because gate and
 * block references follow a rigid venue grammar that regex handles more
 * reliably than a language model.
 */

import type { Category, IncidentLocation } from './domain.js';

/**
 * Category signals, ordered by descending safety consequence. The first
 * category with a matching term wins, so a report mentioning both "crush" and
 * "ticket" is treated as crowd safety rather than ticketing.
 */
const SIGNALS: readonly { readonly category: Category; readonly severity: number; readonly terms: readonly string[] }[] =
  Object.freeze([
    {
      category: 'crowd_safety',
      severity: 5,
      terms: ['crush', 'crowd surge', 'surge', 'stampede', 'pressed against', 'overcrowd', 'bottleneck', 'crowd build', 'aglomeraci', 'avalancha'],
    },
    {
      category: 'fire_hazard',
      severity: 5,
      terms: ['fire', 'smoke', 'flare', 'pyro', 'burning', 'incendio', 'humo', 'bengala'],
    },
    {
      category: 'medical',
      severity: 4,
      terms: ['medical', 'collapse', 'unconscious', 'cardiac', 'heart attack', 'seizure', 'bleeding', 'injury', 'injured', 'ambulance', 'heat exhaustion', 'defibrillator', 'medico', 'herido', 'desmay'],
    },
    {
      category: 'security',
      severity: 4,
      terms: ['weapon', 'knife', 'gun', 'suspicious package', 'unattended bag', 'threat', 'intruder', 'pitch invasion', 'breach', 'drone', 'bomb'],
    },
    {
      category: 'lost_or_vulnerable_person',
      severity: 3,
      terms: ['lost child', 'missing child', 'lost person', 'separated from', 'unaccompanied minor', 'vulnerable', 'nino perdido', 'niño perdido'],
    },
    {
      category: 'weather',
      severity: 3,
      terms: ['lightning', 'thunder', 'storm', 'hail', 'heat index', 'wet bulb', 'tornado', 'flooding', 'tormenta'],
    },
    {
      category: 'anti_social_behaviour',
      severity: 3,
      terms: ['fight', 'brawl', 'altercation', 'racist', 'discriminatory', 'abusive', 'chanting', 'drunk', 'intoxicated', 'pelea'],
    },
    {
      category: 'transport_and_egress',
      severity: 3,
      terms: ['egress', 'shuttle', 'transit', 'metro', 'train', 'bus', 'car park', 'parking', 'rideshare', 'traffic', 'exit route', 'transporte'],
    },
    {
      category: 'infrastructure',
      severity: 2,
      terms: ['power', 'outage', 'lighting', 'floodlight', 'escalator', 'lift', 'elevator', 'toilet', 'water leak', 'leak', 'wifi', 'screen', 'barrier broken', 'turnstile fault'],
    },
    {
      category: 'ticketing_and_access',
      severity: 2,
      terms: ['ticket', 'accreditation', 'turnstile', 'scanner', 'duplicate entry', 'access denied', 'queue at gate', 'boleto', 'entrada'],
    },
    {
      category: 'pitch_and_playing_surface',
      severity: 2,
      terms: ['pitch', 'turf', 'goal post', 'goalpost', 'playing surface', 'sprinkler', 'line marking', 'cesped', 'césped'],
    },
  ]);

/** Terms that push severity up by one band wherever they appear. */
const INTENSIFIERS: readonly string[] = Object.freeze([
  'urgent', 'immediately', 'critical', 'severe', 'multiple', 'many', 'mass',
  'life', 'serious', 'escalating', 'worsening', 'emergency', 'now',
]);

/** Terms that pull severity down by one band. */
const DE_ESCALATORS: readonly string[] = Object.freeze([
  'minor', 'small', 'contained', 'resolved', 'no injuries', 'precaution',
  'routine', 'slight', 'clearing',
]);

/** Result of deterministic classification. */
export interface FallbackClassification {
  readonly category: Category;
  readonly severity: number;
  /** 0-1; low by construction, because keyword matching is a blunt instrument. */
  readonly confidence: number;
  readonly summary: string;
}

/**
 * Classify an incident report using keyword signals only.
 *
 * Complexity is O(c * t) where c is the number of categories (11) and t the
 * terms per category - both fixed constants, so this is O(n) in report length
 * and runs in well under a millisecond.
 *
 * @param report Sanitised report text.
 * @returns A category, severity and a truncated summary. Always succeeds:
 *          unmatched text falls through to `other` at severity 2.
 */
export function classifyDeterministically(report: string): FallbackClassification {
  const text = report.toLowerCase();

  let matched: { category: Category; severity: number } | null = null;
  for (const signal of SIGNALS) {
    if (signal.terms.some((term) => text.includes(term))) {
      matched = { category: signal.category, severity: signal.severity };
      break;
    }
  }

  const base = matched ?? { category: 'other' as Category, severity: 2 };
  let severity = base.severity;
  if (INTENSIFIERS.some((term) => text.includes(term))) severity += 1;
  if (DE_ESCALATORS.some((term) => text.includes(term))) severity -= 1;

  return {
    category: base.category,
    severity,
    // Deliberately conservative: an operator should trust a keyword match less
    // than a model classification, and the number is what drives that framing.
    confidence: matched === null ? 0.25 : 0.55,
    summary: truncate(report, 140),
  };
}

/**
 * Extract structured location hints from free text.
 *
 * Stadium location grammar ("gate 4", "block C row 12", "concourse level 2") is
 * regular, so regexes beat a language model here on both accuracy and cost.
 *
 * @param report Sanitised report text.
 * @returns Gate, block, row and a human-readable zone. Fields are null when the
 *          reporter did not state them - never guessed, because dispatching to
 *          a guessed gate wastes the SLA window.
 */
export function extractLocation(report: string): IncidentLocation {
  const text = report.toLowerCase();

  // `puerta` / `porte` are included because the 2026 tournament is hosted in
  // three countries and reports arrive in Spanish and French as well as English.
  const gate = firstGroup(text, /\b(?:gate|puerta|porte)\s*(?:no\.?\s*)?([a-z]?\d{1,3}[a-z]?)\b/);
  const block = firstGroup(text, /\b(?:block|section|sector|stand)\s*([a-z]{0,2}\d{0,3}[a-z]?)\b/);
  const row = firstGroup(text, /\brow\s*([a-z]?\d{1,3})\b/);
  const level = firstGroup(text, /\b(?:level|tier|concourse)\s*(\d{1,2})\b/);

  const parts: string[] = [];
  if (gate !== null) parts.push(`Gate ${gate.toUpperCase()}`);
  if (block !== null) parts.push(`Block ${block.toUpperCase()}`);
  if (row !== null) parts.push(`Row ${row.toUpperCase()}`);
  if (level !== null) parts.push(`Level ${level}`);

  return {
    zone: parts.length > 0 ? parts.join(', ') : 'Location not stated',
    gate,
    block,
    row,
  };
}

/**
 * Run a regex and return its first capture group, normalised.
 *
 * @param text Lower-cased haystack.
 * @param pattern Pattern with exactly one capture group.
 * @returns The trimmed group, or null when absent or empty.
 */
function firstGroup(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  const value = match?.[1]?.trim();
  return value !== undefined && value.length > 0 ? value : null;
}

/**
 * Truncate text on a word boundary with an ellipsis.
 *
 * @param text Input text.
 * @param max Maximum output length in characters.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

/**
 * Suggested actions per category for the offline path, so a degraded response
 * is still actionable rather than an empty list.
 */
const FALLBACK_ACTIONS: Readonly<Record<Category, readonly string[]>> = Object.freeze({
  crowd_safety: ['Halt inbound flow to the affected gate line', 'Deploy stewards to relieve pressure and open a release valve route', 'Request a density read from CCTV before any further admission'],
  medical: ['Dispatch the nearest medical team with a trauma bag', 'Clear an access route wide enough for a stretcher', 'Hold a first-aid point on standby for onward transfer'],
  security: ['Establish a cordon at a safe stand-off distance', 'Notify police liaison and preserve CCTV for the window', 'Do not broadcast details on open radio channels'],
  fire_hazard: ['Dispatch fire and rescue and confirm the alarm zone', 'Prepare the adjacent block for a phased evacuation', 'Confirm smoke-control and exit routes are unobstructed'],
  infrastructure: ['Dispatch maintenance and isolate the affected equipment', 'Sign and steward the area to prevent public access', 'Log the asset and raise a post-match works ticket'],
  pitch_and_playing_surface: ['Notify the match delegate and pitch operations', 'Inspect and photograph the affected area before any repair', 'Confirm playability with the referee liaison'],
  ticketing_and_access: ['Divert affected spectators to the nearest working lane', 'Send ticketing support to the gate with a handheld scanner', 'Record affected ticket ids for post-match reconciliation'],
  transport_and_egress: ['Notify transport liaison and the local transit operator', 'Prepare a hold-and-release egress plan for the affected route', 'Update wayfinding and public address messaging'],
  weather: ['Consult the venue weather cell and current lightning policy', 'Prepare shelter-in-place messaging for the affected stands', 'Brief pitch operations on covers and delay protocol'],
  anti_social_behaviour: ['Deploy stewards to observe and de-escalate', 'Record identifiers for post-match sanction', 'Escalate to police liaison if the behaviour is discriminatory'],
  lost_or_vulnerable_person: ['Start the venue lost-person protocol and log a description', 'Notify all gate stewards and the safeguarding lead', 'Reunite only at the designated safeguarding point'],
  other: ['Acknowledge and log the report', 'Request clarifying detail from the reporting steward', 'Hold at the operations centre pending triage'],
});

/**
 * Look up the offline recommended actions for a category.
 *
 * @param category Incident category.
 * @returns A frozen list of concrete, venue-appropriate actions.
 */
export function fallbackActions(category: Category): readonly string[] {
  return FALLBACK_ACTIONS[category];
}
