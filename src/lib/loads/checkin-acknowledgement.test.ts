// ADR-0127 — the card the operator confirmed is the card that opens.
// ADR-0128 — and the load it opens carries the haul number.
//
// ## The incident
//
// 2026-08-25, Woodland. The 9:30 AM truck was Lake County Waste Solutions haul
// H-138155, carried by Ron Lawrence & Son. It was worked start to finish — 55
// minutes, 11 stacks, 135 units, submitted — on the RECOLOGY MOUNTAIN VIEW card
// H-138504, a different supplier on DR3's own transport account. The two slots
// sat adjacent on the queue (8:30 and 10:00 appointments) and one tap committed
// to one of them. ADR-0090 D1's haul chip was already on that card; a chip you
// are never asked about is a chip you do not read.
//
// ## What this file measures, and what it is therefore allowed to claim
//
// Every assertion is about OUR TYPESCRIPT: whether the server compares the
// acknowledgement, what it does when it disagrees, in what ORDER it compares it
// relative to the other guards, and what the child row carries. None of that is
// a claim about Postgres, so a mocked client is the right instrument — the same
// reasoning `late-arrival-reconcile.test.ts` sets out. The DB-level guarantees
// this path depends on (the UNIQUE indexes refusing a second mint) are proven in
// `load-claim.db.test.ts` and are untouched here.
//
// ## Why the acknowledgement is the haul NUMBER and not the slot id
//
// The id is what the operator TAPPED. The haul number is what they were SHOWN.
// The whole prevention is that the two are checked against each other, so
// restating the id would be a tautology — the exact shape ADR-0096 rejected when
// it refused `allowAnyDay: true`.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state, prismaMock } = vi.hoisted(() => {
  const state = {
    expected: null as Record<string, unknown> | null,
    created: null as Record<string, unknown> | null,
    audit: [] as Record<string, unknown>[],
    /** Set to a UNIQUE column name to make `create` lose that index. */
    createCollidesOn: null as string | null,
    /** What the post-collision re-read by `expected_load_id` finds. */
    existingChild: null as { id: string } | null,
  };
  const tx = {
    expectedLoad: { findUnique: async () => state.expected },
    inboundLoad: {
      create: async (args: { data: Record<string, unknown> }) => {
        if (state.createCollidesOn) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: [state.createCollidesOn] },
          });
        }
        state.created = args.data;
        return { id: 'new-load' };
      },
      findUnique: async () => null,
    },
    auditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        state.audit.push(args.data);
        return { id: 'audit-1' };
      },
    },
    // ADR-0120 — the workbook-promotion site lock. A fake cannot take a real
    // advisory lock; what it actually does is proven in
    // `src/lib/audit/promotion-lock.db.test.ts`.
    $executeRaw: async () => 0,
  };
  const prismaMock = {
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    inboundLoad: { findUnique: async () => state.existingChild },
    auditLog: { create: async () => ({ id: 'a' }) },
  };
  return { state, prismaMock };
});

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import { Prisma } from '@prisma/client';
import { startInboundLoad } from '@/lib/load-service';

/** 2026-08-25 09:45 PDT — the instant the wrong card was tapped. */
const NOW = new Date('2026-08-25T16:45:00.000Z');
/** Same Pacific day: the Lake County slot's 10:00 AM appointment. */
const TODAY_APPT = new Date('2026-08-25T17:00:00.000Z');

const SITE = 'site-woodland';
const OP = 'user-nate';
/** The slot the operator is standing in front of. */
const LAKE_COUNTY = 'H-138155';
/** The card next to it on the queue. */
const MT_VIEW = 'H-138504';

function slot(over: Record<string, unknown> = {}) {
  return {
    id: 'exp-h138155',
    site_id: SITE,
    cancelled_at: null,
    source_id: 'src-lake-county',
    transporter_id: 'tr-ron-lawrence',
    bol_number: null,
    external_mymrc_haul_id: LAKE_COUNTY,
    expected_arrival_at: TODAY_APPT,
    inbound_load: null,
    ...over,
  };
}

async function start(over: Record<string, unknown> = {}) {
  return startInboundLoad({
    expectedLoadId: 'exp-h138155',
    siteId: SITE,
    operatorUserId: OP,
    acknowledgedHaulId: LAKE_COUNTY,
    now: NOW,
    ...over,
  } as Parameters<typeof startInboundLoad>[0]);
}

beforeEach(() => {
  state.expected = slot();
  state.created = null;
  state.audit = [];
  state.createCollidesOn = null;
  state.existingChild = null;
});

describe('ADR-0127 — the acknowledged haul number is checked against the slot', () => {
  it('starts the load when the confirmed number IS this slot', async () => {
    const r = await start();
    expect(r).toEqual({ id: 'new-load', claimed: true });
    expect(state.created).toMatchObject({ status: 'arrived', assigned_operator_id: OP });
  });

  it('REFUSES when the page confirmed a different card', async () => {
    // The mechanism of the incident, expressed directly: the operator is holding
    // the Lake County truck's paperwork and the page they tapped describes Mt
    // View. Before ADR-0127 this minted the load and nothing said a word.
    await expect(start({ acknowledgedHaulId: MT_VIEW })).rejects.toMatchObject({
      status: 409,
      reason: 'haul_number_mismatch',
    });
    expect(state.created, 'no child load may be minted on a refused acknowledgement').toBeNull();
    expect(state.audit, 'and no audit row either — nothing happened').toHaveLength(0);
  });

  it('tolerates surrounding whitespace on both sides, and nothing else', async () => {
    // The value crosses an RSC boundary as text. Trimming is the one
    // normalisation applied; a case-insensitive or fuzzy compare would be a
    // guess wearing a check's clothes, and haul numbers are machine-issued.
    await expect(start({ acknowledgedHaulId: `  ${LAKE_COUNTY}\n` })).resolves.toMatchObject({
      claimed: true,
    });
    state.created = null;
    await expect(start({ acknowledgedHaulId: LAKE_COUNTY.toLowerCase() })).rejects.toMatchObject({
      reason: 'haul_number_mismatch',
    });
    expect(state.created).toBeNull();
  });

  it('checks the acknowledgement BEFORE handing back an already-claimed load', async () => {
    // Ordering is the safety property. `startInboundLoad` is idempotent on
    // `expected_load_id` and returns the existing child on a double-tap — but a
    // MISMATCH means the page no longer describes this slot, and handing back
    // somebody else's load in that state answers a question the operator did not
    // ask. The idempotent branch is for a double-tap on the RIGHT card.
    state.expected = slot({ inbound_load: { id: 'someone-elses-load' } });
    await expect(start({ acknowledgedHaulId: MT_VIEW })).rejects.toMatchObject({
      reason: 'haul_number_mismatch',
    });
    // And the same slot, correctly acknowledged, still returns the existing child.
    await expect(start()).resolves.toEqual({ id: 'someone-elses-load', claimed: false });
  });

  it('is checked on the ADR-0096 late-arrival path too, alongside the day', async () => {
    // The reconcile path is the NOISIER one — it already reads the haul number
    // back. Leaving it un-checked there would put the weaker guarantee on the
    // riskier control.
    state.expected = slot({ expected_arrival_at: new Date('2026-08-24T17:00:00.000Z') });
    await expect(
      start({
        acknowledgedHaulId: MT_VIEW,
        reconcile: { acknowledgedSlotDayISO: '2026-08-24' },
      }),
    ).rejects.toMatchObject({ reason: 'haul_number_mismatch' });
    await expect(
      start({ reconcile: { acknowledgedSlotDayISO: '2026-08-24' } }),
    ).resolves.toMatchObject({ claimed: true });
  });

  it('a cancelled or cross-site slot is still refused for ITS OWN reason', async () => {
    // The new guard must not shadow the existing ones — a withdrawn slot that
    // started answering `haul_number_mismatch` would send the operator to the
    // wrong remedy (reload the page, rather than call the office).
    state.expected = slot({ cancelled_at: new Date() });
    await expect(start()).rejects.toMatchObject({ reason: 'expected_load_cancelled' });
    state.expected = slot({ site_id: 'site-eugene' });
    await expect(start()).rejects.toMatchObject({ reason: 'expected_load_not_at_this_site' });
  });
});

describe('ADR-0128 — the dock load carries its haul number', () => {
  it('stamps `external_mymrc_haul_id` from the slot at check-in', async () => {
    // It was NULL on all 774 production loads (measured 2026-08-25) because only
    // the MyMRC bridge and the EOD add-line ever wrote it. The monthly
    // reconciliation upload matches on this column, so every dock-captured truck
    // fell out as `missing_in_dr3` against a load sitting in the same table.
    await start();
    expect(state.created).toMatchObject({ external_mymrc_haul_id: LAKE_COUNTY });
  });

  it('copies the value rather than leaning on the parent link', async () => {
    // A void severs `expected_load_id` (ADR-0090 C). If the haul number were only
    // reachable THROUGH that link, the void would take the answer with it — and
    // a re-pointed load would silently start reporting a different haul than the
    // one it was worked against.
    await start();
    expect(state.created).toMatchObject({
      expected_load_id: 'exp-h138155',
      external_mymrc_haul_id: LAKE_COUNTY,
    });
  });
});

// ── ADR-0128 — the concurrent double-tap can now lose on EITHER unique index ──
//
// `load-claim.db.test.ts` exercises this race against a real Postgres, but WHICH
// index Postgres reports first is not deterministic — that suite went green with
// the narrow predicate on one run and red on another. A race test that only
// sometimes reaches the branch is not a guard for it, so the branch is pinned
// here, by naming the losing index outright.
describe('ADR-0128 — a claim collision on the haul-number index is still a claim', () => {
  it('recovers from a P2002 on `external_mymrc_haul_id`, not just `expected_load_id`', async () => {
    // Two operators tap the same queue row inside the same second. Both compute
    // the same haul number, because it is derived 1:1 from the slot. The loser
    // may hit either index; a raw P2002 out of the server action is the opaque
    // digest ADR-0082 spent a whole section removing.
    state.createCollidesOn = 'external_mymrc_haul_id';
    state.existingChild = { id: 'the-winners-load' };
    await expect(start()).resolves.toEqual({ id: 'the-winners-load', claimed: false });
  });

  it('still recovers from the `expected_load_id` collision it always did', async () => {
    state.createCollidesOn = 'expected_load_id';
    state.existingChild = { id: 'the-winners-load' };
    await expect(start()).resolves.toEqual({ id: 'the-winners-load', claimed: false });
  });

  it('RE-THROWS a haul-id collision that is NOT a claim', async () => {
    // Widening the predicate must not turn into swallowing. If the re-read by
    // `expected_load_id` finds nothing, the collision was something else — a
    // bridge-created load already holding that number — and inventing an id for
    // it would be worse than the 500.
    state.createCollidesOn = 'external_mymrc_haul_id';
    state.existingChild = null;
    await expect(start()).rejects.toMatchObject({ code: 'P2002' });
  });

  it('does NOT absorb an unrelated unique constraint', async () => {
    // The reason this predicate is not a bare `code === 'P2002'`: reporting some
    // future index's collision as "someone else claimed it" is a wrong answer
    // wearing a right one's clothes.
    state.createCollidesOn = 'dr3_number';
    state.existingChild = { id: 'irrelevant' };
    await expect(start()).rejects.toMatchObject({ code: 'P2002' });
  });
});
