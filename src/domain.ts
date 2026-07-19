/**
 * Domain model for match-day incident triage.
 *
 * Everything the operations centre reasons about is declared here as frozen
 * constants so that (a) the AI prompt, (b) the deterministic fallback and
 * (c) the test-suite all read from a single source of truth. Divergence
 * between those three is the classic bug in AI-assisted classifiers, so the
 * vocabulary is centralised rather than duplicated per module.
 */

/** Incident categories a stadium operations centre must be able to route. */
export const CATEGORIES = [
  'crowd_safety',
  'medical',
  'security',
  'fire_hazard',
  'infrastructure',
  'pitch_and_playing_surface',
  'ticketing_and_access',
  'transport_and_egress',
  'weather',
  'anti_social_behaviour',
  'lost_or_vulnerable_person',
  'other',
] as const;

export type Category = (typeof CATEGORIES)[number];

/** Response units present in a FIFA World Cup 2026 venue operations centre. */
export const UNITS = [
  'Stewarding',
  'Medical',
  'Police and Security',
  'Fire and Rescue',
  'Facilities and Maintenance',
  'Transport Liaison',
  'Pitch Operations',
  'Safeguarding',
  'Ticketing and Accreditation',
  'Venue Operations Centre',
] as const;

export type Unit = (typeof UNITS)[number];

/** Phase of the match, which changes crowd density and therefore urgency. */
export const MATCH_PHASES = [
  'pre_match_ingress',
  'first_half',
  'half_time',
  'second_half',
  'full_time_egress',
  'non_match_day',
] as const;

export type MatchPhase = (typeof MATCH_PHASES)[number];

/** Operational priority bands used on the incident board. */
export type Priority = 'P1' | 'P2' | 'P3' | 'P4';

/** A location parsed out of free text (gate 4, block C row 12, concourse...). */
export interface IncidentLocation {
  /** Free-text zone description, already sanitised. */
  readonly zone: string;
  /** Gate identifier if the reporter mentioned one, else null. */
  readonly gate: string | null;
  /** Seating block identifier if mentioned, else null. */
  readonly block: string | null;
  /** Seating row if mentioned, else null. */
  readonly row: string | null;
}

/** A fully triaged, routed incident ready for the operations board. */
export interface TriagedIncident {
  readonly id: string;
  readonly receivedAt: string;
  readonly venueId: string;
  readonly matchPhase: MatchPhase;
  readonly reportText: string;
  readonly category: Category;
  /** 1 = trivial, 5 = life-threatening / mass-casualty potential. */
  readonly severity: 1 | 2 | 3 | 4 | 5;
  readonly priority: Priority;
  /** Target time-to-first-response in minutes, derived from priority. */
  readonly slaMinutes: number;
  readonly primaryUnit: Unit;
  readonly supportingUnits: readonly Unit[];
  readonly location: IncidentLocation;
  readonly summary: string;
  readonly recommendedActions: readonly string[];
  /** True when venue command must be woken up immediately. */
  readonly escalateToVenueCommand: boolean;
  /** 0-1 confidence in the classification. */
  readonly confidence: number;
  /** Which engine produced the classification. Surfaced in the UI verbatim. */
  readonly engine: 'workers-ai' | 'deterministic-fallback';
  /** Human-readable reason the fallback was used, when it was. */
  readonly degradedReason: string | null;
  /** End-to-end triage latency in milliseconds. */
  readonly latencyMs: number;
}

/** Maximum accepted length of an incident report, in characters. */
export const MAX_REPORT_CHARS = 1200;

/** Minimum accepted length; anything shorter cannot be triaged meaningfully. */
export const MIN_REPORT_CHARS = 4;

/** Type guard for {@link Category}. Used at the AI output boundary. */
export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

/** Type guard for {@link MatchPhase}. Used at the HTTP input boundary. */
export function isMatchPhase(value: unknown): value is MatchPhase {
  return typeof value === 'string' && (MATCH_PHASES as readonly string[]).includes(value);
}
