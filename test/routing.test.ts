import { describe, expect, it } from 'vitest';
import { CATEGORIES, MATCH_PHASES, type Category } from '../src/domain.js';
import { clampSeverity, computePriority, routeUnits, shouldEscalate, slaFor } from '../src/routing.js';

describe('clampSeverity', () => {
  it('passes valid severities through unchanged', () => {
    for (const value of [1, 2, 3, 4, 5]) {
      expect(clampSeverity(value)).toBe(value);
    }
  });

  it('clamps below the floor', () => {
    expect(clampSeverity(0)).toBe(1);
    expect(clampSeverity(-99)).toBe(1);
  });

  it('clamps above the ceiling', () => {
    expect(clampSeverity(6)).toBe(5);
    expect(clampSeverity(1000)).toBe(5);
  });

  it('rounds fractional severities', () => {
    expect(clampSeverity(3.4)).toBe(3);
    expect(clampSeverity(3.6)).toBe(4);
  });

  it('coerces numeric strings, which models frequently emit', () => {
    expect(clampSeverity('4')).toBe(4);
  });

  it('defaults to mid-scale for values that are not numbers at all', () => {
    expect(clampSeverity('critical')).toBe(3);
    expect(clampSeverity(NaN)).toBe(3);
    expect(clampSeverity(Infinity)).toBe(3);
    expect(clampSeverity(null)).toBe(3);
    expect(clampSeverity(undefined)).toBe(3);
    expect(clampSeverity({})).toBe(3);
  });
});

describe('computePriority', () => {
  it('makes a severe crowd-safety report during ingress a P1', () => {
    expect(computePriority(5, 'crowd_safety', 'pre_match_ingress')).toBe('P1');
  });

  it('makes a severe crowd-safety report during egress a P1', () => {
    expect(computePriority(5, 'crowd_safety', 'full_time_egress')).toBe('P1');
  });

  it('rates the same crowd report lower in open play than at ingress', () => {
    const ingress = computePriority(3, 'crowd_safety', 'pre_match_ingress');
    const openPlay = computePriority(3, 'crowd_safety', 'first_half');
    expect(ingress).toBe('P1');
    expect(openPlay).toBe('P2');
  });

  it('de-prioritises non-match-day reports relative to match day', () => {
    expect(computePriority(2, 'infrastructure', 'non_match_day')).toBe('P4');
    expect(computePriority(2, 'infrastructure', 'first_half')).toBe('P3');
  });

  it('treats a trivial ticketing issue as the lowest band', () => {
    expect(computePriority(1, 'ticketing_and_access', 'non_match_day')).toBe('P4');
  });

  it('gives medical incidents a standing uplift over infrastructure', () => {
    const medical = computePriority(3, 'medical', 'first_half');
    const infra = computePriority(3, 'infrastructure', 'first_half');
    expect(medical).toBe('P2');
    expect(infra).toBe('P3');
  });

  it('returns a valid band for every category and phase combination', () => {
    const valid = new Set(['P1', 'P2', 'P3', 'P4']);
    for (const category of CATEGORIES) {
      for (const phase of MATCH_PHASES) {
        for (const severity of [1, 2, 3, 4, 5]) {
          expect(valid.has(computePriority(severity, category, phase))).toBe(true);
        }
      }
    }
  });

  it('is monotonic in severity: higher severity never yields a lower priority', () => {
    const rank = { P1: 0, P2: 1, P3: 2, P4: 3 } as const;
    for (const category of CATEGORIES) {
      for (const phase of MATCH_PHASES) {
        for (let s = 1; s < 5; s += 1) {
          const lower = rank[computePriority(s, category, phase)];
          const higher = rank[computePriority(s + 1, category, phase)];
          expect(higher).toBeLessThanOrEqual(lower);
        }
      }
    }
  });

  it('clamps out-of-range severity rather than producing an invalid band', () => {
    expect(computePriority(99, 'other', 'non_match_day')).toBe(computePriority(5, 'other', 'non_match_day'));
  });
});

describe('slaFor', () => {
  it('maps each band to its documented target', () => {
    expect(slaFor('P1')).toBe(2);
    expect(slaFor('P2')).toBe(5);
    expect(slaFor('P3')).toBe(15);
    expect(slaFor('P4')).toBe(60);
  });

  it('is strictly increasing as priority falls', () => {
    expect(slaFor('P1')).toBeLessThan(slaFor('P2'));
    expect(slaFor('P2')).toBeLessThan(slaFor('P3'));
    expect(slaFor('P3')).toBeLessThan(slaFor('P4'));
  });
});

describe('routeUnits', () => {
  it('sends medical incidents to the medical team', () => {
    expect(routeUnits('medical').primary).toBe('Medical');
  });

  it('sends fire incidents to fire and rescue with medical support', () => {
    const route = routeUnits('fire_hazard');
    expect(route.primary).toBe('Fire and Rescue');
    expect(route.supporting).toContain('Medical');
  });

  it('sends lost children to safeguarding', () => {
    expect(routeUnits('lost_or_vulnerable_person').primary).toBe('Safeguarding');
  });

  it('defines a primary unit for every category with no gaps', () => {
    for (const category of CATEGORIES) {
      expect(routeUnits(category).primary).toBeTruthy();
    }
  });

  it('never lists the primary unit again as a supporting unit', () => {
    for (const category of CATEGORIES) {
      const route = routeUnits(category);
      expect(route.supporting).not.toContain(route.primary);
    }
  });
});

describe('shouldEscalate', () => {
  it('escalates every P1 regardless of category', () => {
    for (const category of CATEGORIES) {
      expect(shouldEscalate('P1', category)).toBe(true);
    }
  });

  it('escalates P2 crowd safety and P2 fire, which escalate non-linearly', () => {
    expect(shouldEscalate('P2', 'crowd_safety')).toBe(true);
    expect(shouldEscalate('P2', 'fire_hazard')).toBe(true);
  });

  it('does not escalate an ordinary P2', () => {
    expect(shouldEscalate('P2', 'ticketing_and_access')).toBe(false);
    expect(shouldEscalate('P2', 'infrastructure')).toBe(false);
  });

  it('never escalates P3 or P4', () => {
    for (const category of CATEGORIES as readonly Category[]) {
      expect(shouldEscalate('P3', category)).toBe(false);
      expect(shouldEscalate('P4', category)).toBe(false);
    }
  });
});
