// ADR-0071 — the weekly digest: suppression, idempotency, and what gets said.
//
// The two guards that matter most:
//   1. Nobody flagged ⇒ NO email. An "all clear" every Monday trains recipients
//      to archive it unread, and the week it says something real goes with it.
//   2. A suppressed week still LEAVES A RECORD. Otherwise "nobody missed twice"
//      and "the cron never ran" are the same observation from the inbox.
//
// Every guard was falsified before being kept.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/notify/notify-staff', () => ({
  notifyStaff: vi.fn(async () => ({
    surfaceCode: 'processor_quota_digest',
    siteId: 'site-woodland',
    mode: 'live' as const,
    intendedRecipients: ['a@svdp.us'],
    actualRecipients: ['a@svdp.us'],
    sends: [],
    delivered: 1,
    disabled: false,
  })),
}));

import { notifyStaff } from '@/lib/notify/notify-staff';
import { renderQuotaDigestHtml, runProcessorQuotaDigest } from './processor-quota-digest';

const notifyStaffMock = vi.mocked(notifyStaff);
import { computeProcessorQuotaWeek } from './processor-quota';

const WEEK = '2026-07-20';
/** Monday 27 July — so the "last complete week" is the 20th–26th. */
const NOW = new Date('2026-07-27T14:00:00.000Z');

interface Entry {
  empId: string;
  name: string;
  dayISO: string;
  units: number;
}

// ADR-0071 Amendment 1 — this fixture used to return `[]` for a disabled config,
// faithfully mimicking the `where: { enabled: true }` the production query then
// carried. That made the fixture MORE permissive than the thing under test: the
// module could never observe a disabled row, so the twelve-day silence it caused
// was not merely untested, it was untestable. The real query now reads every
// config and checks `enabled` in code, so the double must hand back the row.
function fakeDb(entries: Entry[], opts: { enabled?: boolean; existingLog?: boolean } = {}) {
  const logs: Record<string, unknown>[] = [];
  const runs: Record<string, unknown>[] = [];
  const db = {
    createdLogs: logs,
    createdRuns: runs,
    processorQuotaConfig: {
      // The double APPLIES `where.enabled` the way Postgres would. Without that
      // it is more permissive than the real dependency, and the defect this
      // amendment fixes — `where: { enabled: true }` on the live query — stays
      // green no matter how it is reintroduced, because the fake hands back the
      // row either way. A mock that cannot express the bug cannot guard it.
      findMany: async (args?: { where?: { enabled?: boolean } }) =>
        [
          {
            id: 'cfg-1',
            site_id: 'site-woodland',
            enabled: opts.enabled !== false,
            quota_units: 75,
            min_misses: 2,
            site: { id: 'site-woodland', code: 'woodland', name: 'Woodland' },
            recipients: [
              { email: 'bill.barnard@svdp.us' },
              { email: 'morena.gomez@svdp.us' },
              { email: 'janette.tomas@svdp.us' },
            ],
          },
        ].filter((r) => args?.where?.enabled === undefined || r.enabled === args.where.enabled),
    },
    processorQuotaRun: {
      create: async (args: { data: Record<string, unknown> }) => {
        runs.push(args.data);
        return { id: 'run-1' };
      },
    },
    processorQuotaLog: {
      findUnique: async () => (opts.existingLog ? { suppressed: false, flagged_count: 3 } : null),
      create: async (args: { data: Record<string, unknown> }) => {
        logs.push(args.data);
        return { id: 'log-1' };
      },
    },
    bonusDailyEntry: {
      findMany: async (args: {
        where: { bonus_employee: { site_id: string }; entry_date: { gte: Date; lte: Date } };
      }) => {
        const gte = args.where.entry_date.gte.getTime();
        const lte = args.where.entry_date.lte.getTime();
        return entries
          .filter((e) => {
            const t = new Date(`${e.dayISO}T00:00:00.000Z`).getTime();
            return t >= gte && t <= lte;
          })
          .map((e) => ({
            entry_date: new Date(`${e.dayISO}T00:00:00.000Z`),
            mattress_count: e.units,
            bonus_employee: {
              id: e.empId,
              full_name: e.name,
              is_active: true,
              deleted_at: null,
            },
          }));
      },
    },
  };
  return db as never;
}

const FLAGGING: Entry[] = [
  { empId: 'e1', name: 'Zach Cassel', dayISO: '2026-07-20', units: 35 },
  { empId: 'e1', name: 'Zach Cassel', dayISO: '2026-07-21', units: 42 },
];
const CLEAN: Entry[] = [
  { empId: 'e1', name: 'Zach Cassel', dayISO: '2026-07-20', units: 90 },
  { empId: 'e1', name: 'Zach Cassel', dayISO: '2026-07-21', units: 88 },
];

beforeEach(() => vi.clearAllMocks());

describe('runProcessorQuotaDigest', () => {
  it('sends when someone is flagged', async () => {
    const db = fakeDb(FLAGGING);
    const [out] = await runProcessorQuotaDigest({ db, now: NOW });
    expect(out!.flaggedCount).toBe(1);
    expect(out!.suppressed).toBe(false);
    expect(notifyStaffMock).toHaveBeenCalledTimes(1);
  });

  it('sends NOTHING when nobody is flagged — silence means everyone met quota', async () => {
    const db = fakeDb(CLEAN);
    const [out] = await runProcessorQuotaDigest({ db, now: NOW });
    expect(out!.flaggedCount).toBe(0);
    expect(out!.suppressed).toBe(true);
    expect(notifyStaffMock).not.toHaveBeenCalled();
  });

  it('a suppressed week still leaves a record that it WAS evaluated', async () => {
    // Without this row, "nobody missed twice" and "the cron never ran" are the
    // same observation.
    const db = fakeDb(CLEAN) as unknown as { createdLogs: Record<string, unknown>[] };
    await runProcessorQuotaDigest({ db: db as never, now: NOW });
    expect(db.createdLogs).toHaveLength(1);
    expect(db.createdLogs[0]!['suppressed']).toBe(true);
    expect(db.createdLogs[0]!['flagged_count']).toBe(0);
    expect(db.createdLogs[0]!['processors_seen']).toBe(1);
  });

  it('does not mail the same week twice', async () => {
    const db = fakeDb(FLAGGING, { existingLog: true });
    const [out] = await runProcessorQuotaDigest({ db, now: NOW });
    expect(out!.alreadyEvaluated).toBe(true);
    expect(notifyStaffMock).not.toHaveBeenCalled();
  });

  // ── ADR-0071 Amendment 1: the twelve-day silence ────────────────────────
  //
  // These replace an earlier test that asserted a disabled config produced ZERO
  // outcomes. That assertion described the code accurately and described the
  // desired behaviour wrongly: it is exactly the state in which the cron fired
  // every morning from 2026-07-31 to 2026-08-11 and left no evidence anywhere,
  // and it was green the whole time.
  it('EVALUATES a disabled site — and still sends nothing', async () => {
    const db = fakeDb(FLAGGING, { enabled: false });
    const outs = await runProcessorQuotaDigest({ db, now: NOW });
    expect(outs).toHaveLength(1);
    expect(outs[0]!.skipped).toBe('disabled');
    // The number Bill could not see: what the digest WOULD have said.
    expect(outs[0]!.flaggedCount).toBe(1);
    expect(notifyStaffMock).not.toHaveBeenCalled();
  });

  // The landmine this amendment had to step around. `processor_quota_logs` is
  // unique on (site, week) and an existing row means "already sent". If a
  // disabled evaluation wrote one, it would claim every week it skipped, and the
  // morning the alert is switched on it would find the week already claimed and
  // stay silent — the guard eating the thing it guards.
  it('a disabled evaluation writes NO week log — it must not claim the week', async () => {
    const db = fakeDb(FLAGGING, { enabled: false }) as unknown as {
      createdLogs: Record<string, unknown>[];
    };
    await runProcessorQuotaDigest({ db: db as never, now: NOW });
    expect(db.createdLogs).toHaveLength(0);
  });

  it('a disabled run STILL writes a heartbeat — off must not look like dead', async () => {
    const db = fakeDb(FLAGGING, { enabled: false }) as unknown as {
      createdRuns: Record<string, unknown>[];
    };
    await runProcessorQuotaDigest({ db: db as never, now: NOW });
    expect(db.createdRuns).toHaveLength(1);
    expect(db.createdRuns[0]!['configs_total']).toBe(1);
    expect(db.createdRuns[0]!['configs_enabled']).toBe(0);
    expect(db.createdRuns[0]!['sites_evaluated']).toBe(1);
    expect(db.createdRuns[0]!['digests_sent']).toBe(0);
  });

  it('an ENABLED run that delivered records digests_sent — delivered, not attempted', async () => {
    const db = fakeDb(FLAGGING) as unknown as { createdRuns: Record<string, unknown>[] };
    await runProcessorQuotaDigest({ db: db as never, now: NOW });
    expect(db.createdRuns).toHaveLength(1);
    expect(db.createdRuns[0]!['configs_enabled']).toBe(1);
    expect(db.createdRuns[0]!['digests_sent']).toBe(1);
    expect(db.createdRuns[0]!['flagged_total']).toBe(1);
  });

  it('a send that reached NOBODY is not counted as a digest sent (ADR-0095)', async () => {
    notifyStaffMock.mockResolvedValueOnce({
      surfaceCode: 'processor_quota_digest',
      siteId: 'site-woodland',
      mode: 'pilot' as const,
      intendedRecipients: ['a@svdp.us'],
      actualRecipients: [],
      sends: [],
      delivered: 0,
      disabled: false,
    } as never);
    const db = fakeDb(FLAGGING) as unknown as {
      createdRuns: Record<string, unknown>[];
      createdLogs: Record<string, unknown>[];
    };
    await runProcessorQuotaDigest({ db: db as never, now: NOW });
    expect(db.createdRuns[0]!['digests_sent']).toBe(0);
    expect(db.createdLogs[0]!['sent_at']).toBeNull();
  });

  it('a dry run forges NO heartbeat — poking thresholds cannot fake a live cron', async () => {
    const db = fakeDb(FLAGGING) as unknown as { createdRuns: Record<string, unknown>[] };
    await runProcessorQuotaDigest({ db: db as never, now: NOW, dryRun: true });
    expect(db.createdRuns).toHaveLength(0);
  });

  it('a dry run evaluates but never sends and never logs', async () => {
    const db = fakeDb(FLAGGING) as unknown as { createdLogs: Record<string, unknown>[] };
    const [out] = await runProcessorQuotaDigest({ db: db as never, now: NOW, dryRun: true });
    expect(out!.flaggedCount).toBe(1);
    expect(notifyStaffMock).not.toHaveBeenCalled();
    expect(db.createdLogs).toHaveLength(0);
  });

  it('reports on the last COMPLETE week, not the one in progress', async () => {
    const db = fakeDb(FLAGGING);
    const [out] = await runProcessorQuotaDigest({ db, now: NOW });
    expect(out!.weekStartISO).toBe(WEEK);
    expect(out!.weekEndISO).toBe('2026-07-26');
  });

  it('goes through notifyStaff — never a raw send', async () => {
    const db = fakeDb(FLAGGING);
    await runProcessorQuotaDigest({ db, now: NOW });
    const args = notifyStaffMock.mock.calls[0]![0] as unknown as {
      surfaceCode: string;
      recipients: string[];
      site: { code: string };
    };
    expect(args.surfaceCode).toBe('processor_quota_digest');
    expect(args.site.code).toBe('woodland');
    expect(args.recipients).toEqual([
      'bill.barnard@svdp.us',
      'morena.gomez@svdp.us',
      'janette.tomas@svdp.us',
    ]);
  });
});

describe('renderQuotaDigestHtml', () => {
  it('names each miss day WITH its actual count', async () => {
    const week = await computeProcessorQuotaWeek(fakeDb(FLAGGING), {
      siteId: 'site-woodland',
      weekStartISO: WEEK,
      quota: 75,
      minMisses: 2,
    });
    const html = renderQuotaDigestHtml(week, 'Woodland');
    // The numbers are the point — they separate a slow slide from two bad days.
    expect(html).toContain('Zach Cassel');
    expect(html).toContain('35');
    expect(html).toContain('42');
    expect(html).toContain('Monday');
    expect(html).toContain('Tuesday');
  });

  it('states plainly that non-worked days are skipped', async () => {
    const week = await computeProcessorQuotaWeek(fakeDb(FLAGGING), {
      siteId: 'site-woodland',
      weekStartISO: WEEK,
      quota: 75,
      minMisses: 2,
    });
    const html = renderQuotaDigestHtml(week, 'Woodland');
    expect(html).toMatch(/never a miss/i);
    expect(html).toMatch(/two strikes needs two worked days/i);
  });

  it('escapes a name rather than injecting it as markup', async () => {
    const week = await computeProcessorQuotaWeek(
      fakeDb([
        { empId: 'x', name: '<script>alert(1)</script>', dayISO: '2026-07-20', units: 1 },
        { empId: 'x', name: '<script>alert(1)</script>', dayISO: '2026-07-21', units: 1 },
      ]),
      { siteId: 'site-woodland', weekStartISO: WEEK, quota: 75, minMisses: 2 },
    );
    const html = renderQuotaDigestHtml(week, 'Woodland');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
