// ADR-0040 amendment (§3.3) — per-source effective-dated service-rate resolver. DB-free:
// drives the REAL resolver against an in-memory fake `ServiceRateResolverDb`. Covers:
// in-force selection by kind, the effective-date boundary (The Dalles rates start
// 2026-06-01), latest-window wins, same-effective_from tie → typed error, and
// no-rate-in-force → typed error (never a silent $0).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveSourceServiceRateCents,
  ServiceRateUnresolvableError,
  type ServiceRateKind,
  type ServiceRateResolverDb,
} from './service-rates';

interface Row {
  id: string;
  source_id: string;
  rate_kind: ServiceRateKind;
  effective_from: Date;
  effective_to: Date | null;
  rate_cents: number;
}

const rows: Row[] = [];
const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

const db: ServiceRateResolverDb = {
  sourceServiceRate: {
    findMany: async ({ where, take }) => {
      const lte = where.effective_from.lte.getTime();
      return rows
        .filter(
          (r) =>
            r.source_id === where.source_id &&
            r.rate_kind === where.rate_kind &&
            r.effective_from.getTime() <= lte &&
            (r.effective_to === null || r.effective_to.getTime() >= lte),
        )
        .sort((a, b) => b.effective_from.getTime() - a.effective_from.getTime())
        .slice(0, take);
    },
  },
};

const DALLES = 'src-the-dalles';

beforeEach(() => {
  rows.length = 0;
});

describe('resolveSourceServiceRateCents — selection', () => {
  it('resolves the in-force rate for a (source, kind) on a date', async () => {
    rows.push({
      id: 'r1',
      source_id: DALLES,
      rate_kind: 'trans',
      effective_from: D('2026-06-01'),
      effective_to: null,
      rate_cents: 15000,
    });
    const r = await resolveSourceServiceRateCents({
      sourceId: DALLES,
      kind: 'trans',
      date: D('2026-07-03'),
      db,
    });
    expect(r).toEqual({ cents: 15000, ref: { kind: 'source_service_rate', id: 'r1' } });
  });

  it('honors the effective-date boundary — The Dalles rate is unresolvable BEFORE 2026-06-01', async () => {
    rows.push({
      id: 'r1',
      source_id: DALLES,
      rate_kind: 'trailer',
      effective_from: D('2026-06-01'),
      effective_to: null,
      rate_cents: 20000,
    });
    // On the effective date it resolves…
    expect(
      (await resolveSourceServiceRateCents({ sourceId: DALLES, kind: 'trailer', date: D('2026-06-01'), db })).cents,
    ).toBe(20000);
    // …the day before, nothing is in force → typed error.
    await expect(
      resolveSourceServiceRateCents({ sourceId: DALLES, kind: 'trailer', date: D('2026-05-31'), db }),
    ).rejects.toMatchObject({ name: 'ServiceRateUnresolvableError', reason: 'no_rate_in_force' });
  });

  it('picks the LATEST effective window when several are in force', async () => {
    rows.push(
      {
        id: 'old',
        source_id: DALLES,
        rate_kind: 'per_mattress',
        effective_from: D('2026-01-01'),
        effective_to: null,
        rate_cents: 200,
      },
      {
        id: 'new',
        source_id: DALLES,
        rate_kind: 'per_mattress',
        effective_from: D('2026-06-01'),
        effective_to: null,
        rate_cents: 225,
      },
    );
    const r = await resolveSourceServiceRateCents({
      sourceId: DALLES,
      kind: 'per_mattress',
      date: D('2026-07-03'),
      db,
    });
    expect(r).toEqual({ cents: 225, ref: { kind: 'source_service_rate', id: 'new' } });
  });

  it('isolates by rate_kind — a trans rate never answers a trailer lookup', async () => {
    rows.push({
      id: 'r1',
      source_id: DALLES,
      rate_kind: 'trans',
      effective_from: D('2026-01-01'),
      effective_to: null,
      rate_cents: 15000,
    });
    await expect(
      resolveSourceServiceRateCents({ sourceId: DALLES, kind: 'trailer', date: D('2026-07-03'), db }),
    ).rejects.toMatchObject({ reason: 'no_rate_in_force' });
  });
});

describe('resolveSourceServiceRateCents — fail loud', () => {
  it('throws ambiguous_rate when two in-force rows share an effective_from', async () => {
    rows.push(
      {
        id: 'a',
        source_id: DALLES,
        rate_kind: 'mrc_unit',
        effective_from: D('2026-06-01'),
        effective_to: null,
        rate_cents: 500,
      },
      {
        id: 'b',
        source_id: DALLES,
        rate_kind: 'mrc_unit',
        effective_from: D('2026-06-01'),
        effective_to: null,
        rate_cents: 600,
      },
    );
    try {
      await resolveSourceServiceRateCents({ sourceId: DALLES, kind: 'mrc_unit', date: D('2026-07-03'), db });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceRateUnresolvableError);
      expect((e as ServiceRateUnresolvableError).reason).toBe('ambiguous_rate');
    }
  });

  it('throws no_rate_in_force when the source has no rows for the kind', async () => {
    await expect(
      resolveSourceServiceRateCents({ sourceId: 'unknown', kind: 'trans', date: D('2026-07-03'), db }),
    ).rejects.toMatchObject({ reason: 'no_rate_in_force' });
  });
});
