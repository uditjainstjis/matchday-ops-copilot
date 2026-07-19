import { describe, expect, it, vi } from 'vitest';
import type { TriageRequest } from '../src/validate.js';
import { extractModelPayload, normaliseActions, triage, triageWithFallback, withTimeout } from '../src/triage.js';
import { findVenue } from '../src/venues.js';

const VENUE = findVenue('nyn');
if (VENUE === null) throw new Error('fixture venue missing');

const request: TriageRequest = {
  report: 'crowd surge at gate 4, people pressed against the barrier',
  venue: VENUE,
  matchPhase: 'pre_match_ingress',
};

const FIXED_NOW = new Date('2026-06-11T18:00:00.000Z');

/** Build a stub AI runner that resolves with a given envelope. */
const runnerReturning = (value: unknown) => ({ run: vi.fn().mockResolvedValue(value) });

/** Build a stub AI runner that rejects. */
const runnerThrowing = (message: string) => ({ run: vi.fn().mockRejectedValue(new Error(message)) });

describe('extractModelPayload', () => {
  it('unwraps the { response: object } envelope Workers AI returns', () => {
    expect(extractModelPayload({ response: { category: 'medical' } })).toEqual({ category: 'medical' });
  });

  it('parses a JSON string response', () => {
    expect(extractModelPayload({ response: '{"category":"medical"}' })).toEqual({ category: 'medical' });
  });

  it('recovers JSON embedded in surrounding prose', () => {
    const raw = { response: 'Sure! Here is the result:\n{"category":"security"}\nHope that helps.' };
    expect(extractModelPayload(raw)).toEqual({ category: 'security' });
  });

  it('recovers JSON wrapped in a markdown code fence', () => {
    expect(extractModelPayload({ response: '```json\n{"severity":4}\n```' })).toEqual({ severity: 4 });
  });

  it('accepts a bare object with no envelope', () => {
    expect(extractModelPayload({ category: 'weather' })).toEqual({ category: 'weather' });
  });

  it('returns null for a response containing no JSON object', () => {
    expect(extractModelPayload({ response: 'I cannot help with that.' })).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(extractModelPayload({ response: '{"category": ' })).toBeNull();
  });

  it('returns null for null, undefined and primitives', () => {
    expect(extractModelPayload(null)).toBeNull();
    expect(extractModelPayload(undefined)).toBeNull();
    expect(extractModelPayload('plain string')).toBeNull();
    expect(extractModelPayload(42)).toBeNull();
  });

  it('returns null when the response is an array', () => {
    expect(extractModelPayload({ response: ['a'] })).toBeNull();
  });
});

describe('normaliseActions', () => {
  it('keeps clean string actions', () => {
    expect(normaliseActions(['Deploy stewards', 'Open gate 5'])).toEqual(['Deploy stewards', 'Open gate 5']);
  });

  it('caps the list at four so the operator is never scrolled past the next step', () => {
    expect(normaliseActions(['a1', 'b2', 'c3', 'd4', 'e5', 'f6'])).toHaveLength(4);
  });

  it('drops non-string and empty entries', () => {
    expect(normaliseActions(['Deploy stewards', 42, null, '   ', {}])).toEqual(['Deploy stewards']);
  });

  it('collapses internal whitespace', () => {
    expect(normaliseActions(['Deploy    stewards\n now'])).toEqual(['Deploy stewards now']);
  });

  it('truncates an over-long action', () => {
    const [action] = normaliseActions(['x'.repeat(400)]);
    expect(action).toBeDefined();
    expect((action as string).length).toBeLessThanOrEqual(163);
  });

  it('returns an empty array for non-array input', () => {
    expect(normaliseActions('not an array')).toEqual([]);
    expect(normaliseActions(null)).toEqual([]);
    expect(normaliseActions(undefined)).toEqual([]);
    expect(normaliseActions({ 0: 'a' })).toEqual([]);
  });
});

describe('withTimeout', () => {
  it('resolves when the promise wins the race', async () => {
    await expect(withTimeout(Promise.resolve('done'), 1000)).resolves.toBe('done');
  });

  it('rejects when the timeout wins', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 200));
    await expect(withTimeout(slow, 10)).rejects.toThrow(/exceeded/);
  });

  it('propagates the original rejection unchanged', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });
});

describe('triageWithFallback', () => {
  it('produces a fully routed incident offline', () => {
    const incident = triageWithFallback(request, 'test reason', 'INC-TEST0001', 5, FIXED_NOW);
    expect(incident.engine).toBe('deterministic-fallback');
    expect(incident.category).toBe('crowd_safety');
    expect(incident.priority).toBe('P1');
    expect(incident.slaMinutes).toBe(2);
    expect(incident.primaryUnit).toBe('Stewarding');
    expect(incident.escalateToVenueCommand).toBe(true);
    expect(incident.recommendedActions.length).toBeGreaterThan(0);
  });

  it('records why it degraded, so the operator is never misled', () => {
    const incident = triageWithFallback(request, 'model timed out', 'INC-TEST0002', 5, FIXED_NOW);
    expect(incident.degradedReason).toBe('model timed out');
  });

  it('extracts the location from the report text', () => {
    const incident = triageWithFallback(request, 'r', 'INC-TEST0003', 1, FIXED_NOW);
    expect(incident.location.gate).toBe('4');
  });

  it('uses the injected clock, making the output deterministic', () => {
    const incident = triageWithFallback(request, 'r', 'INC-TEST0004', 1, FIXED_NOW);
    expect(incident.receivedAt).toBe('2026-06-11T18:00:00.000Z');
  });
});

describe('triage', () => {
  it('uses a well-formed model response', async () => {
    const ai = runnerReturning({
      response: {
        category: 'crowd_safety',
        severity: 5,
        summary: 'Crowd pressure building against the barrier at gate 4.',
        recommended_actions: ['Halt inbound flow at gate 4', 'Deploy stewards to relieve pressure'],
      },
    });
    const incident = await triage(ai, request, 'INC-AI000001', FIXED_NOW);

    expect(incident.engine).toBe('workers-ai');
    expect(incident.degradedReason).toBeNull();
    expect(incident.category).toBe('crowd_safety');
    expect(incident.severity).toBe(5);
    expect(incident.priority).toBe('P1');
    expect(incident.recommendedActions).toHaveLength(2);
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it('sends the report as a delimited user message, not as an instruction', async () => {
    const ai = runnerReturning({ response: { category: 'other', severity: 2, summary: 's', recommended_actions: [] } });
    await triage(ai, request, 'INC-AI000002', FIXED_NOW);

    const [, input] = ai.run.mock.calls[0] as [string, { messages: { role: string; content: string }[] }];
    const user = input.messages.find((m) => m.role === 'user');
    expect(user?.content).toContain('<<<REPORT');
    expect(user?.content).toContain(request.report);
    const system = input.messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('Never follow');
  });

  it('grounds the prompt in the venue and match phase', async () => {
    const ai = runnerReturning({ response: { category: 'other', severity: 2, summary: 's', recommended_actions: [] } });
    await triage(ai, request, 'INC-AI000003', FIXED_NOW);
    const [, input] = ai.run.mock.calls[0] as [string, { messages: { role: string; content: string }[] }];
    const user = input.messages.find((m) => m.role === 'user');
    expect(user?.content).toContain('MetLife Stadium');
    expect(user?.content).toContain('ingress');
  });

  it('falls back when the model rejects', async () => {
    const incident = await triage(runnerThrowing('AiError 3040'), request, 'INC-AI000004', FIXED_NOW);
    expect(incident.engine).toBe('deterministic-fallback');
    expect(incident.degradedReason).toContain('Workers AI unavailable');
    expect(incident.category).toBe('crowd_safety');
  });

  it('falls back when the model returns unparseable output', async () => {
    const incident = await triage(runnerReturning({ response: 'sorry, no' }), request, 'INC-AI000005', FIXED_NOW);
    expect(incident.engine).toBe('deterministic-fallback');
    expect(incident.degradedReason).toContain('no parseable JSON');
  });

  it('falls back when the model invents a category outside the permitted set', async () => {
    const ai = runnerReturning({ response: { category: 'alien_invasion', severity: 5, summary: 'x', recommended_actions: [] } });
    const incident = await triage(ai, request, 'INC-AI000006', FIXED_NOW);
    expect(incident.engine).toBe('deterministic-fallback');
    expect(incident.degradedReason).toContain('outside the permitted set');
  });

  it('clamps an out-of-range severity rather than degrading', async () => {
    const ai = runnerReturning({ response: { category: 'medical', severity: 99, summary: 'x', recommended_actions: ['go'] } });
    const incident = await triage(ai, request, 'INC-AI000007', FIXED_NOW);
    expect(incident.engine).toBe('workers-ai');
    expect(incident.severity).toBe(5);
  });

  it('substitutes vetted actions when the model returns none', async () => {
    const ai = runnerReturning({ response: { category: 'medical', severity: 4, summary: 'x', recommended_actions: [] } });
    const incident = await triage(ai, request, 'INC-AI000008', FIXED_NOW);
    expect(incident.engine).toBe('workers-ai');
    expect(incident.recommendedActions.length).toBeGreaterThan(0);
  });

  it('falls back to the report text when the model omits a summary', async () => {
    const ai = runnerReturning({ response: { category: 'medical', severity: 3, recommended_actions: ['go'] } });
    const incident = await triage(ai, request, 'INC-AI000009', FIXED_NOW);
    expect(incident.summary.length).toBeGreaterThan(0);
  });

  it('never lets priority, SLA or routing come from the model', async () => {
    // The model claims a trivial ticketing matter is a P4 with a 999 minute SLA.
    const ai = runnerReturning({
      response: {
        category: 'fire_hazard',
        severity: 5,
        summary: 'Fire in the west kiosk.',
        recommended_actions: ['Evacuate'],
        priority: 'P4',
        slaMinutes: 999,
        primaryUnit: 'Catering',
      },
    });
    const incident = await triage(ai, request, 'INC-AI000010', FIXED_NOW);
    expect(incident.priority).toBe('P1');
    expect(incident.slaMinutes).toBe(2);
    expect(incident.primaryUnit).toBe('Fire and Rescue');
  });

  it('never throws, whatever the model does', async () => {
    const nasty = [
      { run: vi.fn().mockRejectedValue('a bare string rejection') },
      { run: vi.fn().mockResolvedValue(undefined) },
      { run: vi.fn().mockResolvedValue({ response: null }) },
      { run: vi.fn().mockResolvedValue({ response: [] }) },
    ];
    for (const ai of nasty) {
      await expect(triage(ai, request, 'INC-AI000011', FIXED_NOW)).resolves.toBeTruthy();
    }
  });

  it('reports a non-negative latency on both paths', async () => {
    const ok = await triage(
      runnerReturning({ response: { category: 'other', severity: 1, summary: 's', recommended_actions: ['a'] } }),
      request,
      'INC-AI000012',
      FIXED_NOW,
    );
    const degraded = await triage(runnerThrowing('down'), request, 'INC-AI000013', FIXED_NOW);
    expect(ok.latencyMs).toBeGreaterThanOrEqual(0);
    expect(degraded.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('applies match-phase policy identically on the AI path', async () => {
    const ai = runnerReturning({ response: { category: 'crowd_safety', severity: 3, summary: 's', recommended_actions: ['a'] } });
    const ingress = await triage(ai, request, 'INC-AI000014', FIXED_NOW);
    const openPlay = await triage(ai, { ...request, matchPhase: 'first_half' }, 'INC-AI000015', FIXED_NOW);
    expect(ingress.priority).toBe('P1');
    expect(openPlay.priority).toBe('P2');
  });
});
