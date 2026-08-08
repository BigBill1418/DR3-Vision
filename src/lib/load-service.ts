import {
  Prisma,
  type CountMode,
  type ConcernCategory,
  type LoadStatus,
  type PhotoKind,
  type RejectionCategory,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';
import { withIdempotency } from '@/lib/idempotency';

// State-machine moves for the inbound-load workflow per
// SPRINT-1-PLAN T-006 + ADR-0012 §1 (timer starts on door-open). All
// transitions are guarded server-side: the UI enforces order, but a
// hand-crafted POST cannot skip ahead. Forced-photo gates land in the
// stage transitions that require a `LoadPhoto` row.
//
// Photo storage_key is intentionally a placeholder for T-006
// ("pending-r2-…"). T-007 retrofits the real R2 upload + replaces
// these keys; the audit + UI surfaces remain unchanged.

const ALLOWED_PRIOR: Record<LoadStatus, LoadStatus[]> = {
  expected: [],
  arrived: ['expected'],
  weight_captured: ['arrived'],
  unload_started: ['arrived', 'weight_captured'],
  in_progress: ['unload_started'],
  finished: ['in_progress'],
  submitted: ['finished'],
  verified: ['submitted'],
  rejected: ['arrived', 'weight_captured', 'unload_started'],
  submitted_to_mymrc: ['verified'],
  processed: ['submitted_to_mymrc'],
};

class TransitionError extends Error {
  // ADR-0078 D11 — typed. `loadsErrorResponse` maps anything carrying a numeric
  // `status`; a bare Error fell through to the 500 branch and was re-thrown to
  // the framework, so an ordinary "you already did this" surfaced to the
  // operator as a server crash.
  readonly status = 409;
  readonly reason = 'illegal_transition';
  constructor(
    public from: LoadStatus,
    public to: LoadStatus,
  ) {
    super(`illegal transition ${from} → ${to}`);
  }
}

/**
 * ADR-0078 D11 — ownership / existence failures, typed so they map to their real
 * HTTP status instead of a 500.
 *
 * These were `throw new Error('load not found')` and friends. Every one of them
 * is a 404 or a 403 that an operator can act on ("this load isn't yours"), and
 * every one of them was being reported as an internal server error — which
 * tells the operator nothing, gives the log the wrong severity, and buries a
 * routine outcome in the 500 rate.
 */
export class LoadAccessError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'LoadAccessError';
  }
}

async function assertOwn(args: { loadId: string; operatorUserId: string; siteId: string }) {
  const load = await prisma.inboundLoad.findUnique({
    where: { id: args.loadId },
    select: {
      id: true,
      site_id: true,
      assigned_operator_id: true,
      status: true,
      arrived_at: true,
      unload_started_at: true,
    },
  });
  if (!load) throw new LoadAccessError(404, 'load_not_found');
  if (load.site_id !== args.siteId) throw new LoadAccessError(403, 'load_not_at_this_site');
  if (load.assigned_operator_id !== args.operatorUserId) {
    throw new LoadAccessError(403, 'load_not_assigned_to_operator');
  }
  return load;
}

function placeholderStorageKey(kind: PhotoKind): string {
  // T-007 swaps this for the real R2 object key. Until then we emit
  // a deterministic-looking key that's obvious to any reader as
  // "the upload didn't happen yet."
  return `pending-r2-${kind}-${crypto.randomUUID()}`;
}

/**
 * Prisma's `P2002` raised by the UNIQUE index on `inbound_loads.expected_load_id`,
 * and only that.
 *
 * Deliberately narrower than `code === 'P2002'`: a bare code check would also
 * absorb a future unique constraint elsewhere on this table and report an
 * unrelated collision as "someone else claimed it" — a wrong answer wearing a
 * right one's clothes.
 */
function isExpectedLoadClaimCollision(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
  const target = e.meta?.['target'];
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return fields.some((f) => f.includes('expected_load_id'));
}

/**
 * Claim an expected haul by starting its dock load.
 *
 * ADR-0082 — this is where the CLAIM is made, and until now it was made
 * non-atomically: a `findUnique` on the parent, then a `create`, with no
 * transaction between them. Two operators tapping the same queue row within the
 * same second both saw `inbound_load: null` and both inserted.
 *
 * That was not a theoretical race. Loads arrive on a shared floor iPad and a
 * second device; "two people tapped the same truck" is a Tuesday. The unique
 * index on `expected_load_id` did stop the duplicate row — by raising a raw
 * `P2002` out of the server action, which reached the operator as the opaque
 * digest ADR-0078 D11 spent a whole section removing everywhere else.
 *
 * Two windows, two mechanisms, both needed:
 *
 *   - SEQUENTIAL (the common one): A committed a moment ago and B's queue page
 *     has not re-rendered. Closed by re-reading the parent INSIDE the
 *     transaction — B sees A's committed child and returns it.
 *   - CONCURRENT (the narrow one): both transactions are open at once, so under
 *     READ COMMITTED neither re-read can see the other's uncommitted insert. The
 *     unique index blocks the loser and then refuses it; the `P2002` branch
 *     turns that refusal into the same graceful outcome as the sequential path.
 *
 * A transaction ALONE would fix neither — that is why the re-read and the catch
 * are both here and neither is redundant.
 *
 * @returns the load id, plus whether THIS call created it. `claimed: false` means
 *          the load already existed and belongs to whoever started it; the page
 *          the caller redirects to renders the held-by state (ADR-0082), which is
 *          why this is a return value rather than a throw.
 */
export async function startInboundLoad(args: {
  expectedLoadId: string;
  siteId: string;
  operatorUserId: string;
}): Promise<{ id: string; claimed: boolean }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const expected = await tx.expectedLoad.findUnique({
        where: { id: args.expectedLoadId },
        select: {
          id: true,
          site_id: true,
          cancelled_at: true,
          source_id: true,
          transporter_id: true,
          bol_number: true,
          inbound_load: { select: { id: true } },
        },
      });
      if (!expected) throw new LoadAccessError(404, 'expected_load_not_found');
      if (expected.site_id !== args.siteId) {
        throw new LoadAccessError(403, 'expected_load_not_at_this_site');
      }
      if (expected.cancelled_at) throw new LoadAccessError(409, 'expected_load_cancelled');
      if (expected.inbound_load) {
        // Already claimed — by this operator on a double-tap, or by another one.
        // Either way the load exists and minting a second is the one thing that
        // must not happen.
        return { id: expected.inbound_load.id, claimed: false };
      }

      const now = new Date();
      const created = await tx.inboundLoad.create({
        data: {
          site_id: args.siteId,
          expected_load_id: expected.id,
          status: 'arrived',
          arrived_at: now,
          assigned_operator_id: args.operatorUserId,
          assigned_at: now,
          source_id: expected.source_id,
          transporter_id: expected.transporter_id,
          bol_number: expected.bol_number,
        },
        select: { id: true },
      });
      // In-transaction (ADR-0082): the row and the record of who claimed it
      // commit or roll back together. The previous call wrote this audit row on
      // the global client AFTER the create, so a failure in between left a
      // claimed load with nothing saying who claimed it.
      await writeAudit(
        {
          actor_user_id: args.operatorUserId,
          action: 'insert',
          table_name: 'inbound_loads',
          row_id: created.id,
          after: {
            status: 'arrived',
            expected_load_id: expected.id,
            assigned_operator_id: args.operatorUserId,
            assigned_at: now,
          },
        },
        { tx },
      );
      return { id: created.id, claimed: true };
    });
  } catch (e) {
    if (!isExpectedLoadClaimCollision(e)) throw e;
    // The concurrent window. The other transaction won the unique index; its
    // load is now committed, so read it and hand back the same answer the
    // sequential path gives. Re-raising P2002 here is what used to surface as a
    // 500 to an operator whose only mistake was tapping at the same time as a
    // colleague.
    const existing = await prisma.inboundLoad.findUnique({
      where: { expected_load_id: args.expectedLoadId },
      select: { id: true },
    });
    if (!existing) throw e; // Not the collision we thought — do not invent an id.
    return { id: existing.id, claimed: false };
  }
}

async function transition(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
  to: LoadStatus;
  data?: Prisma.InboundLoadUpdateInput;
}): Promise<void> {
  const current = await assertOwn({
    loadId: args.loadId,
    operatorUserId: args.operatorUserId,
    siteId: args.siteId,
  });
  const allowed = ALLOWED_PRIOR[args.to];
  if (!allowed.includes(current.status)) throw new TransitionError(current.status, args.to);
  await prisma.inboundLoad.update({
    where: { id: args.loadId },
    data: { ...args.data, status: args.to },
  });
  await writeAudit({
    actor_user_id: args.operatorUserId,
    action: 'update',
    table_name: 'inbound_loads',
    row_id: args.loadId,
    before: { status: current.status },
    after: { status: args.to },
  });
}

// Per T-007 the client uploads the photo to R2 (or hits the
// placeholder fallback) and writes the `LoadPhoto` row via
// `/api/photos/confirm` BEFORE invoking the stage server action.
// `attachPhoto` is exported so any future non-photo-input caller
// (e.g. server-side imports, batch backfill scripts) can still record
// a placeholder row, but the operator-workflow stage actions no
// longer call it — that would double-insert.
export async function attachPhoto(loadId: string, kind: PhotoKind): Promise<void> {
  await prisma.loadPhoto.create({
    data: {
      load_id: loadId,
      kind,
      storage_key: placeholderStorageKey(kind),
      captured_at: new Date(),
    },
  });
}

export async function recordBolCapture(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
}): Promise<void> {
  // The BOL photo row was written by the client via /api/photos/confirm
  // before this action fired. No server-side photo write here.
  await assertOwn(args);
}

export async function recordWeightSkip(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
}): Promise<void> {
  // Operator chose "no weight ticket" — no DB change needed; the
  // weight stage gates only on the user's choice, not on a status
  // transition. The next door-open transition jumps straight from
  // `arrived` → `unload_started`.
  await assertOwn(args);
}

export async function recordWeightCapture(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
  weightLbs: number;
}): Promise<void> {
  if (!Number.isInteger(args.weightLbs) || args.weightLbs < 1 || args.weightLbs > 100_000) {
    throw new Error('weight out of range (1 .. 100,000 lbs)');
  }
  await transition({
    ...args,
    to: 'weight_captured',
    data: { weight_lbs: args.weightLbs, weight_captured_at: new Date() },
  });
  // weight_ticket photo row already written by the client.
}

export async function recordDoorOpenCapture(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
}): Promise<void> {
  const current = await assertOwn(args);
  const now = new Date();
  const arrivedAt = current.arrived_at ?? now;
  const timeToUnloadStart = Math.max(0, Math.round((now.getTime() - arrivedAt.getTime()) / 1000));
  await transition({
    ...args,
    to: 'unload_started',
    data: {
      unload_started_at: now,
      time_to_unload_start_seconds: timeToUnloadStart,
    },
  });
  // door_open photo row already written by the client.
}

export async function beginUnload(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
}): Promise<void> {
  await transition({ ...args, to: 'in_progress' });
}

export async function addStack(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
  stackIndex: number;
  unitCount: number;
  countMode: CountMode;
  /** ADR-0078 — client-minted key; makes a re-tap of the same stack a no-op. */
  idempotencyKey?: string | null;
}): Promise<void> {
  if (!Number.isInteger(args.unitCount) || args.unitCount < 1) {
    throw new LoadAccessError(422, 'stack_unit_count_must_be_at_least_1');
  }
  const current = await assertOwn(args);

  // A stack may only be added while the load is UNLOADING.
  //
  // `addStack` had no status guard, which was unreachable before ADR-0078
  // because stacks had no queue — D2 creates exactly that path. A stack
  // replayed after `finishUnload` inserts a row that `total_units` has already
  // been computed without, so the load is under-billed by that stack and the
  // `load_stacks` rows silently contradict the total they are supposed to feed.
  // Refusing parks the entry as a conflict instead, where a person can see it.
  if (current.status !== 'in_progress') {
    throw new LoadAccessError(409, 'load_not_unloading');
  }

  // ADR-0078 D2/D6. Two defects meet in this one call.
  //
  // D2: a lost stack silently UNDERCOUNTS the load — `finishUnload` sums
  // `load_stacks` into `total_units`, which is billed. The write is now
  // idempotency-keyed, so a retry after a dropped response cannot add a second
  // stack, and the client queues it rather than discarding it.
  //
  // D6: the double-tap was reported as a failure that had actually SUCCEEDED.
  // `@@unique(load_id, stack_index)` correctly refuses the second insert with
  // P2002 — and the UI rendered that as "couldn't save", so the operator taps
  // again, or worse, re-enters a count that is already recorded. When the caller
  // carries an idempotency key the row already at this index IS this write, so
  // P2002 is the desired end state and is reported as success. Without a key we
  // keep the old strict behaviour: there is then no evidence the two taps are
  // the same tap.
  try {
    await prisma.$transaction((tx) =>
      withIdempotency(
        {
          key: args.idempotencyKey ?? null,
          scope: 'operator.load.add_stack',
          actorUserId: args.operatorUserId,
          siteId: args.siteId,
          payload: {
            loadId: args.loadId,
            stackIndex: args.stackIndex,
            unitCount: args.unitCount,
            countMode: args.countMode,
          },
          tx,
          statusCode: 201,
        },
        async () => {
          const created = await tx.loadStack.create({
            data: {
              load_id: args.loadId,
              stack_index: args.stackIndex,
              unit_count: args.unitCount,
              count_mode: args.countMode,
            },
            select: { id: true },
          });
          return { id: created.id };
        },
      ),
    );
  } catch (e) {
    const duplicate = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
    if (!duplicate || !args.idempotencyKey) throw e;

    // The row at this index EXISTS. Whether that is this write or a different
    // one is a question, not an assumption — and answering it by assumption
    // loses mattresses.
    //
    // A real double-tap mints two DIFFERENT keys (one per tap), so the
    // idempotency layer cannot short-circuit and both taps reach this insert.
    // That is the case we want to absorb. But `nextIndex` is derived from
    // rendered state, so after a reload — or on a second tab, which `assertOwn`
    // permits because it checks the operator and not the session — two
    // GENUINELY DIFFERENT stacks can be computed at the same index. Absorbing
    // that reports 201 to the replay loop, which then deletes the queued entry,
    // and a stack of mattresses is gone from a billed total with no record
    // anywhere that it ever existed.
    //
    // So: converged only if the existing row is byte-for-byte this write.
    // Anything else is a 409, which `classify()` treats as a hard 4xx, so the
    // entry PARKS as a conflict with its payload intact and a person decides.
    const existing = await prisma.loadStack.findUnique({
      where: {
        load_id_stack_index: { load_id: args.loadId, stack_index: args.stackIndex },
      },
      select: { unit_count: true, count_mode: true },
    });
    if (existing?.unit_count === args.unitCount && existing.count_mode === args.countMode) return;
    throw new LoadAccessError(409, 'stack_index_conflict');
  }
}

export async function finishUnload(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
  countMode: CountMode;
  /** ADR-0078 — present ⇒ an already-finished load is a replay, not an error. */
  idempotencyKey?: string | null;
}): Promise<void> {
  const current = await assertOwn(args);

  // ADR-0078 D7 — the retry-after-commit false failure.
  //
  // The operator taps Finish, the write COMMITS, the response is lost to a
  // dropping connection, and the retry finds the load already `finished`. The
  // state machine then refuses `finished → finished` and the operator is told
  // their work failed, when it is the one thing that definitely succeeded. With
  // an idempotency key in hand — evidence that this is the same action, not a
  // second one — the target status already being the current status is exactly
  // what success looks like. Returning here is not skipping the transition; the
  // transition already happened.
  //
  // Deliberately narrow: only when the load is ALREADY in the state we were
  // asked to move it to, and only when a key says this is a replay. Every other
  // illegal transition still raises.
  //
  // It RECOMPUTES rather than simply returning. A bare early return assumed the
  // stored `total_units` was still correct, and a queued stack replayed after
  // the finish had landed would make that false — the row would exist, the
  // total would not include it, and the load would be under-billed with no
  // error anywhere. Recomputing makes the replay both idempotent and correct,
  // and is a no-op in the ordinary case where nothing arrived late.
  if (args.idempotencyKey && current.status === 'finished') {
    const late = await prisma.loadStack.findMany({
      where: { load_id: args.loadId },
      select: { unit_count: true },
    });
    const total = late.reduce((acc, s) => acc + s.unit_count, 0);
    const row = await prisma.inboundLoad.findUnique({
      where: { id: args.loadId },
      select: { total_units: true },
    });
    if (row && row.total_units !== total) {
      await prisma.inboundLoad.update({
        where: { id: args.loadId },
        data: { total_units: total },
      });
      await writeAudit({
        actor_user_id: args.operatorUserId,
        action: 'update',
        table_name: 'inbound_loads',
        row_id: args.loadId,
        before: { total_units: row.total_units },
        after: { total_units: total, reason: 'stack replayed after finish (ADR-0078)' },
      });
    }
    return;
  }

  const now = new Date();
  const startedAt = current.unload_started_at ?? now;
  const duration = Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000));
  const stacks = await prisma.loadStack.findMany({
    where: { load_id: args.loadId },
    select: { unit_count: true },
  });
  const totalUnits = stacks.reduce((acc, s) => acc + s.unit_count, 0);
  await transition({
    ...args,
    to: 'finished',
    data: {
      unload_finished_at: now,
      unload_duration_seconds: duration,
      total_units: totalUnits,
      count_mode: args.countMode,
    },
  });
}

export async function addConcern(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
  category: ConcernCategory;
  note: string | null;
  /** ADR-0078 — a concern has no natural key, so a retry would duplicate it. */
  idempotencyKey?: string | null;
}): Promise<void> {
  await assertOwn(args);
  await prisma.$transaction((tx) =>
    withIdempotency(
      {
        key: args.idempotencyKey ?? null,
        scope: 'operator.load.add_concern',
        actorUserId: args.operatorUserId,
        siteId: args.siteId,
        payload: { loadId: args.loadId, category: args.category, note: args.note },
        tx,
        statusCode: 201,
      },
      async () => {
        const created = await tx.loadConcern.create({
          data: {
            load_id: args.loadId,
            category: args.category,
            note: args.note,
            raised_by_user_id: args.operatorUserId,
          },
          select: { id: true },
        });
        return { id: created.id };
      },
    ),
  );
}

export async function submitLoad(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
}): Promise<void> {
  await transition({
    ...args,
    to: 'submitted',
    data: {
      submitted_at: new Date(),
      submitted_by: { connect: { id: args.operatorUserId } },
    },
  });
}

export async function rejectLoad(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
  category: RejectionCategory;
  note: string | null;
}): Promise<void> {
  await transition({
    ...args,
    to: 'rejected',
    data: {
      rejection_category: args.category,
      rejection_note: args.note,
      submitted_at: new Date(),
      submitted_by: { connect: { id: args.operatorUserId } },
    },
  });
  // rejection photo row already written by the client.
}
