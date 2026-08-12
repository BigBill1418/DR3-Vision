// ADR-0067 D9 — the anomaly raiser.
//
// The behaviour under test is the one the ADR calls out explicitly: dedup runs
// through a PARTIAL unique index (`WHERE status = 'open'`) that Prisma cannot
// express, so a bare `upsert` does not work and the raiser has to handle the
// conflict itself. The fake enforces that partial unique, so the P2002 fallback
// is genuinely exercised rather than assumed.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeAnomaly,
  anomalyFingerprint,
  anomalyPolicy,
  raiseAnomaly,
  resolveAnomaly,
  ANOMALY_REPAGE_INTERVAL_MS,
} from '../anomalies';
import {
  makeFakePrisma,
  resetFakeIds,
  type FakeDocIngestPrisma,
} from '../__testutils__/fake-prisma';

vi.mock('@/lib/ntfy', () => ({ publishNtfy: vi.fn(async () => ({ ok: true, outcome: 'sent' })) }));
import { publishNtfy } from '@/lib/ntfy';

const NOW = new Date('2026-07-29T12:00:00.000Z');

let prisma: FakeDocIngestPrisma;
const p = () => prisma as unknown as never;

beforeEach(() => {
  resetFakeIds();
  prisma = makeFakePrisma();
  vi.mocked(publishNtfy).mockClear();
});

describe('raiseAnomaly — dedup over the partial unique index', () => {
  it('opens one row and BUMPS it on repeat rather than growing a row-per-sweep queue', async () => {
    const args = {
      kind: 'access_denied' as const,
      subject: 'drive-A:item-1',
      detail: 'first observation',
    };

    const first = await raiseAnomaly(p(), { ...args, now: NOW });
    expect(first.raised).toBe(true);

    const second = await raiseAnomaly(p(), {
      ...args,
      detail: 'second observation',
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(second.raised).toBe(false);

    expect(prisma._stores.anomalies).toHaveLength(1);
    const row = prisma._stores.anomalies[0];
    expect(row?.['occurrences']).toBe(2);
    // The NEWEST detail is kept — a week-old count is not the useful one …
    expect(row?.['detail']).toBe('second observation');
    // … but `first_seen_at` is untouched, because "since when" is what says
    // whether this is new or has been rotting.
    expect(row?.['first_seen_at']).toEqual(NOW);
  });

  it('survives losing the insert race to a concurrent sweep (the P2002 fallback)', async () => {
    // Simulate the exact interleaving: the pre-check sees nothing, then another
    // process inserts before our create lands.
    const findFirst = prisma.docIngestAnomaly.findFirst.bind(prisma.docIngestAnomaly);
    let firstCall = true;
    prisma.docIngestAnomaly.findFirst = (async (args: Parameters<typeof findFirst>[0]) => {
      if (firstCall) {
        firstCall = false;
        // Our competitor wins the race here.
        await prisma.docIngestAnomaly.create({
          data: {
            kind: 'access_denied',
            fingerprint: anomalyFingerprint('access_denied', 'drive-A:item-1'),
            detail: 'from the other sweep',
            status: 'open',
            severity: 'critical',
          },
        });
        return null;
      }
      return findFirst(args);
    }) as typeof findFirst;

    const result = await raiseAnomaly(p(), {
      kind: 'access_denied',
      subject: 'drive-A:item-1',
      detail: 'ours',
      now: NOW,
    });

    // One row, bumped — not a thrown unique violation out of the sweep.
    expect(result.raised).toBe(false);
    expect(prisma._stores.anomalies).toHaveLength(1);
    expect(prisma._stores.anomalies[0]?.['occurrences']).toBe(2);
  });

  it('allows a NEW open row once the previous one is resolved — the history is retained', async () => {
    await raiseAnomaly(p(), { kind: 'access_denied', subject: 's', detail: 'x', now: NOW });
    await resolveAnomaly(p(), 'access_denied', 's', 'fixed', NOW);

    await raiseAnomaly(p(), { kind: 'access_denied', subject: 's', detail: 'again', now: NOW });

    expect(prisma._stores.anomalies).toHaveLength(2);
    expect(prisma._stores.anomalies.filter((a) => a['status'] === 'open')).toHaveLength(1);
    // The resolved row survives: it is the evidence a thing was wrong and got fixed.
    expect(prisma._stores.anomalies.filter((a) => a['status'] === 'resolved')).toHaveLength(1);
  });

  it('keeps different subjects apart under the same kind', async () => {
    await raiseAnomaly(p(), { kind: 'access_denied', subject: 'a', detail: 'x', now: NOW });
    await raiseAnomaly(p(), { kind: 'access_denied', subject: 'b', detail: 'y', now: NOW });
    expect(prisma._stores.anomalies).toHaveLength(2);
  });
});

describe('paging policy (ADR-0037 5-question gate)', () => {
  it('pages on the transition for an actionable kind', async () => {
    const result = await raiseAnomaly(p(), {
      kind: 'access_denied',
      subject: 's',
      detail: 'share revoked',
      now: NOW,
    });
    expect(result.paged).toBe(true);
    expect(publishNtfy).toHaveBeenCalledTimes(1);
    const call = vi.mocked(publishNtfy).mock.calls[0]?.[0];
    // ntfy is Bill-only + system-level events (hard rule #5).
    expect(call?.topic).toBe('dr3-vision-system');
    // This module owns dedup via `last_paged_at`; the in-process ledger must not
    // also suppress, or a container restart changes behaviour.
    expect(call?.cooldownMs).toBe(0);
  });

  it('NEVER pages for `unclassified` — that is the normal path for a new share', async () => {
    // Bill pre-registers nothing, so paging here would page on every share.
    expect(anomalyPolicy('unclassified').priority).toBeNull();
    const result = await raiseAnomaly(p(), {
      kind: 'unclassified',
      subject: 's',
      detail: 'waiting for confirmation',
      now: NOW,
    });
    expect(result.paged).toBe(false);
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('does not re-page a bump inside the cooldown, but does after it', async () => {
    await raiseAnomaly(p(), { kind: 'access_denied', subject: 's', detail: 'x', now: NOW });
    expect(publishNtfy).toHaveBeenCalledTimes(1);

    await raiseAnomaly(p(), {
      kind: 'access_denied',
      subject: 's',
      detail: 'x',
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(publishNtfy).toHaveBeenCalledTimes(1);

    await raiseAnomaly(p(), {
      kind: 'access_denied',
      subject: 's',
      detail: 'x',
      now: new Date(NOW.getTime() + ANOMALY_REPAGE_INTERVAL_MS + 1000),
    });
    expect(publishNtfy).toHaveBeenCalledTimes(2);
  });

  // ── ADR-0019.5 Am.1 — the ledger must record DELIVERY, not intention ──────
  //
  // These pin the incident of 2026-08-11. `maybePage` stamped `last_paged_at`
  // BEFORE publishing and ignored the result, so through the em-dash era every
  // doc-ingest page was discarded by undici while the row recorded a successful
  // page — and the stamp then armed the 24h window against a page that never
  // existed, suppressing the retry. Both assertions below fail on that code.

  it('does NOT stamp last_paged_at when the page was dropped', async () => {
    vi.mocked(publishNtfy).mockResolvedValueOnce({ ok: false, outcome: 'dropped' });

    const result = await raiseAnomaly(p(), {
      kind: 'access_denied',
      subject: 's',
      detail: 'x',
      now: NOW,
    });

    expect(publishNtfy).toHaveBeenCalledTimes(1);
    // The page did not land, so the anomaly was not paged …
    expect(result.paged).toBe(false);
    // … and nothing in the ledger may claim otherwise.
    expect(prisma._stores.anomalies[0]?.['last_paged_at']).toBeNull();
  });

  it('retries on the very next sweep after a drop, instead of waiting out the 24h window', async () => {
    vi.mocked(publishNtfy).mockResolvedValueOnce({ ok: false, outcome: 'dropped' });
    await raiseAnomaly(p(), { kind: 'access_denied', subject: 's', detail: 'x', now: NOW });
    expect(publishNtfy).toHaveBeenCalledTimes(1);

    // One sweep interval later — far inside the re-page cooldown. Under the old
    // code the dropped page had already stamped the row, so this was silently
    // suppressed and the condition went unreported for a full day.
    await raiseAnomaly(p(), {
      kind: 'access_denied',
      subject: 's',
      detail: 'x',
      now: new Date(NOW.getTime() + 15 * 60_000),
    });
    expect(publishNtfy).toHaveBeenCalledTimes(2);
    expect(prisma._stores.anomalies[0]?.['last_paged_at']).toEqual(
      new Date(NOW.getTime() + 15 * 60_000),
    );
  });

  it('treats a locally-suppressed page as delivered — cooldown and unconfigured must not spin', async () => {
    // `ok: true` with no request on the wire is a DELIBERATE local decision, not
    // a loss. Retrying these every sweep would hammer a publisher that is doing
    // exactly what it was told to do.
    for (const outcome of ['cooldown-suppressed', 'unconfigured'] as const) {
      resetFakeIds();
      prisma = makeFakePrisma();
      vi.mocked(publishNtfy).mockClear();
      vi.mocked(publishNtfy).mockResolvedValueOnce({ ok: true, outcome });

      const result = await raiseAnomaly(p(), {
        kind: 'access_denied',
        subject: 's',
        detail: 'x',
        now: NOW,
      });
      expect(result.paged).toBe(true);
      expect(prisma._stores.anomalies[0]?.['last_paged_at']).toEqual(NOW);
    }
  });

  it('grades the D7 guardrail kinds as critical and pageable — real money is at stake', () => {
    for (const kind of [
      'aggregate_variance',
      'column_nulled',
      'row_count_drop',
      'parse_broken',
    ] as const) {
      expect(anomalyPolicy(kind).severity).toBe('critical');
      expect(anomalyPolicy(kind).priority).toBe('high');
    }
  });

  it('grades push-path failures as NON-critical — the sweep covers correctness', () => {
    // Only latency degrades, so alarming here would be crying wolf.
    for (const kind of [
      'subscription_expired',
      'subscription_renew_failed',
      'webhook_validation_failed',
    ] as const) {
      expect(anomalyPolicy(kind).priority).toBe('default');
    }
    // But a dead SWEEP is a real emergency — it is the correctness guarantee.
    expect(anomalyPolicy('sweep_failed').priority).toBe('high');
    expect(anomalyPolicy('sweep_failed').severity).toBe('critical');
  });

  it('never marks anything `urgent` — none of this is customer-visible at 3 a.m.', () => {
    const kinds = [
      'access_denied',
      'owner_lost',
      'source_disappeared',
      'oversize',
      'unreadable',
      'sweep_failed',
      'aggregate_variance',
    ] as const;
    for (const kind of kinds) {
      expect(anomalyPolicy(kind).priority).not.toBe('urgent');
    }
  });
});

describe('acknowledge', () => {
  it('frees the partial index so a genuinely new occurrence can open a fresh row', async () => {
    const first = await raiseAnomaly(p(), {
      kind: 'access_denied',
      subject: 's',
      detail: 'x',
      now: NOW,
    });
    await acknowledgeAnomaly(p(), first.anomaly.id, 'user-1', NOW);

    await raiseAnomaly(p(), { kind: 'access_denied', subject: 's', detail: 'again', now: NOW });

    expect(prisma._stores.anomalies).toHaveLength(2);
    // Otherwise a new occurrence would silently bump a counter nobody watches.
    expect(prisma._stores.anomalies.filter((a) => a['status'] === 'open')).toHaveLength(1);
  });
});
