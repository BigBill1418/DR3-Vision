import { describe, it, expect, vi } from 'vitest';
import {
  notifyInvariantReport,
  buildDigestBody,
  pageable,
  DIGEST_COOLDOWN_MS,
  PAGE_COOLDOWN_MS,
  type Publisher,
} from './notify';
import type { InvariantReport, InvariantRunResult } from './types';

function res(over: Partial<InvariantRunResult> = {}): InvariantRunResult {
  return {
    id: 'INV-001',
    title: 'a thing holds',
    adr: 'ADR-0037',
    tier: 'refusal',
    assumption: 'a sentence the ADR states',
    severity: 'default',
    remedy: 'do the thing',
    status: 'ok',
    subjectsChecked: 2,
    violations: [],
    durationMs: 5,
    vacuous: false,
    ...over,
  };
}

function report(
  results: InvariantRunResult[],
  over: Partial<InvariantReport> = {},
): InvariantReport {
  return {
    ranAt: '2026-09-10T15:00:00.000Z',
    durationMs: 42,
    results,
    counts: {
      ok: results.filter((r) => r.status === 'ok').length,
      violated: results.filter((r) => r.status === 'violated').length,
      indeterminate: results.filter((r) => r.status === 'indeterminate').length,
    },
    blind: false,
    ...over,
  };
}

type PublishResult = Awaited<ReturnType<Publisher>>;

// Typed against the real Publisher so `mock.calls[0][0]` keeps its shape — an
// `as never` spy erases the args tuple and every assertion below stops checking
// anything tsc can see.
const spy = () => vi.fn<Publisher>(async () => ({ ok: true, outcome: 'sent' }) as PublishResult);

describe('notifyInvariantReport - ADR-0131 D6 volume controls', () => {
  it('publishes NOTHING when every invariant passed - D6 steady state is silence', async () => {
    const p = spy();
    await notifyInvariantReport(report([res(), res({ id: 'INV-B' })]), p);
    expect(p).not.toHaveBeenCalled();
  });

  it('pages once per violated REFUSAL, each on its own fingerprint', async () => {
    const p = spy();
    await notifyInvariantReport(
      report([
        res({ id: 'INV-A', status: 'violated', violations: [{ subject: 'a', detail: 'x' }] }),
        res({ id: 'INV-B', status: 'violated', violations: [{ subject: 'b', detail: 'y' }] }),
      ]),
      p,
    );
    expect(p.mock.calls.map((c) => c[0].fingerprint)).toEqual([
      'invariant:INV-A',
      'invariant:INV-B',
    ]);
    for (const c of p.mock.calls) expect(c[0].cooldownMs).toBe(PAGE_COOLDOWN_MS);
  });

  it('carries the remedy and the pinned assumption in the page body', async () => {
    const p = spy();
    await notifyInvariantReport(
      report([
        res({
          id: 'INV-A',
          status: 'violated',
          remedy: 'seed the row',
          assumption: 'every surface has a row',
          violations: [{ subject: 'a', detail: 'x' }],
        }),
      ]),
      p,
    );
    expect(p.mock.calls[0]![0].body).toContain('REMEDY: seed the row');
    expect(p.mock.calls[0]![0].body).toContain('every surface has a row');
  });

  it('maps invariant severity onto ntfy priority', async () => {
    const p = spy();
    await notifyInvariantReport(
      report([
        res({
          id: 'INV-H',
          severity: 'high',
          status: 'violated',
          violations: [{ subject: 'a', detail: 'x' }],
        }),
        res({
          id: 'INV-D',
          severity: 'default',
          status: 'violated',
          violations: [{ subject: 'b', detail: 'y' }],
        }),
      ]),
      p,
    );
    expect(p.mock.calls.map((c) => c[0].priority)).toEqual(['high', 'default']);
  });

  it('NEVER pages a Tier B implausibility, whatever its severity says', async () => {
    // The absolute D1/D6 prohibition. `severity: 'urgent'` here is deliberate: the
    // tier must win, or the ban depends on every future author remembering it.
    const p = spy();
    await notifyInvariantReport(
      report([
        res({
          id: 'INV-FLOOR-WITHIN-CAPACITY',
          tier: 'implausibility',
          severity: 'urgent',
          status: 'violated',
          violations: [{ subject: 'woodland', detail: '333% of cap' }],
        }),
      ]),
      p,
    );
    const fps = p.mock.calls.map((c) => c[0].fingerprint);
    expect(fps).toEqual(['dr3-invariants-digest']);
    expect(p.mock.calls[0]![0].priority).toBe('default');
  });

  it('rolls indeterminate results into the digest rather than paging them', async () => {
    const p = spy();
    await notifyInvariantReport(
      report([
        res({ id: 'INV-A', status: 'indeterminate', note: 'db down' }),
        res({ id: 'INV-B' }),
      ]),
      p,
    );
    expect(p.mock.calls.map((c) => c[0].fingerprint)).toEqual(['dr3-invariants-digest']);
    expect(p.mock.calls[0]![0].cooldownMs).toBe(DIGEST_COOLDOWN_MS);
  });

  it('pages once when the suite is blind, and says so', async () => {
    const p = spy();
    await notifyInvariantReport(
      report([res({ status: 'indeterminate', note: 'boom' })], { blind: true }),
      p,
    );
    const fps = p.mock.calls.map((c) => c[0].fingerprint);
    expect(fps).toEqual(['dr3-invariants-blind', 'dr3-invariants-digest']);
    expect(p.mock.calls[0]![0].priority).toBe('high');
    expect(p.mock.calls[0]![0].title).toMatch(/BLIND/);
  });

  it('a refusal that is merely indeterminate does not page', async () => {
    const p = spy();
    await notifyInvariantReport(
      report([res({ id: 'INV-A', status: 'indeterminate', note: 'x' }), res({ id: 'INV-B' })]),
      p,
    );
    expect(p.mock.calls.map((c) => c[0].fingerprint)).not.toContain('invariant:INV-A');
  });
});

describe('pageable - the tier gate', () => {
  it('is true only for a violated refusal', () => {
    expect(pageable(res({ tier: 'refusal', status: 'violated' }))).toBe(true);
    expect(pageable(res({ tier: 'refusal', status: 'ok' }))).toBe(false);
    expect(pageable(res({ tier: 'refusal', status: 'indeterminate' }))).toBe(false);
    expect(pageable(res({ tier: 'implausibility', status: 'violated' }))).toBe(false);
  });
});

describe('buildDigestBody — the findings survive truncation', () => {
  it('puts violations before the pass tally', async () => {
    const body = buildDigestBody(
      report([
        res({ id: 'INV-001' }),
        res({
          id: 'INV-006',
          status: 'violated',
          adr: 'ADR-0037',
          violations: [{ subject: 'woodland', detail: '333% of cap' }],
        }),
      ]),
    );
    expect(body.indexOf('woodland')).toBeLessThan(body.indexOf('1 ok /'));
    expect(body).toContain('INV-006 [ADR-0037] VIOLATED');
    expect(body).toContain('  - woodland: 333% of cap');
  });

  it('separates COULD NOT CHECK from violated', () => {
    const body = buildDigestBody(
      report([res({ id: 'INV-002', status: 'indeterminate', note: 'examined 0 subjects' })]),
    );
    expect(body).toContain('COULD NOT CHECK:');
    expect(body).toContain('examined 0 subjects');
  });
});
