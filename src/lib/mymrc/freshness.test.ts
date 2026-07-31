import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  assessFreshness,
  checkMirrorFreshness,
  DEFAULT_MAX_AGE_MS,
  FRESHNESS_COLUMN,
  FRESHNESS_COOLDOWN_MS,
  freshnessFingerprint,
  measureFeedFreshness,
} from './freshness';
import type { PageAlert, Pager } from './ntfy';

const NOW = new Date('2026-07-31T01:00:00Z');
const DAY = 86_400_000;

// ── the pure threshold decision ──────────────────────────────────────────────

describe('assessFreshness — the pure staleness decision', () => {
  it('is fresh when the newest record is inside the window', () => {
    const f = assessFreshness('processed', new Date('2026-07-30T12:00:00Z'), NOW);
    expect(f.stale).toBe(false);
    expect(f.ageMs).toBeLessThan(DEFAULT_MAX_AGE_MS);
  });

  it('is STALE past the threshold — the 2026-07-22 freeze is caught', () => {
    // The live incident: newest processed entry_date was 2026-07-20 on 2026-07-31.
    const f = assessFreshness('processed', new Date('2026-07-20T12:00:00Z'), NOW);
    expect(f.stale).toBe(true);
    expect(Math.round((f.ageMs ?? 0) / DAY)).toBe(11);
  });

  it('would have fired on day 5 of the freeze, not on day 1', () => {
    const frozenAt = new Date('2026-07-20T12:00:00Z');
    const day = (n: number): Date => new Date(frozenAt.getTime() + n * DAY);
    expect(assessFreshness('processed', frozenAt, day(1)).stale).toBe(false);
    expect(assessFreshness('processed', frozenAt, day(4)).stale).toBe(false);
    expect(assessFreshness('processed', frozenAt, day(5)).stale).toBe(true);
  });

  it('treats an EMPTY mirror as not-stale (bootstrap is owned by other guards)', () => {
    const f = assessFreshness('outbound', null, NOW);
    expect(f).toEqual({ feed: 'outbound', newest: null, ageMs: null, stale: false });
  });

  it('never marks a FUTURE-dated feed stale (hauls docking appointments)', () => {
    const f = assessFreshness('hauls', new Date('2026-08-04T12:00:00Z'), NOW);
    expect(f.stale).toBe(false);
    expect(f.ageMs).toBeLessThan(0);
  });

  it('catches a hauls feed whose newest appointment has receded into the past', () => {
    expect(assessFreshness('hauls', new Date('2026-07-01T12:00:00Z'), NOW).stale).toBe(true);
  });

  it('honours an injected threshold', () => {
    const newest = new Date('2026-07-30T00:00:00Z');
    expect(assessFreshness('processed', newest, NOW, 12 * 3_600_000).stale).toBe(true);
    expect(assessFreshness('processed', newest, NOW, 72 * 3_600_000).stale).toBe(false);
  });
});

describe('the freshness contract', () => {
  it('measures each feed on its own BUSINESS date, never a column we write', () => {
    expect(FRESHNESS_COLUMN).toEqual({
      hauls: 'docking_appointment_date',
      processed: 'entry_date',
      outbound: 'entry_date',
    });
    // detail_fetched_at / last_seen_at refresh on re-reading a record we already
    // hold — they stayed green through the entire 9-day freeze.
    expect(Object.values(FRESHNESS_COLUMN)).not.toContain('detail_fetched_at');
    expect(Object.values(FRESHNESS_COLUMN)).not.toContain('last_seen_at');
  });

  it('pages at most once per site+feed per day (ADR-0037 Q4)', () => {
    expect(FRESHNESS_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
    expect(freshnessFingerprint('woodland', 'processed')).toBe(
      'mymrc-stale-mirror:woodland:processed',
    );
    expect(freshnessFingerprint('woodland', 'outbound')).not.toBe(
      freshnessFingerprint('woodland', 'processed'),
    );
  });
});

// ── measurement + paging over a fake Prisma ──────────────────────────────────

function fakePrisma(maxes: {
  hauls?: Date | null;
  processed?: Date | null;
  outbound?: Date | null;
}): PrismaClient {
  return {
    mymrcHaulsMirror: {
      aggregate: vi.fn(async () => ({ _max: { docking_appointment_date: maxes.hauls ?? null } })),
    },
    mymrcProcessedMirror: {
      aggregate: vi.fn(async () => ({ _max: { entry_date: maxes.processed ?? null } })),
    },
    mymrcOutboundMirror: {
      aggregate: vi.fn(async () => ({ _max: { entry_date: maxes.outbound ?? null } })),
    },
  } as unknown as PrismaClient;
}

function recordingPager(): { pager: Pager; calls: PageAlert[] } {
  const calls: PageAlert[] = [];
  return {
    calls,
    pager: {
      page: async (a: PageAlert): Promise<void> => {
        calls.push(a);
      },
    },
  };
}

describe('measureFeedFreshness — reads the right column per feed', () => {
  it('reads entry_date for processed and outbound, docking date for hauls', async () => {
    const prisma = fakePrisma({
      processed: new Date('2026-07-20T12:00:00Z'),
      outbound: new Date('2026-07-21T12:00:00Z'),
      hauls: new Date('2026-08-04T12:00:00Z'),
    });
    expect((await measureFeedFreshness({ prisma, feed: 'processed', now: NOW })).stale).toBe(true);
    expect((await measureFeedFreshness({ prisma, feed: 'outbound', now: NOW })).stale).toBe(true);
    expect((await measureFeedFreshness({ prisma, feed: 'hauls', now: NOW })).stale).toBe(false);
  });
});

describe('checkMirrorFreshness — the alarm', () => {
  it('reproduces the live incident: pages processed+outbound, stays quiet on hauls', async () => {
    // Exactly the measured 2026-07-31 production state.
    const prisma = fakePrisma({
      processed: new Date('2026-07-20T12:00:00Z'),
      outbound: new Date('2026-07-21T12:00:00Z'),
      hauls: new Date('2026-08-04T12:00:00Z'),
    });
    const { pager, calls } = recordingPager();
    const out = await checkMirrorFreshness({ prisma, sites: ['woodland'], pager, now: NOW });

    expect(calls.map((c) => c.feed).sort()).toEqual(['outbound', 'processed']);
    expect(
      out
        .filter((f) => f.stale)
        .map((f) => f.feed)
        .sort(),
    ).toEqual(['outbound', 'processed']);
    for (const c of calls) {
      expect(c.kind).toBe('stale_mirror');
      expect(c.cooldownMs).toBe(FRESHNESS_COOLDOWN_MS);
      expect(c.fingerprint).toBe(freshnessFingerprint('woodland', c.feed ?? 'processed'));
    }
  });

  it('is SILENT when every mirror is current', async () => {
    const prisma = fakePrisma({
      processed: new Date('2026-07-30T12:00:00Z'),
      outbound: new Date('2026-07-30T12:00:00Z'),
      hauls: new Date('2026-08-04T12:00:00Z'),
    });
    const { pager, calls } = recordingPager();
    const out = await checkMirrorFreshness({ prisma, sites: ['woodland'], pager, now: NOW });
    expect(calls).toEqual([]);
    expect(out.every((f) => !f.stale)).toBe(true);
  });

  it('never fails the sync when the pager throws', async () => {
    const prisma = fakePrisma({ processed: new Date('2026-07-01T12:00:00Z') });
    const pager: Pager = { page: async () => Promise.reject(new Error('ntfy down')) };
    await expect(
      checkMirrorFreshness({ prisma, sites: ['woodland'], pager, now: NOW }),
    ).resolves.toHaveLength(3);
  });

  it('names the record date in the alert body so the page is self-explaining', async () => {
    const prisma = fakePrisma({ processed: new Date('2026-07-20T12:00:00Z') });
    const { pager, calls } = recordingPager();
    await checkMirrorFreshness({
      prisma,
      sites: ['woodland'],
      pager,
      now: NOW,
      feeds: ['processed'],
    });
    expect(calls[0]?.message).toContain('2026-07-20');
    expect(calls[0]?.message).toContain('entry_date');
  });
});
