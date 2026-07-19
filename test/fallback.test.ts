import { describe, expect, it } from 'vitest';
import { CATEGORIES } from '../src/domain.js';
import { classifyDeterministically, extractLocation, fallbackActions, truncate } from '../src/fallback.js';

describe('classifyDeterministically', () => {
  it('classifies a crowd surge as crowd safety at high severity', () => {
    const result = classifyDeterministically('crowd surge at gate 4, people pressed against the barrier');
    expect(result.category).toBe('crowd_safety');
    expect(result.severity).toBeGreaterThanOrEqual(5);
  });

  it('classifies a collapse as medical', () => {
    expect(classifyDeterministically('adult male collapsed and is unconscious in block c').category).toBe('medical');
  });

  it('classifies smoke as a fire hazard', () => {
    expect(classifyDeterministically('smoke coming from the kiosk on level 2').category).toBe('fire_hazard');
  });

  it('classifies an unattended bag as security', () => {
    expect(classifyDeterministically('unattended bag left by the north turnstiles').category).toBe('security');
  });

  it('classifies a lost child as a safeguarding matter', () => {
    expect(classifyDeterministically('lost child near gate 7 wearing a red shirt').category).toBe(
      'lost_or_vulnerable_person',
    );
  });

  it('classifies lightning as weather', () => {
    expect(classifyDeterministically('lightning detected within 8 miles of the venue').category).toBe('weather');
  });

  it('classifies a broken scanner as ticketing', () => {
    expect(classifyDeterministically('turnstile scanner is down on lane 3').category).toBe('ticketing_and_access');
  });

  it('handles Spanish crowd reports, which matter in three host countries', () => {
    expect(classifyDeterministically('aglomeracion en la puerta 2, la gente empuja').category).toBe('crowd_safety');
  });

  it('prefers the higher-consequence category when signals conflict', () => {
    // Mentions both a crush and a ticket problem; crowd safety must win.
    const result = classifyDeterministically('crush developing at the ticket gate, scanner also down');
    expect(result.category).toBe('crowd_safety');
  });

  it('raises severity when an intensifier is present', () => {
    const plain = classifyDeterministically('lost child near gate 7');
    const urgent = classifyDeterministically('lost child near gate 7, urgent');
    expect(urgent.severity).toBeGreaterThan(plain.severity);
  });

  it('lowers severity when a de-escalator is present', () => {
    const plain = classifyDeterministically('fire alarm in the kiosk');
    const minor = classifyDeterministically('fire alarm in the kiosk, minor and contained');
    expect(minor.severity).toBeLessThan(plain.severity);
  });

  it('falls through to "other" for text it does not recognise', () => {
    const result = classifyDeterministically('the mascot needs a new costume before kickoff');
    expect(result.category).toBe('other');
  });

  it('reports lower confidence for an unmatched report than a matched one', () => {
    const matched = classifyDeterministically('cardiac arrest in block b');
    const unmatched = classifyDeterministically('please send more paper cups');
    expect(unmatched.confidence).toBeLessThan(matched.confidence);
  });

  it('never returns a confidence above 1 or below 0', () => {
    for (const text of ['crush urgent critical mass', 'nothing here', 'minor contained resolved']) {
      const result = classifyDeterministically(text);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('handles an empty string without throwing', () => {
    expect(() => classifyDeterministically('')).not.toThrow();
  });

  it('is case-insensitive', () => {
    expect(classifyDeterministically('CROWD SURGE AT GATE 4').category).toBe('crowd_safety');
  });
});

describe('extractLocation', () => {
  it('extracts a gate number', () => {
    expect(extractLocation('crowd surge at gate 4').gate).toBe('4');
  });

  it('extracts block and row together', () => {
    const location = extractLocation('medical at block c12 row 8');
    expect(location.block).toBe('c12');
    expect(location.row).toBe('8');
  });

  it('extracts a concourse level', () => {
    expect(extractLocation('smoke on concourse 2').zone).toContain('Level 2');
  });

  it('builds a readable zone string from what it found', () => {
    expect(extractLocation('fight at gate 12 row 4').zone).toBe('Gate 12, Row 4');
  });

  it('returns nulls rather than guessing when no location is stated', () => {
    const location = extractLocation('someone is shouting somewhere in the ground');
    expect(location.gate).toBeNull();
    expect(location.block).toBeNull();
    expect(location.row).toBeNull();
    expect(location.zone).toBe('Location not stated');
  });

  it('extracts a gate from a Spanish report', () => {
    expect(extractLocation('aglomeracion en la puerta 2').gate).toBe('2');
  });

  it('extracts a gate from a French report', () => {
    expect(extractLocation('blesse pres de la porte 3').gate).toBe('3');
  });

  it('handles alphanumeric gate identifiers', () => {
    expect(extractLocation('queue at gate a3').gate).toBe('a3');
  });

  it('does not throw on an empty report', () => {
    expect(() => extractLocation('')).not.toThrow();
  });
});

describe('fallbackActions', () => {
  it('provides at least two concrete actions for every category', () => {
    for (const category of CATEGORIES) {
      expect(fallbackActions(category).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('never returns an empty action list, so the panel is never blank', () => {
    for (const category of CATEGORIES) {
      for (const action of fallbackActions(category)) {
        expect(action.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe('truncate', () => {
  it('leaves short text untouched', () => {
    expect(truncate('gate 4', 20)).toBe('gate 4');
  });

  it('leaves text at exactly the limit untouched', () => {
    expect(truncate('abcde', 5)).toBe('abcde');
  });

  it('appends an ellipsis when it cuts', () => {
    expect(truncate('a'.repeat(50), 10).endsWith('...')).toBe(true);
  });

  it('prefers to cut on a word boundary', () => {
    expect(truncate('crowd surge at the northern gate line', 20)).not.toContain('nort ');
  });

  it('never returns more than the limit plus the ellipsis', () => {
    const out = truncate('word '.repeat(100), 40);
    expect(out.length).toBeLessThanOrEqual(43);
  });
});
