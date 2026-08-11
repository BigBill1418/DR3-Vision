// ADR-0092 — falsification-grade tests for the stale-claim scan.
//
// Each of these is written to be capable of going RED against a plausible wrong
// implementation. The ones that matter most, and the defect each falsifies:
//
//   · A load being COUNTED right now is not stale. `addStack` does not touch the
//     parent row, so an implementation reading only `updated_at` reports an
//     operator mid-count as abandoned. This is the failure that would end the
//     feature's credibility in week one, so it is asserted on the outcome AND on
//     the shape of the query.
//   · One nudge per load, EVER — enforced by the database, not a timer. A scan
//     that re-fires because a container restarted must send nothing.
//   · A pilot site is silent. Where `ipad_queue` is pilot there are no real dock
//     claims to be stranded, and nudging about them is a bug wearing an email.
//   · Detection never reads units. Every stranded load has `total_units = NULL`
//     by definition, so any magnitude predicate goes blind on the whole target
//     population.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// ── Mocks ────────────────────────────────────────────────────────────────────

const isUiSurfaceLive = vi.fn();
vi.mock('@/lib/notify/rollout', () => ({
  NOTIFY_SURFACE: { LOAD_STALE_CLAIM: 'load_stale_claim' },
  UI_SURFACE: { IPAD_QUEUE: 'ipad_queue' },
  isUiSurfaceLive: (...a: unknown[]) => isUiSurfaceLive(...a),
}));

const notifyStaff = vi.fn();
vi.mock('@/lib/notify/notify-staff', () => ({
  notifyStaff: (...a: unknown[]) => notifyStaff(...a),
}));

const publishNtfy = vi.fn();
vi.mock('@/lib/ntfy', () => ({ publishNtfy: (...a: unknown[]) => publishNtfy(...a) }));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { runStaleClaimScan, renderStaleClaimHtml } from './stale-claim-scan';
import { STALE_NUDGE_MS } from './stale-claim';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const WOODLAND = { id: 'site-w', code: 'woodland', name: 'Woodland' };
const NOW = new Date('2026-08-11T23:45:00.000Z'); // 16:45 PDT
const H = 3_600_000;

/** A load row as the scan's `findMany` would return it. */
function loadRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'load-1',
    status: 'in_progress',
    updated_at: new Date(NOW.getTime() - 15 * H),
    assigned_operator_id: 'user-janette',
    assigned_at: new Date(NOW.getTime() - 15 * H),
    assigned_operator: { name: 'Janette Tomas' },
    expected_load: { external_mymrc_haul_id: 'H-136796', source_name_at_sync: 'HWMA' },
    load_stacks: [],
    load_photos: [],
    ...over,
  };
}

const captured: { loadWhere: Record<string, unknown> | null } = { loadWhere: null };

interface FakeState {
  loads: ReturnType<typeof loadRow>[];
  ledger: Set<string>;
  roster: string[];
}

function fakeDb(state: FakeState): PrismaClient {
  return {
    site: { findMany: async () => [WOODLAND] },
    inboundLoad: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        captured.loadWhere = args.where;
        return state.loads;
      },
    },
    staleClaimAlert: {
      findMany: async (args: { where: { load_id: { in: string[] } } }) =>
        args.where.load_id.in.filter((id) => state.ledger.has(id)).map((id) => ({ load_id: id })),
      createMany: async (args: { data: Array<{ load_id: string }> }) => {
        for (const d of args.data) state.ledger.add(d.load_id);
        return { count: args.data.length };
      },
    },
    alertRecipient: {
      findMany: async () => state.roster.map((email) => ({ email })),
    },
  } as unknown as PrismaClient;
}

function state(over: Partial<FakeState> = {}): FakeState {
  return {
    loads: [loadRow()],
    ledger: new Set<string>(),
    roster: ['morena@example.com'],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  captured.loadWhere = null;
  isUiSurfaceLive.mockResolvedValue(true);
  notifyStaff.mockResolvedValue({
    mode: 'pilot',
    intendedRecipients: ['morena@example.com'],
    actualRecipients: ['admin@example.com'],
    sends: [{ delivered: true, lastStatus: 202 }],
    delivered: 1,
    disabled: false,
  });
  publishNtfy.mockResolvedValue({ ok: true, outcome: 'sent' });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runStaleClaimScan — what it reports', () => {
  it('THE STRAND: a 15h-silent in_progress load is nudged once', async () => {
    const s = state();
    const summary = await runStaleClaimScan(NOW, fakeDb(s));

    expect(summary.outcomes[0]).toMatchObject({ siteCode: 'woodland', status: 'alerted' });
    expect(summary.outcomes[0]?.staleCount).toBe(1);
    expect(notifyStaff).toHaveBeenCalledTimes(1);
    expect(s.ledger.has('load-1')).toBe(true);
  });

  it('ONE EMAIL PER SITE, not one per load — ADR-0037 gate #4', async () => {
    // Three strands must not produce three separate mails. Deduplication against
    // the root cause ("the floor left loads open today") is a gate requirement,
    // and three mails is how a reader learns to filter the sender.
    const s = state({
      loads: [loadRow(), loadRow({ id: 'load-2' }), loadRow({ id: 'load-3' })],
    });
    const summary = await runStaleClaimScan(NOW, fakeDb(s));

    expect(notifyStaff).toHaveBeenCalledTimes(1);
    expect(summary.outcomes[0]?.staleCount).toBe(3);
    expect(s.ledger.size).toBe(3);
  });

  it('a load being COUNTED right now is not stale, even with a frozen parent row', async () => {
    // The false positive that would kill the feature. `updated_at` is 15h old —
    // an implementation reading only the parent row calls this abandoned — but
    // the operator laid down a stack four minutes ago.
    const s = state({
      loads: [
        loadRow({
          load_stacks: [{ created_at: new Date(NOW.getTime() - 4 * 60_000) }],
        }),
      ],
    });
    const summary = await runStaleClaimScan(NOW, fakeDb(s));

    expect(summary.outcomes[0]?.status).toBe('skipped_none');
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it('a photo taken minutes ago also keeps a load out of the report', async () => {
    const s = state({
      loads: [loadRow({ load_photos: [{ uploaded_at: new Date(NOW.getTime() - 10 * 60_000) }] })],
    });
    await runStaleClaimScan(NOW, fakeDb(s));
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it('a load just under the threshold stays quiet; just over is reported', async () => {
    const under = state({
      loads: [loadRow({ updated_at: new Date(NOW.getTime() - (STALE_NUDGE_MS - 60_000)) })],
    });
    await runStaleClaimScan(NOW, fakeDb(under));
    expect(notifyStaff).not.toHaveBeenCalled();

    vi.clearAllMocks();
    isUiSurfaceLive.mockResolvedValue(true);
    notifyStaff.mockResolvedValue({
      mode: 'live',
      intendedRecipients: ['m@e.com'],
      actualRecipients: ['m@e.com'],
      sends: [{ delivered: true, lastStatus: 202 }],
      delivered: 1,
      disabled: false,
    });
    const over = state({
      loads: [loadRow({ updated_at: new Date(NOW.getTime() - (STALE_NUDGE_MS + 60_000)) })],
    });
    await runStaleClaimScan(NOW, fakeDb(over));
    expect(notifyStaff).toHaveBeenCalledTimes(1);
  });
});

describe('runStaleClaimScan — what it must never do', () => {
  it('sends NOTHING when every stale load is already in the ledger', async () => {
    // The restart case. The cron re-firing, a hand-run curl, or a second cron
    // container must all be no-ops — the guarantee is a unique index on load_id,
    // not a wall-clock cooldown that a restart re-arms.
    const s = state({ ledger: new Set(['load-1']) });
    const summary = await runStaleClaimScan(NOW, fakeDb(s));

    expect(summary.outcomes[0]?.status).toBe('skipped_none');
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it('reports only the NEWLY stale when some are already known', async () => {
    const s = state({
      loads: [loadRow(), loadRow({ id: 'load-2' })],
      ledger: new Set(['load-1']),
    });
    const summary = await runStaleClaimScan(NOW, fakeDb(s));
    expect(summary.outcomes[0]?.staleCount).toBe(1);
  });

  it('stays silent at a site whose iPad queue is still PILOT', async () => {
    isUiSurfaceLive.mockResolvedValue(false);
    const s = state();
    const summary = await runStaleClaimScan(NOW, fakeDb(s));

    expect(summary.outcomes[0]?.status).toBe('skipped_site_pilot');
    expect(notifyStaff).not.toHaveBeenCalled();
    expect(s.ledger.size).toBe(0);
  });

  it('asks a question with NO units predicate anywhere in it', async () => {
    // Asserting the outcome alone would pass for the wrong reason. Every
    // stranded load has `total_units = NULL` by construction, so a magnitude
    // filter would go blind on exactly the population this exists to find.
    await runStaleClaimScan(NOW, fakeDb(state()));
    const w = JSON.stringify(captured.loadWhere ?? {});
    expect(w).not.toMatch(/total_units/);
    expect(w).not.toMatch(/expected_unit_count/);
    expect(w).not.toMatch(/program_unit_count/);
  });

  it('scopes to open, non-voided, CLAIMED loads at the site', async () => {
    await runStaleClaimScan(NOW, fakeDb(state()));
    expect(captured.loadWhere).toMatchObject({
      site_id: WOODLAND.id,
      voided_at: null,
      assigned_operator_id: { not: null },
    });
    // The open set is imported, never restated — `open-loads.ts` owns it.
    expect((captured.loadWhere as { status: { in: string[] } }).status.in).toContain('in_progress');
    expect((captured.loadWhere as { status: { in: string[] } }).status.in).not.toContain(
      'submitted',
    );
  });

  it('writes NO ledger row when M365 is disabled — the nudge stays owed', async () => {
    notifyStaff.mockResolvedValue({
      mode: 'live',
      intendedRecipients: [],
      actualRecipients: [],
      sends: [],
      delivered: 0,
      disabled: true,
    });
    const s = state();
    const summary = await runStaleClaimScan(NOW, fakeDb(s));

    expect(summary.outcomes[0]?.status).toBe('disabled');
    expect(s.ledger.size).toBe(0);
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('writes NO ledger row when there is nobody to send to', async () => {
    notifyStaff.mockResolvedValue({
      mode: 'live',
      intendedRecipients: [],
      actualRecipients: [],
      sends: [],
      delivered: 0,
      disabled: false,
    });
    const s = state({ roster: [] });
    const summary = await runStaleClaimScan(NOW, fakeDb(s));

    expect(summary.outcomes[0]?.status).toBe('skipped_no_recipients');
    expect(s.ledger.size).toBe(0);
  });
});

describe('the ntfy carve-out — the ONLY thing that pages', () => {
  it('does not page on a normal, delivered nudge', async () => {
    // Hard rule #5: operational events are in-app, never push. A stranded load
    // is the paradigm case ("long unloads, SLA breaches" are named in the rule).
    await runStaleClaimScan(NOW, fakeDb(state()));
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('pages ONLY when the nudge itself reached 0 recipients', async () => {
    // The alert channel breaking IS a system event — the same carve-out
    // alert-digest and throughput-gap make, on the same existing topic.
    notifyStaff.mockResolvedValue({
      mode: 'live',
      intendedRecipients: ['m@e.com'],
      actualRecipients: ['m@e.com'],
      sends: [{ delivered: false, lastStatus: 550 }],
      delivered: 0,
      disabled: false,
    });
    const s = state();
    const summary = await runStaleClaimScan(NOW, fakeDb(s));

    expect(summary.outcomes[0]?.status).toBe('failed');
    expect(publishNtfy).toHaveBeenCalledTimes(1);
    const call = publishNtfy.mock.calls[0]![0];
    expect(call.topic).toBe('dr3-vision-system');
    expect(call.fingerprint).toBe('stale-claim-failed:woodland');
    // Hours-scale, not minutes: a slow-moving condition re-reported every five
    // minutes is how a topic gets muted.
    expect(call.cooldownMs).toBeGreaterThanOrEqual(6 * H);
    // The ledger row IS written on a delivery failure — the send decision was
    // real, and re-sending tomorrow would re-report loads already reported.
    expect(s.ledger.has('load-1')).toBe(true);
  });
});

describe('renderStaleClaimHtml', () => {
  const rows = [
    {
      loadId: 'load-1',
      haulNumber: 'H-136796',
      sourceName: 'HWMA',
      holderName: 'Janette Tomas',
      status: 'in_progress',
      idleMs: 15.3 * H,
    },
  ];

  it('names the haul, the holder and how long it has been quiet', async () => {
    const html = renderStaleClaimHtml(WOODLAND, rows);
    expect(html).toContain('H-136796');
    expect(html).toContain('Janette Tomas');
    expect(html).toMatch(/15/);
  });

  it('carries a tier-1 click-through to the load itself (ADR-0036)', async () => {
    // The gate's question 5. A digest that says "three loads are stale" without
    // saying WHICH sends the reader hunting, and a link to a list is tier-2 when
    // a per-record URL is available.
    expect(renderStaleClaimHtml(WOODLAND, rows)).toContain('/operator/woodland/load/load-1');
  });

  it('never claims a unit count it does not have', async () => {
    // Stranded loads are uncounted by definition; printing "0 units" would read
    // as a measurement rather than an absence (the ADR-0077 D4 distinction).
    expect(renderStaleClaimHtml(WOODLAND, rows)).not.toMatch(/0 units/);
  });
});
