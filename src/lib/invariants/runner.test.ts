import { describe, it, expect } from 'vitest';
import { runInvariants } from './runner';
import type { Invariant, InvariantOutcome } from './types';

function inv(
  id: string,
  outcome: InvariantOutcome | (() => never),
  over: Partial<Invariant> = {},
): Invariant {
  return {
    id,
    title: `${id} title`,
    adr: 'ADR-0037',
    tier: 'refusal',
    assumption: 'a sentence the ADR states',
    severity: 'default',
    gate: 'q1 no / q2 no / q3 n-a / q4 per-subject / q5 /status -> default',
    remedy: 'do the thing',
    check: async () => (typeof outcome === 'function' ? outcome() : outcome),
    ...over,
  };
}

const ctx = { now: new Date('2026-09-10T15:00:00Z') };

describe('runInvariants — the vacuity guard', () => {
  it('rewrites an ok that examined ZERO subjects to indeterminate', async () => {
    const r = await runInvariants(
      [inv('INV-X', { status: 'ok', subjectsChecked: 0, violations: [] })],
      ctx,
    );
    const only = r.results[0]!;
    expect(only.status).toBe('indeterminate');
    expect(only.vacuous).toBe(true);
    expect(only.note).toMatch(/examined 0 subjects/i);
    expect(r.counts).toEqual({ ok: 0, violated: 0, indeterminate: 1 });
  });

  it('leaves an ok that examined subjects alone — the negative control', async () => {
    const r = await runInvariants(
      [inv('INV-Y', { status: 'ok', subjectsChecked: 2, violations: [] })],
      ctx,
    );
    expect(r.results[0]!.status).toBe('ok');
    expect(r.results[0]!.vacuous).toBe(false);
  });

  it('does NOT rewrite a violated result that reports zero subjects', async () => {
    // A violation is positive evidence; it cannot be vacuous.
    const r = await runInvariants(
      [
        inv('INV-Z', {
          status: 'violated',
          subjectsChecked: 0,
          violations: [{ subject: 's', detail: 'd' }],
        }),
      ],
      ctx,
    );
    expect(r.results[0]!.status).toBe('violated');
    expect(r.results[0]!.vacuous).toBe(false);
  });
});

describe('runInvariants — a broken invariant is cheap', () => {
  it('turns a THROW into indeterminate, never into a violation', async () => {
    const r = await runInvariants(
      [
        inv('INV-BOOM', () => {
          throw new TypeError('assertion is wrong');
        }),
      ],
      ctx,
    );
    const only = r.results[0]!;
    expect(only.status).toBe('indeterminate');
    expect(only.violations).toEqual([]);
    expect(only.note).toContain('TypeError');
    expect(only.note).toContain('assertion is wrong');
  });

  it('keeps running the remaining invariants after one throws', async () => {
    const r = await runInvariants(
      [
        inv('A', () => {
          throw new Error('nope');
        }),
        inv('B', { status: 'ok', subjectsChecked: 1, violations: [] }),
        inv('C', {
          status: 'violated',
          subjectsChecked: 1,
          violations: [{ subject: 'x', detail: 'y' }],
        }),
      ],
      ctx,
    );
    expect(r.results.map((x) => x.id)).toEqual(['A', 'B', 'C']);
    expect(r.counts).toEqual({ ok: 1, violated: 1, indeterminate: 1 });
  });
});

describe('runInvariants — blindness is its own state', () => {
  it('flags blind when EVERY invariant is indeterminate', async () => {
    const r = await runInvariants(
      [
        inv('A', () => {
          throw new Error('x');
        }),
        inv('B', { status: 'ok', subjectsChecked: 0, violations: [] }),
      ],
      ctx,
    );
    expect(r.blind).toBe(true);
  });

  it('is NOT blind when at least one invariant reached a verdict', async () => {
    const r = await runInvariants(
      [
        inv('A', () => {
          throw new Error('x');
        }),
        inv('B', { status: 'ok', subjectsChecked: 1, violations: [] }),
      ],
      ctx,
    );
    expect(r.blind).toBe(false);
  });

  it('is NOT blind on an empty registry, and says so', async () => {
    const r = await runInvariants([], ctx);
    expect(r.blind).toBe(false);
    expect(r.results).toEqual([]);
  });
});

describe('runInvariants — cost is reported', () => {
  it('records a duration for every invariant and for the run', async () => {
    const r = await runInvariants(
      [inv('A', { status: 'ok', subjectsChecked: 1, violations: [] })],
      ctx,
    );
    expect(r.results[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.ranAt).toBe(ctx.now.toISOString());
  });
});
