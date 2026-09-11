// The invariant runner. Executes every registered check, isolates failures, and
// enforces the two properties that make the result trustworthy:
//
//   1. a check that examined NOTHING cannot report `ok`;
//   2. a check that THREW cannot report `violated`.
//
// Both exist because the expensive failure here is not a missed violation — it is
// a false one. A wrong assertion that pages costs Bill trust in the whole suite,
// and a suite nobody trusts gets muted, which returns us to exactly the silence
// this was built to end. So the runner is deliberately asymmetric: it degrades
// toward `indeterminate` (say nothing confidently) rather than toward `violated`.

import type { Invariant, InvariantContext, InvariantReport, InvariantRunResult } from './types';

/** Hard ceiling on one check. A runaway query must not hold the daily run open. */
const CHECK_TIMEOUT_MS = 30_000;

function describeError(err: unknown): string {
  const e = err as { name?: string; message?: string };
  return `${e?.name ?? 'Error'}: ${(e?.message ?? String(err)).slice(0, 300)}`;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run every invariant. Never throws: the whole point is a report, and a runner
 * that can die mid-list hands back a partial picture that reads like a clean one.
 *
 * Checks run SEQUENTIALLY, not in parallel. This suite runs once a day against a
 * live production database that is also serving the floor; six aggregate scans
 * fired at once is a self-inflicted load spike to save a few hundred milliseconds
 * on a job nobody is waiting for. Cost is reported per check so the trade stays
 * visible rather than assumed.
 */
export async function runInvariants(
  invariants: readonly Invariant[],
  ctx: InvariantContext,
): Promise<InvariantReport> {
  const startedAt = Date.now();
  const results: InvariantRunResult[] = [];

  for (const inv of invariants) {
    const t0 = Date.now();
    let result: InvariantRunResult;
    try {
      const out = await withTimeout(inv.check(ctx), CHECK_TIMEOUT_MS, `invariant ${inv.id}`);

      // THE VACUITY GUARD. `ok` is a claim that subjects were examined and all of
      // them held. Zero subjects is not that claim — it is "my filter matched
      // nothing", which is equally consistent with a healthy system, a moved
      // column, a renamed enum value, or a row that does not exist yet. Reporting
      // it as `ok` is how a detector becomes unfalsifiable.
      const vacuous = out.status === 'ok' && out.subjectsChecked === 0;
      result = {
        ...out,
        ...(vacuous
          ? {
              status: 'indeterminate' as const,
              note: `examined 0 subjects, so "ok" would assert nothing${out.note ? ` — ${out.note}` : ''}`,
            }
          : {}),
        id: inv.id,
        title: inv.title,
        adr: inv.adr,
        tier: inv.tier,
        assumption: inv.assumption,
        severity: inv.severity,
        remedy: inv.remedy,
        durationMs: Date.now() - t0,
        vacuous,
      };
    } catch (err) {
      // A check that threw tells us about the CHECK, not about the data. It must
      // never surface as a violation — that would page Bill about production data
      // on the strength of a bug in the assertion.
      result = {
        status: 'indeterminate',
        subjectsChecked: 0,
        violations: [],
        note: describeError(err),
        id: inv.id,
        title: inv.title,
        adr: inv.adr,
        tier: inv.tier,
        assumption: inv.assumption,
        severity: inv.severity,
        remedy: inv.remedy,
        durationMs: Date.now() - t0,
        vacuous: false,
      };
    }
    results.push(result);
  }

  const counts = {
    ok: results.filter((r) => r.status === 'ok').length,
    violated: results.filter((r) => r.status === 'violated').length,
    indeterminate: results.filter((r) => r.status === 'indeterminate').length,
  };

  return {
    ranAt: ctx.now.toISOString(),
    durationMs: Date.now() - startedAt,
    results,
    counts,
    // An empty registry is not blindness, it is emptiness — `results.length > 0`
    // keeps a zero-invariant run from claiming the loudest state in the file.
    blind: results.length > 0 && counts.indeterminate === results.length,
  };
}
