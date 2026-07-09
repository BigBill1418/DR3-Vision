import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// notifyStaff is the ADR-0047 chokepoint — mock it so no mail transport loads.
const notifyStaff = vi.fn();
vi.mock('@/lib/notify/notify-staff', () => ({
  notifyStaff: (...a: unknown[]) => notifyStaff(...a),
}));
// digest.ts and rollout.ts import the real prisma client at module load; stub it.
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  buildBoardPackPayload,
  isBoardPackSendDay,
  renderBoardPackHtml,
  sendBoardPackDigest,
  type SiteRef,
} from './digest';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const keyOf = (d: Date) => d.toISOString().slice(0, 10);
// A mid-day-Pacific INSTANT for `iso` — 19:00 UTC is 11:00/12:00 PT (PST/PDT),
// safely the same Pacific calendar day, so appToday(now) resolves back to `iso`.
const ptNoon = (iso: string) => new Date(`${iso}T19:00:00.000Z`);

const SITES: SiteRef[] = [
  { id: 'w', code: 'woodland', name: 'Woodland' },
  { id: 'e', code: 'eugene', name: 'Eugene' },
];

// ── Schedule predicate matrix ──────────────────────────────────────────

describe('isBoardPackSendDay (2nd Wednesday + preceding Monday, incl. DST edges)', () => {
  it.each([
    // July 2026 — 2nd Wed the 8th, preceding Mon the 6th.
    ['2026-07-08', true], // 2nd Wednesday
    ['2026-07-06', true], // preceding Monday
    ['2026-07-07', false], // Tuesday between — NOT a send day
    ['2026-07-01', false], // 1st Wednesday
    ['2026-07-15', false], // 3rd Wednesday
    // March 2026 — spring-forward is Mar 8; send days Mar 9/11 land after it.
    ['2026-03-11', true], // 2nd Wednesday
    ['2026-03-09', true], // preceding Monday
    ['2026-03-10', false], // Tuesday between
    // November 2026 — fall-back is Nov 1; send days Nov 9/11 land after it.
    ['2026-11-11', true], // 2nd Wednesday
    ['2026-11-09', true], // preceding Monday
    ['2026-11-10', false], // Tuesday between
    // January 2026.
    ['2026-01-14', true], // 2nd Wednesday
    ['2026-01-12', true], // preceding Monday
    ['2026-01-13', false], // Tuesday between
  ])('%s → %s', (d, expected) => {
    expect(isBoardPackSendDay(day(d))).toBe(expected);
  });
});

// ── Payload math on injected fixtures ──────────────────────────────────

/** Fake db whose processedUnitsDaily.findMany returns fixtures keyed by the
 * `production_date.gte` day (the window start) AND the queried site. */
function fakeStatsDb(fixtures: Record<string, Record<string, unknown[]>>) {
  return {
    processedUnitsDaily: {
      findMany: vi.fn(async (arg: { where: { production_date: { gte: Date }; site_id: string } }) => {
        const gte = keyOf(arg.where.production_date.gte);
        const siteId = arg.where.site_id;
        return fixtures[gte]?.[siteId] ?? [];
      }),
    },
  } as unknown as PrismaClient;
}

describe('buildBoardPackPayload', () => {
  const TODAY = day('2026-07-08'); // 2nd Wed July → prev month June 2026, YoY June 2025

  it('computes prev-month / MTD / YoY sums (stripped_program + non_program)', async () => {
    const db = fakeStatsDb({
      '2026-06-01': {
        w: [
          { stripped_program: 100, stripped_non_program: 50 },
          { stripped_program: 10.5, stripped_non_program: 0 },
        ],
        e: [{ stripped_program: 80, stripped_non_program: 0 }],
      },
      '2026-07-01': {
        w: [{ stripped_program: 20, stripped_non_program: 5 }],
        e: [{ stripped_program: 12, stripped_non_program: 3 }],
      },
      '2025-06-01': {
        w: [{ stripped_program: 140, stripped_non_program: 0 }],
        // eugene: no prior-year rows ⇒ YoY null.
      },
    });

    const payload = await buildBoardPackPayload(SITES, TODAY, db);

    expect(payload.prevMonthLabel).toBe('June 2026');
    expect(payload.mtdEndISO).toBe('2026-07-08');
    expect(keyOf(payload.periodStart)).toBe('2026-06-01');

    const w = payload.sites.find((s) => s.code === 'woodland')!;
    expect(w.prevMonthProduced).toBe(160.5);
    expect(w.mtdProduced).toBe(25);
    expect(w.yoyPrevMonthProduced).toBe(140);
    expect(w.yoyDelta).toBe(20.5);

    const e = payload.sites.find((s) => s.code === 'eugene')!;
    expect(e.prevMonthProduced).toBe(80);
    expect(e.mtdProduced).toBe(15);
    expect(e.yoyPrevMonthProduced).toBeNull(); // no prior-year history
    expect(e.yoyDelta).toBeNull();
  });

  it('renders the SVdP shell with the P&L placeholder and NO safety section', () => {
    const payload = {
      periodStart: day('2026-06-01'),
      prevMonthLabel: 'June 2026',
      mtdEndISO: '2026-07-08',
      sites: [
        {
          code: 'woodland',
          name: 'Woodland',
          prevMonthProduced: 160.5,
          mtdProduced: 25,
          yoyPrevMonthProduced: 140,
          yoyDelta: 20.5,
        },
      ],
    };
    const html = renderBoardPackHtml(payload, payload.prevMonthLabel);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('DR3 Board Pack');
    expect(html).toContain('June 2026');
    expect(html).toContain('Woodland');
    expect(html).toContain('160.5');
    expect(html).toContain('Financials: pending GP integration'); // P&L placeholder
    expect(html).toContain('svdp-logo-white.png'); // self-hosted public logo
    expect(html.toLowerCase()).not.toContain('safety');
    expect(html.toLowerCase()).not.toContain('injur');
  });
});

// ── Send: pilot routing + idempotency ──────────────────────────────────

function fakeSendDb(opts: { existingLog?: boolean }) {
  const create = vi.fn(async () => ({ id: 'log1' }));
  return {
    _create: create,
    boardPackSendLog: {
      findUnique: vi.fn(async () => (opts.existingLog ? { id: 'log1' } : null)),
      create,
    },
    boardPackRecipient: {
      findMany: vi.fn(async () => [{ email: 'bill.barnard@svdp.us' }, { email: 'bethany@svdp.us' }]),
    },
    site: {
      findMany: vi.fn(async () => SITES),
    },
    processedUnitsDaily: {
      findMany: vi.fn(async () => []),
    },
  } as unknown as PrismaClient & { _create: ReturnType<typeof vi.fn> };
}

describe('sendBoardPackDigest', () => {
  beforeEach(() => vi.clearAllMocks());

  it('no-op on a non-board-pack day', async () => {
    const result = await sendBoardPackDigest({ now: ptNoon('2026-07-07'), db: fakeSendDb({}) });
    expect(result).toEqual({ skipped: true, reason: 'not_board_pack_day' });
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it('routes through the gate (pilot ⇒ admins), writes the send-log with mode=pilot', async () => {
    notifyStaff.mockResolvedValue({
      surfaceCode: 'board_pack_digest',
      siteId: null,
      mode: 'pilot',
      intendedRecipients: ['bill.barnard@svdp.us', 'bethany@svdp.us'],
      actualRecipients: ['admin@svdp.us'],
      sends: [],
      delivered: 1,
      disabled: false,
    });
    const db = fakeSendDb({});
    const result = await sendBoardPackDigest({ now: ptNoon('2026-07-08'), db, sites: SITES });

    expect(notifyStaff).toHaveBeenCalledTimes(1);
    const arg = notifyStaff.mock.calls[0]![0];
    expect(arg).toMatchObject({ surfaceCode: 'board_pack_digest', site: null });
    expect(arg.recipients).toEqual(['bill.barnard@svdp.us', 'bethany@svdp.us']);

    expect(result).toMatchObject({ skipped: false, mode: 'pilot', periodStart: '2026-06-01', delivered: 1 });
    expect(db._create).toHaveBeenCalledTimes(1);
    expect(db._create.mock.calls[0]![0].data).toMatchObject({ mode: 'pilot', recipients_count: 2 });
    expect(keyOf(db._create.mock.calls[0]![0].data.period_start)).toBe('2026-06-01');
  });

  it('is idempotent — a re-fire for an already-sent period is a no-op', async () => {
    const db = fakeSendDb({ existingLog: true });
    const result = await sendBoardPackDigest({ now: ptNoon('2026-07-08'), db, sites: SITES });
    expect(result).toEqual({ skipped: true, reason: 'already_sent', periodStart: '2026-06-01' });
    expect(notifyStaff).not.toHaveBeenCalled();
    expect(db._create).not.toHaveBeenCalled();
  });

  it('does NOT persist the send-log when M365 is disabled (re-attempts later)', async () => {
    notifyStaff.mockResolvedValue({
      mode: 'pilot',
      intendedRecipients: ['bill.barnard@svdp.us'],
      actualRecipients: [],
      sends: [],
      delivered: 0,
      disabled: true,
    });
    const db = fakeSendDb({});
    const result = await sendBoardPackDigest({ now: ptNoon('2026-07-08'), db, sites: SITES });
    expect(result).toMatchObject({ skipped: true, reason: 'mail_disabled', periodStart: '2026-06-01' });
    expect(db._create).not.toHaveBeenCalled();
  });
});
