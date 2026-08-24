// ADR-0113 — a load can be refused after the counting has started.
//
// Bill, 2026-08-19: "we accepted a load as arrived — then found massive bed bugs
// — no path to go back and reject it."
//
// H-137759 (Ron Lawrence & Son) was accepted, the unload began, and the floor
// then found the infestation — past the only door out. `ALLOWED_PRIOR.rejected`
// stopped at `unload_started`, and the reject stage was mounted on that one
// status behind it. The load was closed by hand-audited DB rectification under
// `system:h137759-bedbug-rejection`, which is the DBA-shaped remedy ADR-0090 was
// written to retire.
//
// The properties these pin, in order of what they protect:
//   1. A rejected load NEVER carries units into anything — not through the load
//      (status allow-lists) and not through the stacks it already holds.
//   2. The refusal is EVIDENCED. Category, note-when-`other`, and a photo, all
//      enforced where a hand-crafted POST also meets them.
//   3. The stacks and the status move together or not at all.
//   4. The expected-load slot is RETAINED — the deliberate inversion of the
//      void, and the one a future reader is most likely to "fix" by analogy.
//   5. Only the holder may reject; the audit commits with the write and carries
//      the reason, which the old path never recorded anywhere.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LoadStatus, RejectionCategory } from '@prisma/client';

const {
  findUnique,
  update,
  updateMany,
  findUniqueOrThrow,
  writeAudit,
  writeAuditMany,
  $transaction,
  photoCount,
  stackFindMany,
  stackUpdateMany,
} = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  writeAudit: vi.fn(),
  writeAuditMany: vi.fn(),
  $transaction: vi.fn(),
  photoCount: vi.fn(),
  stackFindMany: vi.fn(),
  stackUpdateMany: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { inboundLoad: { findUnique, update }, $transaction },
}));
vi.mock('@/lib/audit', () => ({ writeAudit, writeAuditMany }));

import { rejectLoad, LoadAccessError } from './load-service';
import { OPEN_DOCK_STATUSES } from './loads/open-loads';
import { INVOICE_STATUSES } from './exports';
import { VERIFIED_INBOUND_STATUSES } from './inventory/running-balance';

const SITE = 'site-woodland';
const OP = 'user-jt';
const LOAD = 'load-h137759';
const SLOT = 'expected-h137759';

/** The tx handle the service is handed inside `$transaction`. */
const tx = {
  inboundLoad: { update, updateMany, findUniqueOrThrow },
  loadPhoto: { count: photoCount },
  loadStack: { findMany: stackFindMany, updateMany: stackUpdateMany },
};

function loadRow(over: Record<string, unknown> = {}) {
  return {
    id: LOAD,
    site_id: SITE,
    assigned_operator_id: OP,
    status: 'in_progress',
    arrived_at: new Date('2026-08-19T17:05:00.000Z'),
    unload_started_at: new Date('2026-08-19T17:12:00.000Z'),
    weight_lbs: null,
    expected_load_id: SLOT,
    ...over,
  };
}

/** One counted stack, the shape H-137759 actually held. */
const ONE_STACK = [{ id: 'stack-1', stack_index: 1, unit_count: 12 }];

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(loadRow());
  update.mockResolvedValue({ id: LOAD });
  // ADR-0118 — the guarded write reports how many rows it actually moved.
  updateMany.mockResolvedValue({ count: 1 });
  findUniqueOrThrow.mockResolvedValue({ status: 'in_progress' });
  writeAudit.mockResolvedValue(undefined);
  writeAuditMany.mockResolvedValue(undefined);
  photoCount.mockResolvedValue(1);
  stackFindMany.mockResolvedValue(ONE_STACK);
  stackUpdateMany.mockResolvedValue({ count: ONE_STACK.length });
  $transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
});

const reject = (over: Partial<Parameters<typeof rejectLoad>[0]> = {}) =>
  rejectLoad({
    loadId: LOAD,
    operatorUserId: OP,
    siteId: SITE,
    category: 'bedbugs',
    note: null,
    ...over,
  });

describe('rejectLoad — the transition that did not exist', () => {
  it('refuses a load that is already being counted (`in_progress`)', async () => {
    // THE headline. Before ADR-0113 this threw `illegal_transition`, which is
    // what turned an infested truck into a manual DB rectification.
    await reject();
    expect(updateMany).toHaveBeenCalledOnce();
    expect(updateMany.mock.calls[0]?.[0]?.data).toMatchObject({
      status: 'rejected',
      rejection_category: 'bedbugs',
    });
  });

  it('refuses a load whose unload has already FINISHED', async () => {
    // Bugs found while looking at the finished pile are found at `finished`.
    // Allowing `in_progress` and stopping there would rebuild the identical dead
    // end one stage further along — the same reasoning ADR-0090 D2.3 used to put
    // `finished` in the void's set.
    findUnique.mockResolvedValue(loadRow({ status: 'finished' }));
    await reject();
    expect(updateMany.mock.calls[0]?.[0]?.data).toMatchObject({ status: 'rejected' });
  });

  it.each(['arrived', 'weight_captured', 'unload_started'] as const)(
    'still refuses from the pre-count stage `%s`',
    async (status) => {
      // The early path is not traded away for the late one.
      findUnique.mockResolvedValue(loadRow({ status }));
      await reject();
      expect(updateMany.mock.calls[0]?.[0]?.data).toMatchObject({ status: 'rejected' });
    },
  );

  it.each(['submitted', 'verified', 'submitted_to_mymrc', 'processed', 'voided'] as const)(
    'refuses to reject from `%s` — past the floor is ADR-0073 territory',
    async (status) => {
      findUnique.mockResolvedValue(loadRow({ status }));
      await expect(reject()).rejects.toMatchObject({ status: 409 });
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it('the floor exit set is the SAME for reject, void and "still the floor\'s work"', () => {
    // Three lists that must agree, pinned in one place. A reject and a void are
    // the floor's two terminal exits and they are legal from exactly the states
    // where the load is still the floor's work — no more (past `submitted` a
    // load may sit on an MRC invoice) and no less (every stranded shape has a
    // remedy).
    //
    // Deliberately a PIN and not a shared constant. If a future change means to
    // make one exit narrower than the other, it should have to edit this test
    // and say why, rather than have the divergence arrive silently — or, worse,
    // have `reject` silently WIDEN because somebody added a status to
    // `OPEN_DOCK_STATUSES` for an unrelated reason.
    const expected = ['arrived', 'weight_captured', 'unload_started', 'in_progress', 'finished'];
    expect([...OPEN_DOCK_STATUSES]).toEqual(expected);
    // Read back through the only public surface: every status in the set is
    // accepted, and every status outside it is refused. Asserted above by the
    // two `it.each` blocks, which between them cover all 12 enum members bar
    // `expected` (never held by an operator) and `rejected` (the replay case).
    const covered = new Set([
      ...expected,
      'submitted',
      'verified',
      'submitted_to_mymrc',
      'processed',
      'voided',
      'expected',
      'rejected',
    ]);
    expect([...Object.values(LoadStatus)].filter((s) => !covered.has(s))).toEqual([]);
  });
});

describe('rejectLoad — the evidence', () => {
  it('REFUSES a rejection with no evidence photo', async () => {
    // This was a disabled button and nothing more: `stage-reject.tsx` gated on
    // `!hasPhoto` and the server never looked, so a hand-crafted POST could
    // refuse a truck with no evidence at all. A rejection is a contractual
    // assertion to the carrier and to MRC — the photo is the whole of the proof.
    photoCount.mockResolvedValue(0);
    await expect(reject()).rejects.toMatchObject({
      status: 422,
      reason: 'rejection_photo_required',
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(stackUpdateMany).not.toHaveBeenCalled();
  });

  it('does not count a PURGED photo as evidence', async () => {
    // R2 objects are purged on the retention schedule. A purged row is a record
    // that a photo once existed, not evidence anyone can look at.
    await reject();
    expect(photoCount.mock.calls[0]?.[0]?.where).toMatchObject({
      load_id: LOAD,
      kind: 'rejection',
      purged_at: null,
    });
  });

  it('requires a note when the category is `other`, and TRIMS it', async () => {
    // `other` with no note spends the category field and records nothing. Every
    // other category states a fact on its own — `bedbugs` needs no sentence.
    await expect(reject({ category: 'other', note: '   ' })).rejects.toMatchObject({
      status: 422,
      reason: 'rejection_note_required',
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('checks the note BEFORE the ownership read, so a 422 cannot probe for loads', async () => {
    // `voidLoad`'s ordering, for `voidLoad`'s reason: a malformed request must
    // not be usable to learn which load ids exist at a site.
    await expect(reject({ category: 'other', note: null })).rejects.toMatchObject({ status: 422 });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('accepts `other` WITH a note', async () => {
    await reject({ category: 'other', note: '  smells of diesel  ' });
    expect(updateMany.mock.calls[0]?.[0]?.data).toMatchObject({
      rejection_category: 'other',
      rejection_note: 'smells of diesel',
    });
  });
});

describe('rejectLoad — the counted stacks', () => {
  it('soft-voids every live stack in the SAME transaction as the status flip', async () => {
    // THE load-bearing assertion of this ADR. `rejected` is outside every money
    // allow-list, so the LOAD is already excluded — but the stacks would remain
    // the only rows in the database asserting that a refused truck delivered
    // units. Both `finishUnload` sum sites filter `voided_at IS NULL`.
    await reject();
    expect(stackUpdateMany).toHaveBeenCalledOnce();
    const call = stackUpdateMany.mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ load_id: LOAD, voided_at: null });
    expect(call?.data?.voided_by).toBe(OP);
    expect(call?.data?.voided_at).toBeInstanceOf(Date);
    // Same tx handle as the load update — not two writes that can half-happen.
    expect($transaction).toHaveBeenCalledOnce();
  });

  it('is a SOFT void — prior values are retained, nothing is deleted', async () => {
    // ADR-0090 Am.1's rule, and it matters here for a reason of its own: "we
    // counted 47 before we found the bugs" is evidence about the load, not a
    // mistake to erase.
    await reject();
    const data = stackUpdateMany.mock.calls[0]?.[0]?.data;
    expect(Object.keys(data as object).sort()).toEqual(['voided_at', 'voided_by']);
    expect(data).not.toHaveProperty('unit_count');
    expect(data).not.toHaveProperty('stack_index');
  });

  it('only touches stacks that are still LIVE', async () => {
    // A stack already taken back by hand (ADR-0090 Am.1 `voidStack`) keeps its
    // original `voided_at` and `voided_by`. The FIRST void is the one that
    // happened, here as everywhere else on this screen.
    await reject();
    expect(stackFindMany.mock.calls[0]?.[0]?.where).toMatchObject({ voided_at: null });
    expect(stackUpdateMany.mock.calls[0]?.[0]?.where).toMatchObject({ voided_at: null });
  });

  it('handles a load with nothing counted yet without an empty updateMany', async () => {
    stackFindMany.mockResolvedValue([]);
    await reject();
    expect(updateMany).toHaveBeenCalledOnce();
    expect(stackUpdateMany).not.toHaveBeenCalled();
    expect(writeAuditMany).not.toHaveBeenCalled();
  });
});

describe('rejectLoad — the slot is RETAINED, not severed', () => {
  it('leaves `expected_load_id` in place', async () => {
    // The deliberate inversion of ADR-0090 D2.2, and the single most likely
    // thing for a future reader to "fix" by analogy with the void.
    //
    // A VOID asserts the slot was never legitimately consumed — wrong haul, or
    // no truck — so the real haul must stay checkable-in. A REJECT asserts the
    // opposite: the truck came, against THIS haul, and we refused it. Severing
    // would offer the refused haul for a second check-in and mint a second child
    // for one physical delivery, which is the collision the UNIQUE index on
    // `expected_load_id` exists to prevent.
    //
    // A fumigated redelivery days later is a NEW haul with a new appointment and
    // a new MyMRC row — not a re-entry into the slot of the load we turned away.
    await reject();
    const data = updateMany.mock.calls[0]?.[0]?.data;
    expect(data).not.toHaveProperty('expected_load_id');
    expect(data).not.toHaveProperty('voided_from_expected_load_id');
  });
});

describe('rejectLoad — the audit', () => {
  it('writes the audit row INSIDE the transaction, carrying the REASON', async () => {
    // The old path went through `transition()`, whose audit `after` is
    // `{ status: 'rejected' }` and nothing else — so in the entire history of
    // this table no rejection's reason has ever reached the append-only log. The
    // category and note landed on the mutable `inbound_loads` row and nowhere
    // else, which is the one place a later correction can overwrite them.
    await reject({ note: 'live bugs in three mattresses' });
    expect(writeAudit).toHaveBeenCalledOnce();
    expect(writeAudit.mock.calls[0]?.[1]).toEqual({ tx });
    const row = writeAudit.mock.calls[0]?.[0];
    expect(row).toMatchObject({ actor_user_id: OP, table_name: 'inbound_loads', row_id: LOAD });
    expect(row?.after).toMatchObject({
      status: 'rejected',
      rejection_category: 'bedbugs',
      rejection_note: 'live bugs in three mattresses',
      stacks_voided: 1,
      units_voided: 12,
    });
  });

  it('records the BEFORE status and what the load was carrying', async () => {
    // Reconstructible from the append-only log rather than merely asserted by
    // it: which stage the refusal happened at, and how much had been counted.
    await reject();
    const row = writeAudit.mock.calls[0]?.[0];
    expect(row?.before).toMatchObject({
      status: 'in_progress',
      expected_load_id: SLOT,
      live_stacks: 1,
      live_units: 12,
    });
    // The retained slot is legible on BOTH sides — the readable difference from
    // a void's `before`, where it is severed.
    expect(row?.after).toMatchObject({ expected_load_id: SLOT });
  });

  it('writes one audit row per voided stack, BATCHED, inside the transaction', async () => {
    // Per-stack rows so "what happened to stack 7" stays answerable through the
    // `([table_name, row_id])` index — the shape `voidStack` writes by hand.
    //
    // Batched because ledger mode writes one `load_stacks` row per MATTRESS: a
    // 240-unit load means 240 sequential round trips inside an interactive
    // transaction, against Prisma's 5-second default timeout. The whole point of
    // one transaction is that it cannot half-happen.
    stackFindMany.mockResolvedValue([
      { id: 'stack-1', stack_index: 1, unit_count: 12 },
      { id: 'stack-2', stack_index: 2, unit_count: 9 },
    ]);
    await reject();
    expect(writeAuditMany).toHaveBeenCalledOnce();
    expect(writeAuditMany.mock.calls[0]?.[1]).toEqual({ tx });
    const rows = writeAuditMany.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ table_name: 'load_stacks', row_id: 'stack-1' });
    expect(rows[0]?.['before']).toMatchObject({ stack_index: 1, unit_count: 12 });
    expect(rows[0]?.['after']).toMatchObject({ voided_by: OP, reason: 'load_rejected' });
    expect(rows[1]).toMatchObject({ row_id: 'stack-2' });
  });
});

describe('rejectLoad — authorization and replay', () => {
  it('refuses a non-holder', async () => {
    // ADR-0090 D2.3 — the holder, full stop. A manager rejects by taking over
    // first (ADR-0082), which is audited and names both parties. Two places that
    // have to agree about who holds a load is the defect ADR-0082 removed.
    findUnique.mockResolvedValue(loadRow({ assigned_operator_id: 'user-someone-else' }));
    await expect(reject()).rejects.toMatchObject({
      status: 403,
      reason: 'load_not_assigned_to_operator',
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(stackUpdateMany).not.toHaveBeenCalled();
  });

  it('refuses a load at another site', async () => {
    findUnique.mockResolvedValue(loadRow({ site_id: 'site-eugene' }));
    await expect(reject()).rejects.toBeInstanceOf(LoadAccessError);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('LOSES to a concurrent write that moved the load between read and write', async () => {
    // ADR-0118, adopted here on the 2026-08-24 rebase. `assertOwn` reads the
    // status on the shared client; an unguarded `update({ where: { id } })`
    // would then write whatever the row had become. The floor makes that
    // ordinary rather than exotic — one load is reachable from the shared kiosk,
    // the operator's own iPad and the replay endpoint.
    //
    // `count === 0` means the WHERE's status no longer matched, so the rejection
    // is refused and names what it actually found, rather than stamping
    // `rejected` over a load somebody just finished or voided.
    updateMany.mockResolvedValue({ count: 0 });
    findUniqueOrThrow.mockResolvedValue({ status: 'voided' });
    await expect(reject()).rejects.toMatchObject({ status: 409 });
    // and nothing else in the transaction happened
    expect(stackUpdateMany).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('restates the authorised-FROM status in the WHERE, not just the id', async () => {
    await reject();
    expect(updateMany.mock.calls[0]?.[0]?.where).toEqual({
      id: LOAD,
      status: 'in_progress',
    });
  });

  it('sets `submitted_by_id` as a SCALAR, never a nested connect', async () => {
    // ADR-0115/0118 — `updateMany` accepts scalar fields only, and Prisma
    // rejects a nested relation write at ARGUMENT VALIDATION, before the query
    // is sent. That aborts the enclosing transaction and refuses the rejection
    // at runtime with nothing wrong in the data.
    await reject();
    const data = updateMany.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data['submitted_by_id']).toBe(OP);
    expect(data).not.toHaveProperty('submitted_by');
  });

  it('is a silent NO-OP on an already-rejected load, not a 409', async () => {
    // The screen is reachable from a stale tab, and the FIRST rejection is the
    // one that happened — a second tap must not overwrite its category, note,
    // actor or instant. This replaces a `TransitionError` an operator could
    // reach by doing nothing wrong. Same shape as `voidLoad`.
    findUnique.mockResolvedValue(loadRow({ status: 'rejected' }));
    await expect(reject({ category: 'damaged' })).resolves.toBeUndefined();
    expect(updateMany).not.toHaveBeenCalled();
    expect(stackUpdateMany).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

describe('a rejected load feeds NOTHING', () => {
  // ADR-0113 §4. `rejected` is excluded from every money and inventory
  // allow-list by construction today, which is exactly why it needs pinning: the
  // exclusion is invisible, so a future edit to one of these lists — adding
  // `rejected` "so the reconciliation can see it" — would quietly bill a load
  // the floor refused, with no error anywhere.
  //
  // These are the four lists ADR-0090 D2 enumerated as the reason a new terminal
  // status is safe by default. They are only safe while they stay this way.

  it('is not billable — absent from INVOICE_STATUSES', () => {
    expect([...INVOICE_STATUSES]).not.toContain('rejected');
  });

  it('does not move inventory — absent from VERIFIED_INBOUND_STATUSES', () => {
    expect([...VERIFIED_INBOUND_STATUSES]).not.toContain('rejected');
  });

  it("is not the floor's work — absent from OPEN_DOCK_STATUSES", () => {
    // Which is also what makes `toConsumedLoad` report `open: false` and the
    // check-in card read "Rejected at the dock" rather than offering a route
    // back into a load nobody can work.
    expect([...OPEN_DOCK_STATUSES]).not.toContain('rejected');
  });

  it('every status in the money lists is a real enum member', () => {
    // A typo in one of these arrays silently excludes NOTHING, because a status
    // that matches no row filters nothing out. Cheap to check, and the check
    // is the only thing that would notice.
    const enumValues = new Set<string>(Object.values(LoadStatus));
    for (const s of [...INVOICE_STATUSES, ...VERIFIED_INBOUND_STATUSES, ...OPEN_DOCK_STATUSES]) {
      expect(enumValues, s).toContain(s);
    }
  });
});

describe('the category list the floor sees', () => {
  it('offers every RejectionCategory the schema defines', async () => {
    // `reject-fields.tsx` hand-writes this mirror, because the runtime enum
    // object from `@prisma/client` must not enter the browser bundle. A member
    // added to the schema and not added there simply never renders — silently,
    // and only on the floor. This test reads the runtime enum from the server
    // side, where it IS readable, and is the only thing that would notice.
    const { REJECTION_CATEGORIES } = await import('@/app/operator/[site]/load/[id]/reject-fields');
    expect([...REJECTION_CATEGORIES].sort()).toEqual([...Object.values(RejectionCategory)].sort());
  });

  it('leads with `bedbugs` and ends with `other`', async () => {
    // Order is a decision, not enum order. `bedbugs` is why this path exists, it
    // carries the largest consequence — an infested load contaminates the
    // building, not just the invoice — and it is what the operator is reaching
    // for while holding a mattress they want to put down. A catch-all belongs
    // last.
    const { REJECTION_CATEGORIES } = await import('@/app/operator/[site]/load/[id]/reject-fields');
    expect(REJECTION_CATEGORIES[0]).toBe('bedbugs');
    expect(REJECTION_CATEGORIES[REJECTION_CATEGORIES.length - 1]).toBe('other');
  });
});
