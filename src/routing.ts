/**
 * Deterministic routing, prioritisation and SLA policy.
 *
 * DESIGN: the language model is deliberately NOT trusted to decide priority,
 * SLA or which unit is dispatched. It only performs the task it is genuinely
 * best at - turning messy free text into a category, a severity and a location.
 * Every consequential decision is then made by the pure functions below, which
 * are auditable, unit-testable and identical on every request. This keeps the
 * safety-critical path free of model variance while keeping the AI load-bearing
 * for the part that no rule engine can do well.
 */

import type { Category, MatchPhase, Priority, Unit } from './domain.js';

/**
 * Baseline urgency weight per category, 0-2. Added to the reported severity to
 * form a raw urgency score. Crowd safety and fire carry a standing uplift
 * because their failure mode is non-linear: a delayed response to crowd
 * pressure escalates far faster than a delayed response to a broken turnstile.
 */
const CATEGORY_UPLIFT: Readonly<Record<Category, number>> = Object.freeze({
  crowd_safety: 2,
  medical: 2,
  fire_hazard: 2,
  security: 1,
  lost_or_vulnerable_person: 1,
  transport_and_egress: 1,
  infrastructure: 0,
  pitch_and_playing_surface: 0,
  ticketing_and_access: 0,
  weather: 1,
  anti_social_behaviour: 0,
  other: 0,
});

/**
 * Additional uplift by match phase. Ingress and egress are the two windows in
 * which stadium crowd density peaks, so identical reports are treated as more
 * urgent then. This is the "tournament operations" logic that a generic
 * ticketing system does not have.
 */
const PHASE_UPLIFT: Readonly<Record<MatchPhase, number>> = Object.freeze({
  pre_match_ingress: 2,
  full_time_egress: 2,
  half_time: 1,
  first_half: 0,
  second_half: 0,
  non_match_day: -1,
});

/** Primary responding unit for each category. */
const PRIMARY_UNIT: Readonly<Record<Category, Unit>> = Object.freeze({
  crowd_safety: 'Stewarding',
  medical: 'Medical',
  security: 'Police and Security',
  fire_hazard: 'Fire and Rescue',
  infrastructure: 'Facilities and Maintenance',
  pitch_and_playing_surface: 'Pitch Operations',
  ticketing_and_access: 'Ticketing and Accreditation',
  transport_and_egress: 'Transport Liaison',
  weather: 'Venue Operations Centre',
  anti_social_behaviour: 'Stewarding',
  lost_or_vulnerable_person: 'Safeguarding',
  other: 'Venue Operations Centre',
});

/** Units that must be co-notified alongside the primary unit. */
const SUPPORTING_UNITS: Readonly<Record<Category, readonly Unit[]>> = Object.freeze({
  crowd_safety: ['Police and Security', 'Medical', 'Venue Operations Centre'],
  medical: ['Stewarding', 'Venue Operations Centre'],
  security: ['Stewarding', 'Venue Operations Centre'],
  fire_hazard: ['Stewarding', 'Venue Operations Centre', 'Medical'],
  infrastructure: ['Venue Operations Centre'],
  pitch_and_playing_surface: ['Venue Operations Centre'],
  ticketing_and_access: ['Stewarding'],
  transport_and_egress: ['Stewarding', 'Venue Operations Centre'],
  weather: ['Stewarding', 'Pitch Operations'],
  anti_social_behaviour: ['Police and Security'],
  lost_or_vulnerable_person: ['Stewarding', 'Police and Security'],
  other: [],
});

/** Target time-to-first-response, in minutes, per priority band. */
const SLA_MINUTES: Readonly<Record<Priority, number>> = Object.freeze({
  P1: 2,
  P2: 5,
  P3: 15,
  P4: 60,
});

/**
 * Compute the operational priority band.
 *
 * Score = severity (1-5) + category uplift (0-2) + match-phase uplift (-1..2),
 * giving a range of 0-9, then banded. The banding is intentionally coarse:
 * operations staff act on four bands, and a finer scale would imply a
 * precision the input does not support.
 *
 * @param severity Reported severity, 1-5.
 * @param category Incident category.
 * @param phase Current match phase.
 * @returns The priority band. Pure and total: every input maps to a band.
 */
export function computePriority(severity: number, category: Category, phase: MatchPhase): Priority {
  const clamped = clampSeverity(severity);
  const score = clamped + CATEGORY_UPLIFT[category] + PHASE_UPLIFT[phase];
  if (score >= 7) return 'P1';
  if (score >= 5) return 'P2';
  if (score >= 2) return 'P3';
  return 'P4';
}

/**
 * Clamp an arbitrary number to the 1-5 severity scale.
 *
 * SECURITY / ROBUSTNESS: this sits directly behind model output, which can and
 * does emit `0`, `11`, `NaN` or a string. Clamping rather than throwing keeps
 * an incident on the board instead of dropping it.
 *
 * @param value Any candidate severity.
 * @returns An integer in [1, 5]; non-numeric input defaults to 3 (mid-scale).
 */
export function clampSeverity(value: unknown): 1 | 2 | 3 | 4 | 5 {
  // Only numbers and numeric strings are considered. `Number(null)` is 0 and
  // `Number([])` is 0, both of which would otherwise silently clamp to
  // severity 1 and under-report a potentially serious incident.
  if (typeof value !== 'number' && typeof value !== 'string') return 3;
  const n = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(n)) return 3;
  const rounded = Math.round(n);
  if (rounded < 1) return 1;
  if (rounded > 5) return 5;
  return rounded as 1 | 2 | 3 | 4 | 5;
}

/**
 * Look up the SLA for a priority band.
 *
 * @param priority Priority band.
 * @returns Target time-to-first-response in minutes.
 */
export function slaFor(priority: Priority): number {
  return SLA_MINUTES[priority];
}

/**
 * Resolve which units are dispatched for a category.
 *
 * @param category Incident category.
 * @returns The primary unit and its supporting units. The arrays are frozen
 *          module constants, so no allocation happens per request.
 */
export function routeUnits(category: Category): { primary: Unit; supporting: readonly Unit[] } {
  return { primary: PRIMARY_UNIT[category], supporting: SUPPORTING_UNITS[category] };
}

/**
 * Decide whether venue command must be escalated to immediately.
 *
 * @param priority Computed priority band.
 * @param category Incident category.
 * @returns True for any P1, and for P2 crowd-safety or fire incidents, which
 *          are the two categories where a delayed command decision has
 *          historically been the difference between an incident and a disaster.
 */
export function shouldEscalate(priority: Priority, category: Category): boolean {
  if (priority === 'P1') return true;
  return priority === 'P2' && (category === 'crowd_safety' || category === 'fire_hazard');
}
