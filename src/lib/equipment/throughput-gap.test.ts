// ADR-0087 — falsification-grade tests for the throughput-gap watchdog.
//
// Every test here is written to be capable of going RED against a plausible
// wrong implementation, not merely to pass against the one that exists. The
// three that matter most, and the specific defect each one falsifies:
//
//   · A recorded ZERO is RECORDED. `units_processed: 0` is a measurement (the
//     machine ran and produced nothing) and "nobody wrote it down" is the
//     ABSENCE of a row — ADR-0077 D4 / ADR-0079, restated. An implementation
//     that tested `units_processed > 0`, or that used a falsy check anywhere in
//     the chain, would nudge a manager who did exactly what was asked. The test
//     asserts BOTH the outcome and that the query carries no units predicate at
//     all, so the right answer cannot be reached for the wrong reason.
//   · Monday looks back to FRIDAY. A naive "yesterday" makes every Monday scan a
//     Sunday, find nothing (there never is anything), and alert every week — an
//     alert that fires on schedule regardless of the facts.
//   · The cutover boundary is a HARD floor. 2026-08-06 is the sheet era and must
//     stay silent; 2026-08-07 is the first day a gap is a gap.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// ── Mocks ────────────────────────────────────────────────────────────────────

const resolveSiteThroughputMachine = vi.fn();
vi.mock('./daily-throughput', () => ({
  resolveSiteThroughputMachine: (...a: unknown[]) => resolveSiteThroughputMachine(...a),
}));

const isUiSurfaceLive = vi.fn();
vi.mock('@/lib/notify/rollout', () => ({
  NOTIFY_SURFACE: { EQUIPMENT_THROUGHPUT_GAP: 'equipment_throughput_gap' },
  UI_SURFACE: { EQUIPMENT_ENTRY: 'equipment_entry' },
  isUiSurfaceLive: (...a: unknown[]) => isUiSurfaceLive(...a),
}));

const notifyStaff = vi.fn();
vi.mock('@/lib/notify/notify-staff', () => ({
  notifyStaff: (...a: unknown[]) => notifyStaff(...a),
}));

const publishNtfy = vi.fn();
vi.mock('@/lib/ntfy', () => ({ publishNtfy: (...a: unknown[]) => publishNtfy(...a) }));

// The module's default `db` argument. Every test passes an explicit fake, so this
// exists only so the import resolves.
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import {
  runThroughputGapScan,
  previousWorkingDayISO,
  isWorkingDayISO,
  renderThroughputGapHtml,
} from './throughput-gap';

// ── Fake DB ──────────────────────────────────────────────────────────────────

const WOODLAND = { id: 'site-w', code: 'woodland', name: 'Woodland' };
const MACHINE = { id: 'eq-terex', displayName: 'Terex' };

interface FakeState {
  sites: Array<{ id: string; code: string; name: string }>;
  holidays: string[];
  /** Live (non-voided) throughput rows, as `YYYY-MM-DD` → units. */
  recorded: Map<string, number>;
  /** Rows that exist but are VOIDED — must read as NOT recorded. */
  voided: Set<string>;
  /** Existing ledger rows, as `siteId|YYYY-MM-DD`. */
  ledger: Set<string>;
  roster: string[];
}

/** Captured query arguments, so a test can falsify HOW a question was asked. */
const captured: { throughputWhere: Record<string, unknown> | null } = { throughputWhere: null };

const ledgerCreate = vi.fn();

function fakeDb(state: FakeState): PrismaClient {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    site: { findMany: async () => state.sites },
    siteHoliday: {
      findMany: async () =>
        state.holidays.map((h) => ({ holiday_date: new Date(`${h}T00:00:00Z`) })),
    },
    equipmentThroughputGapAlert: {
      findUnique: async (args: {
        where: { site_id_gap_date: { site_id: string; gap_date: Date } };
      }) => {
        const key = `${args.where.site_id_gap_date.site_id}|${iso(args.where.site_id_gap_date.gap_date)}`;
        return state.ledger.has(key) ? { id: 'existing' } : null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        ledgerCreate(args.data);
        return { id: 'new' };
      },
    },
    equipmentDailyThroughput: {
      // The fake EVALUATES the where-clause rather than assuming its shape. That
      // is the difference between a test double and a rubber stamp: a fake that
      // ignores predicates it wasn't told about will happily return the right
      // answer to a WRONG query, and the outcome assertions built on it become
      // decorative. Concretely — an implementation that added
      // `units_processed: { gt: 0 }` must make the ZERO-day test go red HERE, on
      // the outcome, not only on the query-shape assertion below it.
      findFirst: async (args: { where: Record<string, unknown> }) => {
        captured.throughputWhere = args.where;
        const where = args.where;
        const day = iso(where['throughput_date'] as Date);

        // A voided row is simply not in the live result set — but only if the
        // caller actually asked for `voided_at: null`, exactly like Postgres.
        const excludesVoided = where['voided_at'] === null;
        const units = state.recorded.get(day);
        const exists = units !== undefined || (state.voided.has(day) && !excludesVoided);
        if (!exists) return null;

        // Honour a units predicate if one is present, so adding one is FATAL to
        // the zero-day test rather than invisible to it.
        const unitsPred = where['units_processed'] as
          | { gt?: number; gte?: number }
          | number
          | undefined;
        if (unitsPred !== undefined && units !== undefined) {
          if (typeof unitsPred === 'number' && units !== unitsPred) return null;
          if (typeof unitsPred === 'object') {
            if (unitsPred.gt !== undefined && !(units > unitsPred.gt)) return null;
            if (unitsPred.gte !== undefined && !(units >= unitsPred.gte)) return null;
          }
        }
        return { id: `row-${day}` };
      },
    },
    alertRecipient: {
      findMany: async () => state.roster.map((email) => ({ email })),
    },
  } as unknown as PrismaClient;
}

function state(overrides: Partial<FakeState> = {}): FakeState {
  return {
    sites: [WOODLAND],
    holidays: [],
    recorded: new Map(),
    voided: new Set(),
    ledger: new Set(),
    roster: ['morena@svdp.us'],
    ...overrides,
  };
}

/** 09:00 Pacific on the given Pacific calendar day (PDT = UTC-7 in August). */
function at9amPacific(dayISO: string): Date {
  return new Date(`${dayISO}T16:00:00Z`);
}

function liveSend(mode: 'live' | 'pilot' = 'live', delivered = 1, recipients = ['morena@svdp.us']) {
  return {
    mode,
    disabled: false,
    delivered,
    actualRecipients: recipients,
    intendedRecipients: recipients,
    sends: [{ delivered: delivered > 0, disabled: false, lastStatus: 202 }],
    surfaceCode: 'equipment_throughput_gap',
    siteId: WOODLAND.id,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  captured.throughputWhere = null;
  resolveSiteThroughputMachine.mockResolvedValue(MACHINE);
  isUiSurfaceLive.mockResolvedValue(true);
  notifyStaff.mockResolvedValue(liveSend());
});

// ── Pure calendar helpers ────────────────────────────────────────────────────

describe('working-day calendar', () => {
  it('Mon–Fri are working days; Sat/Sun are not', () => {
    expect(isWorkingDayISO('2026-08-07')).toBe(true); // Friday
    expect(isWorkingDayISO('2026-08-08')).toBe(false); // Saturday
    expect(isWorkingDayISO('2026-08-09')).toBe(false); // Sunday
    expect(isWorkingDayISO('2026-08-10')).toBe(true); // Monday
  });

  it('a site holiday is not a working day', () => {
    expect(isWorkingDayISO('2026-08-10', new Set(['2026-08-10']))).toBe(false);
  });

  it('Monday looks back to FRIDAY, never Sunday', () => {
    // The falsifying assertion for a naive `yesterday`: that implementation
    // returns 2026-08-09 (Sunday) here and alerts every single week.
    expect(previousWorkingDayISO('2026-08-10')).toBe('2026-08-07');
    expect(previousWorkingDayISO('2026-08-10')).not.toBe('2026-08-09');
  });

  it('Tuesday looks back to Monday', () => {
    expect(previousWorkingDayISO('2026-08-11')).toBe('2026-08-10');
  });

  it('steps over a holiday-flanked long weekend', () => {
    // Monday 2026-08-10 is a site holiday → Tuesday's scan asks about Friday.
    expect(previousWorkingDayISO('2026-08-11', new Set(['2026-08-10']))).toBe('2026-08-07');
  });

  it('returns null rather than looping when no working day is within reach', () => {
    const everyDay = new Set<string>();
    for (let d = 1; d <= 31; d++) everyDay.add(`2026-08-${String(d).padStart(2, '0')}`);
    for (let d = 1; d <= 31; d++) everyDay.add(`2026-07-${String(d).padStart(2, '0')}`);
    expect(previousWorkingDayISO('2026-08-20', everyDay)).toBeNull();
  });
});

// ── The cutover boundary ─────────────────────────────────────────────────────

describe('the ADR-0079 capture cutover is a hard floor', () => {
  it('does NOT alert for 2026-08-06 — the sheet era', async () => {
    // Friday 2026-08-07 scans back to Thursday 2026-08-06, which is < the
    // 2026-08-07 cutover. Before capture began, an absent row is not a gap.
    const s = state();
    const summary = await runThroughputGapScan(at9amPacific('2026-08-07'), fakeDb(s));

    expect(summary.outcomes).toEqual([
      { siteCode: 'woodland', status: 'skipped_pre_cutover', gapDateISO: '2026-08-06' },
    ]);
    expect(notifyStaff).not.toHaveBeenCalled();
    expect(ledgerCreate).not.toHaveBeenCalled();
  });

  it('DOES alert for a missed 2026-08-07 — the first capture-era working day', async () => {
    const s = state();
    const summary = await runThroughputGapScan(at9amPacific('2026-08-10'), fakeDb(s));

    expect(summary.outcomes).toEqual([
      {
        siteCode: 'woodland',
        status: 'alerted',
        gapDateISO: '2026-08-07',
        delivered: 1,
        attempted: 1,
      },
    ]);
    expect(notifyStaff).toHaveBeenCalledOnce();
  });

  it('the alert names the missed day and routes to the site equipment page', async () => {
    await runThroughputGapScan(at9amPacific('2026-08-10'), fakeDb(state()));

    const args = notifyStaff.mock.calls[0]![0] as {
      surfaceCode: string;
      subject: string;
      htmlBody: string;
      importance: string;
      recipients: string[];
      site: { id: string; code: string };
    };
    expect(args.surfaceCode).toBe('equipment_throughput_gap');
    expect(args.subject).toContain('2026-08-07');
    expect(args.subject).toContain('Terex');
    expect(args.htmlBody).toContain('/dashboard/woodland/equipment');
    expect(args.recipients).toEqual(['morena@svdp.us']);
    expect(args.site).toMatchObject({ id: 'site-w', code: 'woodland' });
    // ADR-0037 `default` severity — NOT high. A high-importance email about a
    // spreadsheet field teaches its reader to filter the sender.
    expect(args.importance).toBe('normal');
  });
});

// ── Weekend suppression ──────────────────────────────────────────────────────

describe('weekends', () => {
  it('a Saturday run is a clean no-op — no query, no send', async () => {
    const s = state();
    const summary = await runThroughputGapScan(at9amPacific('2026-08-08'), fakeDb(s));

    expect(summary).toEqual({
      scanDateISO: '2026-08-08',
      skippedWeekend: true,
      outcomes: [],
    });
    expect(notifyStaff).not.toHaveBeenCalled();
    expect(resolveSiteThroughputMachine).not.toHaveBeenCalled();
  });

  it('a Sunday run is a clean no-op', async () => {
    const summary = await runThroughputGapScan(at9amPacific('2026-08-09'), fakeDb(state()));
    expect(summary.skippedWeekend).toBe(true);
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it('the run day is the PACIFIC day, not the UTC one', async () => {
    // 2026-08-11T03:00Z is 20:00 PDT on Monday 2026-08-10. A UTC reading would
    // call this Tuesday and ask about Monday; the Pacific reading calls it Monday
    // and asks about Friday. This is the ADR-0065 / lib/time invariant.
    const summary = await runThroughputGapScan(new Date('2026-08-11T03:00:00Z'), fakeDb(state()));
    expect(summary.scanDateISO).toBe('2026-08-10');
    expect(summary.outcomes[0]?.gapDateISO).toBe('2026-08-07');
  });
});

// ── Recorded vs missing ──────────────────────────────────────────────────────

describe('what counts as recorded', () => {
  it('a recorded ZERO-units day counts as RECORDED — no alert', async () => {
    // THE falsification: an implementation that treated 0 as missing (a `> 0`
    // test, or any falsy check on units) alerts here and this goes red.
    const s = state({ recorded: new Map([['2026-08-07', 0]]) });
    const summary = await runThroughputGapScan(at9amPacific('2026-08-10'), fakeDb(s));

    expect(summary.outcomes).toEqual([
      { siteCode: 'woodland', status: 'skipped_recorded', gapDateISO: '2026-08-07' },
    ]);
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it('asks about ROW EXISTENCE and never about units — the query carries no units predicate', async () => {
    // The outcome assertion above can be satisfied for the wrong reason (a fake
    // that happens to return the row). This pins the QUESTION: the where-clause
    // must not mention units at all, so no future edit can reintroduce a
    // magnitude test and still pass the test above.
    await runThroughputGapScan(at9amPacific('2026-08-10'), fakeDb(state()));

    expect(captured.throughputWhere).not.toBeNull();
    expect(Object.keys(captured.throughputWhere!)).not.toContain('units_processed');
    expect(JSON.stringify(captured.throughputWhere)).not.toContain('units_processed');
  });

  it('a nonzero recorded day counts as recorded — no alert', async () => {
    const s = state({ recorded: new Map([['2026-08-07', 1063]]) });
    const summary = await runThroughputGapScan(at9amPacific('2026-08-10'), fakeDb(s));
    expect(summary.outcomes[0]?.status).toBe('skipped_recorded');
  });

  it('a day whose ONLY row was voided counts as MISSING — it alerts', async () => {
    // A soft-voided row does not hold the ADR-0079 partial-unique slot: the day
    // is genuinely re-enterable and genuinely not recorded.
    const s = state({ voided: new Set(['2026-08-07']) });
    const summary = await runThroughputGapScan(at9amPacific('2026-08-10'), fakeDb(s));

    expect(summary.outcomes[0]?.status).toBe('alerted');
    // And it alerts for the RIGHT reason: the query excluded voided rows.
    expect(captured.throughputWhere).toMatchObject({ voided_at: null });
  });

  it('scopes the question to the machine the registry resolved, at that site', async () => {
    await runThroughputGapScan(at9amPacific('2026-08-10'), fakeDb(state()));
    expect(captured.throughputWhere).toMatchObject({
      site_id: 'site-w',
      equipment_id: 'eq-terex',
    });
  });
});

// ── Suppression gates ────────────────────────────────────────────────────────

describe('never fires', () => {
  it('at a PILOT site — nobody there can reach the capture form', async () => {
    isUiSurfaceLive.mockResolvedValue(false);
    const summary = await runThroughputGapScan(at9amPacific('2026-08-10'), fakeDb(state()));

    expect(summary.outcomes).toEqual([
      { siteCode: 'woodland', status: 'skipped_site_pilot', gapDateISO: '2026-08-07' },
    ]);
    expect(notifyStaff).not.toHaveBeenCalled();
    expect(isUiSurfaceLive).toHaveBeenCalledWith('equipment_entry', 'site-w', expect.anything());
  });

  it('at a site with no machine — Eugene resolves to null and stays silent', async () => {
    resolveSiteThroughputMachine.mockResolvedValue(null);
    const summary = await runThroughputGapScan(at9amPacific('2026-08-10'), fakeDb(state()));

    expect(summary.outcomes).toEqual([
      { siteCode: 'woodland', status: 'skipped_no_machine', gapDateISO: '2026-08-07' },
    ]);
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it('on a site holiday — Tuesday after a holiday Monday asks about Friday', async () => {
    const s = state({ holidays: ['2026-08-10'], recorded: new Map([['2026-08-07', 900]]) });
    const summary = await runThroughputGapScan(at9amPacific('2026-08-11'), fakeDb(s));

    expect(summary.outcomes).toEqual([
      { siteCode: 'woodland', status: 'skipped_recorded', gapDateISO: '2026-08-07' },
    ]);
  });
});

// ── Dedupe / cooldown ────────────────────────────────────────────────────────

describe('one alert per site per missed day', () => {
  it('a second same-day run sends nothing and writes no second ledger row', async () => {
    const s = state();
    const db = fakeDb(s);

    const first = await runThroughputGapScan(at9amPacific('2026-08-10'), db);
    expect(first.outcomes[0]?.status).toBe('alerted');
    expect(ledgerCreate).toHaveBeenCalledOnce();

    // The real ledger's (site_id, gap_date) unique is what makes this true in
    // production; the fake reproduces it by recording the row the first run wrote.
    const written = ledgerCreate.mock.calls[0]![0] as { site_id: string; gap_date: Date };
    s.ledger.add(`${written.site_id}|${written.gap_date.toISOString().slice(0, 10)}`);

    const second = await runThroughputGapScan(at9amPacific('2026-08-10'), db);
    expect(second.outcomes).toEqual([
      { siteCode: 'woodland', status: 'skipped_already_alerted', gapDateISO: '2026-08-07' },
    ]);
    expect(notifyStaff).toHaveBeenCalledOnce(); // still ONE, from the first run
    expect(ledgerCreate).toHaveBeenCalledOnce();
  });

  it('the ledger row records the gap day, the machine, the mode and the counts', async () => {
    notifyStaff.mockResolvedValue(liveSend('pilot', 2, ['bill@barnardhq.com', 'admin@svdp.us']));
    await runThroughputGapScan(at9amPacific('2026-08-10'), fakeDb(state()));

    expect(ledgerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        site_id: 'site-w',
        equipment_id: 'eq-terex',
        notify_mode: 'pilot',
        recipient_count: 2,
        delivered_count: 2,
        last_status: 202,
      }),
    );
    const row = ledgerCreate.mock.calls[0]![0] as { gap_date: Date; scanned_on: Date };
    expect(row.gap_date.toISOString().slice(0, 10)).toBe('2026-08-07');
    expect(row.scanned_on.toISOString().slice(0, 10)).toBe('2026-08-10');
  });

  it('ONE alert per site — never one per machine', async () => {
    // The registry resolver returns AT MOST one machine per site by construction
    // (ADR-0077 D1), and the scan calls it once per site. Pinning the call count
    // is what keeps a future "loop over the site's terex-category rows" refactor
    // from fanning out five alerts at Woodland.
    await runThroughputGapScan(at9amPacific('2026-08-10'), fakeDb(state()));
    expect(resolveSiteThroughputMachine).toHaveBeenCalledOnce();
    expect(notifyStaff).toHaveBeenCalledOnce();
  });
});

// ── Delivery outcomes ────────────────────────────────────────────────────────

describe('delivery', () => {
  it('M365 disabled is a fail-open no-op — no ledger row, so the nudge is still owed', async () => {
    notifyStaff.mockResolvedValue({ ...liveSend(), disabled: true, delivered: 0 });
    const summary = await runThroughputGapScan(at9amPacific('2026-08-10'), fakeDb(state()));

    expect(summary.outcomes[0]?.status).toBe('disabled');
    expect(ledgerCreate).not.toHaveBeenCalled();
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('an empty recipient set writes no ledger row either', async () => {
    notifyStaff.mockResolvedValue({ ...liveSend(), delivered: 0, actualRecipients: [] });
    const summary = await runThroughputGapScan(at9amPacific('2026-08-10'), fakeDb(state()));

    expect(summary.outcomes[0]?.status).toBe('skipped_no_recipients');
    expect(ledgerCreate).not.toHaveBeenCalled();
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('0 delivered pages dr3-vision-system on the EXISTING topic, fingerprinted', async () => {
    notifyStaff.mockResolvedValue(liveSend('live', 0));
    const summary = await runThroughputGapScan(at9amPacific('2026-08-10'), fakeDb(state()));

    expect(summary.outcomes[0]?.status).toBe('failed');
    expect(publishNtfy).toHaveBeenCalledOnce();
    expect(publishNtfy).toHaveBeenCalledWith(
      expect.objectContaining({
        // Fleet rule: NEVER a new ntfy topic — a topic nobody is subscribed to is
        // a silent black hole. This is the existing system topic.
        topic: 'dr3-vision-system',
        fingerprint: 'throughput-gap-failed:woodland',
        cooldownMs: 6 * 60 * 60 * 1000,
      }),
    );
  });

  it('a successful nudge never pushes — hard rule #5, operational events are not ntfy', async () => {
    await runThroughputGapScan(at9amPacific('2026-08-10'), fakeDb(state()));
    expect(publishNtfy).not.toHaveBeenCalled();
  });
});

// ── Resilience ───────────────────────────────────────────────────────────────

describe('one site cannot silence the other', () => {
  it('a throwing site is logged and skipped; the next site still gets its nudge', async () => {
    const EUGENE = { id: 'site-e', code: 'eugene', name: 'Eugene' };
    resolveSiteThroughputMachine.mockImplementation(async (siteId: string) => {
      if (siteId === 'site-e') throw new Error('registry exploded');
      return MACHINE;
    });

    const summary = await runThroughputGapScan(
      at9amPacific('2026-08-10'),
      fakeDb(state({ sites: [EUGENE, WOODLAND] })),
    );

    expect(summary.outcomes).toEqual([
      {
        siteCode: 'woodland',
        status: 'alerted',
        gapDateISO: '2026-08-07',
        delivered: 1,
        attempted: 1,
      },
    ]);
    expect(notifyStaff).toHaveBeenCalledOnce();
  });
});

// ── Body ─────────────────────────────────────────────────────────────────────

describe('the nudge body', () => {
  it('names the day, says what to do today, and routes the missed day to the office', () => {
    const html = renderThroughputGapHtml(
      { code: 'woodland', name: 'Woodland' },
      'Terex',
      '2026-08-07',
    );
    expect(html).toContain('2026-08-07');
    expect(html).toContain('Terex');
    // ADR-0079 D4 refuses a backdated entry. An email that only said "please
    // enter it" would send the manager to a screen that tells them no.
    expect(html).toMatch(/cannot be typed in after the fact/i);
    expect(html).toMatch(/office/i);
  });

  it('escapes a hostile machine name rather than injecting it', () => {
    const html = renderThroughputGapHtml(
      { code: 'woodland', name: 'Woodland' },
      '<script>alert(1)</script>',
      '2026-08-07',
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
