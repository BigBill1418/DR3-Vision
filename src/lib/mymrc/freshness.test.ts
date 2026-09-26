import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  assessFreshness,
  checkMirrorFreshness,
  DEFAULT_MAX_BUSINESS_DAYS,
  ESCALATE_BUSINESS_DAYS,
  FRESHNESS_COLUMN,
  FRESHNESS_COOLDOWN_MS,
  freshnessFingerprint,
  measureFeedFreshness,
} from './freshness';
import { GRADE_BY_KIND, type PageAlert, type Pager } from './ntfy';

// 18:00Z = 11:00 PDT, so this really is Friday 2026-07-31 in Pacific terms.
// It was `T01:00:00Z`, which is Thursday 2026-07-30 18:00 PDT — an hour-of-day that
// silently shifted every business-day count by one. Caught by this suite the first
// time the guard measured in days rather than in elapsed milliseconds.
const NOW = new Date('2026-07-31T18:00:00Z');
const DAY = 86_400_000;

/** The six closures Bill confirmed for both sites (prisma/seed/site_holidays.csv). */
const HOLIDAY_ROWS = [
  '2026-01-01',
  '2026-05-25',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
];
const NO_HOLIDAYS: ReadonlySet<string> = new Set<string>();
const HOLIDAYS: ReadonlySet<string> = new Set(HOLIDAY_ROWS);

// ── the pure threshold decision ──────────────────────────────────────────────

describe('assessFreshness — the pure staleness decision (ADR-0130 D6)', () => {
  // Measured in BUSINESS DAYS, not calendar hours. The 96 h rule fired on three
  // ordinary Mondays/Tuesdays in thirty-eight days because an ordinary Monday peaks
  // at 83-99 h against a 96 h threshold — the margin was hours, decided by what time
  // on Saturday MyMRC posted Friday's row.
  it('is fresh when the newest record is inside the window', () => {
    const f = assessFreshness('processed', new Date('2026-07-30T12:00:00Z'), NOW, HOLIDAYS);
    expect(f.stale).toBe(false);
    expect(f.businessDaysBehind).toBeLessThanOrEqual(DEFAULT_MAX_BUSINESS_DAYS);
  });

  it('is STALE past the threshold — the 2026-07-22 freeze is caught', () => {
    const f = assessFreshness('processed', new Date('2026-07-20T12:00:00Z'), NOW, HOLIDAYS);
    expect(f.stale).toBe(true);
    expect(f.businessDaysBehind).toBe(9);
    expect(Math.round((f.ageMs ?? 0) / DAY)).toBe(11);
  });

  it('does NOT fire on the three false 96h Mondays (the whole point of D6)', () => {
    // Every row of the ADR-0130 §3 age curve where the 96 h rule fired falsely,
    // replayed here. Independently reproduced against production `first_seen_at`
    // before this test was written: the ">2 business days" rule fires ONCE over
    // 2026-07-31..2026-09-07, on the real outage.
    const falseFires: Array<[string, string]> = [
      ['2026-07-31T12:00:00Z', '2026-08-04T18:00:00Z'], // Tue 08-04, peak 99h
      ['2026-08-13T12:00:00Z', '2026-08-17T18:00:00Z'], // Mon 08-17, peak 99h
      ['2026-09-03T12:00:00Z', '2026-09-07T18:00:00Z'], // Mon 09-07, peak 105h — Labor Day
    ];
    for (const [newest, now] of falseFires) {
      const f = assessFreshness('processed', new Date(newest), new Date(now), HOLIDAYS);
      expect(f.ageMs).toBeGreaterThan(96 * 3_600_000); // the 96h rule WOULD have fired
      expect(f.stale).toBe(false); // the business-day rule does not
    }
  });

  it('WITHOUT the holiday list, Labor Day is a false page again', () => {
    // The negative control for the holiday list. `site_holidays` is not decoration:
    // drop it and 2026-09-07 counts as a working Monday, the deficit becomes 2...
    // and on the Tuesday it would reach 3. This pins WHY the list is load-bearing.
    const newest = new Date('2026-09-03T12:00:00Z');
    const tuesday = new Date('2026-09-08T18:00:00Z');
    expect(assessFreshness('processed', newest, tuesday, HOLIDAYS).businessDaysBehind).toBe(2);
    expect(assessFreshness('processed', newest, tuesday, NO_HOLIDAYS).businessDaysBehind).toBe(3);
    expect(assessFreshness('processed', newest, tuesday, NO_HOLIDAYS).stale).toBe(true);
  });

  it('fires on the FRIDAY of a Wednesday freeze — earlier than 96h, not just quieter', () => {
    const frozen = new Date('2026-09-16T12:00:00Z'); // Wed
    const at = (iso: string) => assessFreshness('processed', frozen, new Date(iso), HOLIDAYS);
    expect(at('2026-09-18T18:00:00Z').stale).toBe(false); // Fri: 2 behind
    expect(at('2026-09-21T18:00:00Z').stale).toBe(true); // Mon: 3 behind
  });

  it('treats an EMPTY mirror as not-stale (bootstrap is owned by other guards)', () => {
    const f = assessFreshness('outbound', null, NOW, HOLIDAYS);
    expect(f).toEqual({
      feed: 'outbound',
      newest: null,
      ageMs: null,
      businessDaysBehind: null,
      stale: false,
    });
  });

  it('never marks a FUTURE-dated feed stale (hauls docking appointments)', () => {
    const f = assessFreshness('hauls', new Date('2026-08-04T12:00:00Z'), NOW, HOLIDAYS);
    expect(f.stale).toBe(false);
    expect(f.businessDaysBehind).toBe(0);
  });

  it('catches a hauls feed whose newest appointment has receded into the past', () => {
    expect(assessFreshness('hauls', new Date('2026-07-01T12:00:00Z'), NOW, HOLIDAYS).stale).toBe(
      true,
    );
  });

  it('honours an injected business-day threshold', () => {
    const newest = new Date('2026-07-28T12:00:00Z'); // Tue; NOW is Fri 07-31
    expect(assessFreshness('processed', newest, NOW, HOLIDAYS, 2).stale).toBe(true);
    expect(assessFreshness('processed', newest, NOW, HOLIDAYS, 5).stale).toBe(false);
  });
});

describe('the freshness contract', () => {
  it('measures each feed on its own BUSINESS date, never a column we write', () => {
    expect(FRESHNESS_COLUMN).toEqual({
      // ADR-0089 D3 (2026-08-10): the hauls key is the same COALESCE the inbound
      // bridge aggregates on — the recycler's reported delivery date, appointment
      // fallback. Measuring a different column than the bridge keys on is how the
      // guard certified a feed while 45% of the mirror was invisible to it.
      hauls: 'coalesce(recycler_reported_delivery_date, docking_appointment_date)',
      // ADR-0070 follow-up 2026-07-31: `haulsCompleted` reads the same mirror
      // through the HISTORY list view, so it measures the same business date.
      // Kept exact rather than loosened — a feed added without a business date
      // to measure must keep breaking this.
      haulsCompleted: 'coalesce(recycler_reported_delivery_date, docking_appointment_date)',
      processed: 'entry_date',
      outbound: 'entry_date',
    });
    // detail_fetched_at / last_seen_at refresh on re-reading a record we already
    // hold — they stayed green through the entire 9-day freeze.
    expect(Object.values(FRESHNESS_COLUMN)).not.toContain('detail_fetched_at');
    expect(Object.values(FRESHNESS_COLUMN)).not.toContain('last_seen_at');
  });

  it('pages at most once per SITE per day — one condition, one page (D8)', () => {
    // Was `mymrc-stale-mirror:<site>:<feed>`. `processed` and `outbound` freeze
    // together because they are one upstream stoppage, and the per-feed fingerprint
    // turned that into two pages an hour. ADR-0037 Q4 is deduplicate against ROOT
    // CAUSE, so the fingerprint is the site and the message names the feeds.
    expect(FRESHNESS_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
    expect(freshnessFingerprint('woodland')).toBe('mymrc-stale-mirror:woodland');
    expect(freshnessFingerprint('eugene')).not.toBe(freshnessFingerprint('woodland'));
  });
});

// ── measurement + paging over a fake Prisma ──────────────────────────────────

function fakePrisma(maxes: {
  hauls?: Date | null;
  processed?: Date | null;
  outbound?: Date | null;
  holidays?: string[];
}): PrismaClient {
  return {
    // ADR-0089 D3 — the hauls measurement is a raw max(COALESCE(delivery, appointment));
    // aggregate() is deliberately ABSENT on the hauls mirror so a revert to the
    // appointment-only aggregate breaks loudly here.
    $queryRaw: vi.fn(async () => [{ newest: maxes.hauls ?? null }]),
    mymrcProcessedMirror: {
      aggregate: vi.fn(async () => ({ _max: { entry_date: maxes.processed ?? null } })),
    },
    mymrcOutboundMirror: {
      aggregate: vi.fn(async () => ({ _max: { entry_date: maxes.outbound ?? null } })),
    },
    // ADR-0130 D6 — the operator-owned closure list. Two sites, identical rows, so
    // every date below is fleet-wide (observed at EVERY site), which is the only
    // kind that may pause the clock.
    site: { count: vi.fn(async () => 2) },
    siteHoliday: {
      findMany: vi.fn(async () =>
        (maxes.holidays ?? HOLIDAY_ROWS).flatMap((d: string) =>
          ['site-eugene', 'site-woodland'].map((site_id) => ({
            holiday_date: new Date(`${d}T00:00:00Z`),
            site_id,
          })),
        ),
      ),
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
    const at = (feed: 'processed' | 'outbound' | 'hauls') =>
      measureFeedFreshness({ prisma, feed, now: NOW, holidays: HOLIDAYS });
    expect((await at('processed')).stale).toBe(true);
    expect((await at('outbound')).stale).toBe(true);
    expect((await at('hauls')).stale).toBe(false);
  });
});

describe('checkMirrorFreshness — the alarm', () => {
  it('reproduces the live incident as ONE page naming both feeds (D8)', async () => {
    // Exactly the measured 2026-07-31 production state. Before D8 this emitted TWO
    // pages per site per hour — `processed` and `outbound` freezing together is one
    // upstream stoppage, and Bill's phone said so twice.
    const prisma = fakePrisma({
      processed: new Date('2026-07-20T12:00:00Z'),
      outbound: new Date('2026-07-21T12:00:00Z'),
      hauls: new Date('2026-08-04T12:00:00Z'),
    });
    const { pager, calls } = recordingPager();
    const out = await checkMirrorFreshness({ prisma, sites: ['woodland'], pager, now: NOW });

    expect(calls).toHaveLength(1);
    expect(
      out
        .filter((f) => f.stale)
        .map((f) => f.feed)
        .sort(),
    ).toEqual(['outbound', 'processed']);

    const c = calls[0]!;
    expect(c.kind).toBe('stale_mirror');
    expect(c.cooldownMs).toBe(FRESHNESS_COOLDOWN_MS);
    expect(c.fingerprint).toBe(freshnessFingerprint('woodland'));
    // No `feed` on the envelope — a combined page that claimed one feed in its
    // title would be lying about the other.
    expect(c.feed).toBeUndefined();
    // The message has to name what is stale, or the fingerprint change loses
    // information the per-feed pages carried.
    expect(c.message).toContain('processed');
    expect(c.message).toContain('outbound');
    expect(c.message).not.toContain('hauls');
  });

  it('escalates to `high` at >= 5 business days behind (§6 matrix)', async () => {
    // 9 business days behind on 2026-07-31 — the real outage. Below the threshold
    // it stays `default`: an internal reconciliation input is not a `high` on day 3.
    const deep = fakePrisma({ processed: new Date('2026-07-20T12:00:00Z') });
    const r1 = recordingPager();
    await checkMirrorFreshness({
      prisma: deep,
      sites: ['woodland'],
      pager: r1.pager,
      now: NOW,
      feeds: ['processed'],
    });
    expect(r1.calls[0]?.priority).toBe('high');

    // Three business days behind: stale, but not yet an escalation.
    // Tue 2026-07-28 -> Fri 2026-07-31 is Wed, Thu, Fri = 3 business days: stale
    // (> 2) but below the escalation line (>= 5).
    const shallow = fakePrisma({ processed: new Date('2026-07-28T12:00:00Z') });
    const r2 = recordingPager();
    await checkMirrorFreshness({
      prisma: shallow,
      sites: ['woodland'],
      pager: r2.pager,
      now: NOW,
      feeds: ['processed'],
    });
    expect(r2.calls).toHaveLength(1);
    expect(r2.calls[0]?.priority).toBeUndefined();
    expect(ESCALATE_BUSINESS_DAYS).toBe(5);
  });

  it('pages each site separately — one condition per site, not one for the fleet', async () => {
    const prisma = fakePrisma({ processed: new Date('2026-07-20T12:00:00Z') });
    const { pager, calls } = recordingPager();
    await checkMirrorFreshness({
      prisma,
      sites: ['woodland', 'eugene'],
      pager,
      now: NOW,
      feeds: ['processed'],
    });
    expect(calls.map((c) => c.fingerprint).sort()).toEqual([
      'mymrc-stale-mirror:eugene',
      'mymrc-stale-mirror:woodland',
    ]);
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
    // D6 — the page must state the unit it decided in, or the reader cannot tell
    // a real freeze from a long weekend.
    expect(calls[0]?.message).toMatch(/business day/i);
  });
});

describe('the masking defect this guard shipped with (2026-07-30 → fixed 07-31)', () => {
  // Measured live on 2026-07-31, mid-outage:
  //   max(docking_appointment_date) over ALL hauls  = 2026-08-10  (age -9 days)
  //   max(docking_appointment_date) over DELIVERED  = 2026-07-21  (age +10 days)
  //
  // A haul is `Confirmed` when it is SCHEDULED, and confirmed appointments are
  // dated into the FUTURE. So measuring every status made the feed look
  // permanently fresh while the delivered half had been frozen for nine days —
  // and `inbound_loads` is bridged from DELIVERED hauls, so that frozen half is
  // exactly what drove the floor to -3,493.
  const NOW = new Date('2026-07-31T18:00:00.000Z');

  it('a FUTURE-dated scheduling record must never be read as freshness', () => {
    const scheduledAhead = new Date('2026-08-10T12:00:00.000Z');
    const assessed = assessFreshness('hauls', scheduledAhead, NOW, HOLIDAYS);
    // This is what the old guard saw: a negative age, i.e. "fresher than now".
    expect(assessed.ageMs).toBeLessThan(0);
    expect(assessed.stale).toBe(false);
  });

  it('the DELIVERED date it should have been measuring IS stale', () => {
    // NOON-anchored, as the mirror actually stores it. Verified on production
    // 2026-09-07: `max(COALESCE(recycler_reported_delivery_date,
    // docking_appointment_date))` reads `2026-09-04 12:00:00`, and
    // `mymrc_processed_mirror.entry_date` reads `2026-09-03 12:00:00`. That anchor is
    // what makes the calendar day unambiguous in either zone — a midnight-UTC value
    // would read as the PREVIOUS Pacific day and overstate the deficit by one
    // business day.
    const newestDelivered = new Date('2026-07-21T12:00:00.000Z');
    const assessed = assessFreshness('hauls', newestDelivered, NOW, HOLIDAYS);
    expect(assessed.stale).toBe(true);
    // Ten calendar days — and, the number that now decides, seven business days.
    expect(assessed.ageMs! / 86_400_000).toBeGreaterThan(9);
    expect(assessed.businessDaysBehind).toBe(8);
  });
});

describe('the hauls guard must QUERY delivered hauls on the COALESCE key, not just reason about them', () => {
  // The pure-arithmetic tests above prove that a stale DELIVERED date would be
  // flagged. They do NOT prove the code asks the database the right question —
  // and that distinction was the whole bug TWICE: on 2026-07-31 the query
  // measured every status; ADR-0089 found it then measured the wrong COLUMN
  // (appointment date — null for the whole collection network, so 45% of the
  // mirror was invisible to the guard). Reverting either fix must break a test.
  function fakePrisma(captured: string[]) {
    return {
      $queryRaw: async (strings: TemplateStringsArray) => {
        captured.push(strings.join('?'));
        return [{ newest: new Date('2026-07-21T00:00:00.000Z') }];
      },
    } as never;
  }

  it('measures max(COALESCE(recycler delivery date, docking appointment date)) over Delivered', async () => {
    const captured: string[] = [];
    await measureFeedFreshness({
      prisma: fakePrisma(captured),
      feed: 'hauls',
      now: new Date('2026-07-31T18:00:00.000Z'),
    });
    expect(captured).toHaveLength(1);
    const sql = captured[0]!.replace(/\s+/g, ' ');
    expect(sql).toContain('COALESCE(recycler_reported_delivery_date, docking_appointment_date)');
    expect(sql).toContain("status = 'Delivered'");
  });

  it('and the delivered date it reads back IS reported stale', async () => {
    const captured: string[] = [];
    const res = await measureFeedFreshness({
      prisma: fakePrisma(captured),
      feed: 'hauls',
      now: new Date('2026-07-31T18:00:00.000Z'),
    });
    expect(res.stale).toBe(true);
  });
});

// ── ADR-0130 §6 — the grading matrix, pinned ─────────────────────────────────

describe('ADR-0130 §6 — the ADR-0037 grading matrix', () => {
  it('grades every MyMRC alert kind exactly as the ADR records it', () => {
    // Transcribed from ADR-0130 §6 rather than derived from the source, so this is
    // a genuine two-sided check: the table below is the SPEC, `GRADE_BY_KIND` is
    // the implementation, and a drift in either turns this red.
    //
    // The `Was` column of that table is `high` / 30 min for every row — a grade
    // nobody had re-examined since ADR-0038, and one that was NOMINAL ANYWAY:
    // published from a one-shot cron process, the cooldown was never enforced.
    const H = 60 * 60 * 1000;
    expect(GRADE_BY_KIND).toEqual({
      auth_failed: { priority: 'high', cooldownMs: 6 * H },
      contract_drift: { priority: 'high', cooldownMs: 24 * H },
      zero_anomaly: { priority: 'high', cooldownMs: 12 * H },
      deadman: { priority: 'high', cooldownMs: 12 * H },
      stale_mirror: { priority: 'default', cooldownMs: 24 * H },
      dateless_hauls: { priority: 'default', cooldownMs: 24 * H },
      // OPEN-ITEMS 0.CA (2026-09-25) — its own kind, so a manual backfill's gate
      // no longer reads as "MyMRC sync error".
      bridge_gate: { priority: 'high', cooldownMs: 6 * H },
      error: { priority: 'default', cooldownMs: 6 * H },
    });
  });

  it('publishes nothing at `urgent` — ADR-0037 reserves it for customer impact', () => {
    // Target is <=2/week. Every MyMRC alert is an internal ingestion signal about a
    // system that bills monthly; none of them is a 3 a.m. wake.
    expect(Object.values(GRADE_BY_KIND).map((g) => g.priority)).not.toContain('urgent');
  });

  it('stale_mirror is `default`, and the caller owns the >=5-business-day escalation', () => {
    // The storm was two `high` pages an hour. Even correctly cooled at 24 h, a
    // mirror four days behind is not a `high`: ADR-0037 Q2 is no — it is internal
    // reconciliation input, never customer-visible. The escalation to `high` is
    // condition-dependent (>= 5 business days, ADR-0130 D6), so it belongs to the
    // caller, which is why `PageAlert` carries an optional `priority` override.
    expect(GRADE_BY_KIND.stale_mirror.priority).toBe('default');
    expect(FRESHNESS_COOLDOWN_MS).toBe(GRADE_BY_KIND.stale_mirror.cooldownMs);
  });
});
