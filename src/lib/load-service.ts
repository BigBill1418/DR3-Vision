import {
  Prisma,
  type CountMode,
  type ConcernCategory,
  type LoadStatus,
  type LoadVoidReason,
  type PhotoKind,
  type RejectionCategory,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { lockSiteAgainstPromotion } from '@/lib/audit/promotion-lock';
import { writeAudit, writeAuditMany } from '@/lib/audit';
import { pacificDayISO } from '@/lib/time';
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
  // ADR-0090 Am.1 B — `finished` is the REOPEN edge, and it is the only back-edge
  // in this machine. It is declared here rather than bypassing `ALLOWED_PRIOR`
  // because this table is the single statement of which edges exist; a
  // transition that guarded itself elsewhere would make the table a partial
  // truth, and the table's completeness is what makes it a compile-time
  // tripwire (ADR-0090 D2).
  //
  // Declaring the edge here does NOT hand it to every caller: `beginUnload`
  // passes `allowedFrom: ['unload_started']` and `reopenLoad` passes
  // `allowedFrom: ['finished']`, so each write can still only make the move it
  // is named for. Without that narrowing, a hand-crafted `beginUnloadAction`
  // POST would silently reopen a finished load with no reopen audit reason.
  in_progress: ['unload_started', 'finished'],
  finished: ['in_progress'],
  submitted: ['finished'],
  verified: ['submitted'],
  // ADR-0113 — `in_progress` and `finished` added 2026-08-19.
  //
  // This list used to stop at `unload_started`, which put the whole of the
  // refusal decision inside the ONE stage between opening the door and the first
  // stack landing. On 2026-08-19 H-137759 (Ron Lawrence & Son) was accepted, the
  // unload started, and the floor then found massive bed bugs — past the only
  // door out. The load was closed by audited manual DB rectification, which is
  // exactly the DBA-shaped remedy ADR-0090 was written to retire.
  //
  // The bugs are not in the trailer doorway; they are in the mattresses, and you
  // find them by handling the mattresses. Making the refusal legal only BEFORE
  // anyone has touched the load asks the floor to decide with the evidence still
  // in the truck.
  //
  // This set is now IDENTICAL to `voided`'s, and to `OPEN_DOCK_STATUSES`: the
  // floor may take either exit from exactly the states where the load is still
  // the floor's work, and no further. Past `submitted` the load may already sit
  // on an MRC invoice — ADR-0073's territory for both exits, unchanged. The
  // three-way equality is pinned in `load-service.reject.test.ts` rather than
  // expressed by sharing one constant, so a future deliberate divergence has to
  // edit the pin and say why, and cannot arrive as a silent widening from an
  // edit to a list two modules away.
  rejected: ['arrived', 'weight_captured', 'unload_started', 'in_progress', 'finished'],
  submitted_to_mymrc: ['verified'],
  processed: ['submitted_to_mymrc'],
  // ADR-0090 C — voidable from every state the FLOOR can be stuck in, and no
  // further. `finished` is included deliberately: H-135311 sat counted-but-
  // unsubmitted for thirteen days, and refusing the void there would leave the
  // single most-stranded shape without a remedy.
  //
  // Past `submitted` the load has left the floor's hands and may already sit on
  // an MRC invoice; correcting THAT is ADR-0073's manager territory, and a
  // floor-side void would silently restate a filed number.
  //
  // Nothing lists `voided` as a legal PRIOR: the state is terminal, and a load
  // that could be un-voided would let a mis-tap re-enter billing by a second
  // mis-tap.
  voided: ['arrived', 'weight_captured', 'unload_started', 'in_progress', 'finished'],
};

/**
 * ADR-0090 Amendment 1 (B) — "this stack was taken back", said ONCE.
 *
 * `total_units` is billed, and it is computed from `load_stacks` at TWO places
 * in `finishUnload`: the primary sum, and the ADR-0078 D7 late-stack recompute
 * that runs on an already-`finished` load. Filtering one and not the other makes
 * the replay path silently RESTORE voided units into a billed total — a
 * money error with no error message anywhere.
 *
 * One exported constant so the two filters cannot drift, and so a third sum site
 * added later has an obvious thing to reach for. Mirrors `NOT_VOIDED_LOAD` in
 * `src/lib/loads/not-voided.ts`, which does the same job for the load itself.
 */
export const NOT_VOIDED_STACK = {
  voided_at: null,
} as const satisfies Prisma.LoadStackWhereInput;

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
      // ADR-0090 Am.1 — the `before` value for an audited weight correction.
      weight_lbs: true,
      // ADR-0090 C — the slot the void severs.
      expected_load_id: true,
      // ADR-0128 — the haul number the void severs alongside it (UNIQUE column).
      external_mymrc_haul_id: true,
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
 * The two UNIQUE indexes that both encode "this slot has already been claimed",
 * and only those.
 *
 * Deliberately narrower than `code === 'P2002'`: a bare code check would also
 * absorb a future unique constraint elsewhere on this table and report an
 * unrelated collision as "someone else claimed it" — a wrong answer wearing a
 * right one's clothes.
 *
 * ── ADR-0128 — why `external_mymrc_haul_id` is now in this list ─────────────
 *
 * A dock capture carries its slot's haul number, and that column is UNIQUE too.
 * So the concurrent double-tap this catch exists for can now lose on EITHER
 * index — which of the two Postgres reports is an implementation detail of index
 * ordering, not a fact about what happened. Recognising only `expected_load_id`
 * meant the loser sometimes got a raw `P2002` out of the server action: exactly
 * the opaque digest ADR-0082 spent a whole section removing, re-armed by adding
 * a column.
 *
 * This was NOT hypothetical and was NOT caught by the mocked suites. It was
 * caught by `load-claim.db.test.ts` against a real Postgres, in the
 * `holdRowLock` race — which is what that file is for.
 *
 * Widening this is safe because the recovery is already conditional: the caller
 * re-reads by `expected_load_id` and RE-THROWS when nothing is there. A haul-id
 * collision that is genuinely something else — a bridge-created load already
 * holding that number — therefore still surfaces as itself rather than being
 * swallowed as a claim.
 */
const CLAIM_UNIQUE_COLUMNS = ['expected_load_id', 'external_mymrc_haul_id'] as const;

function isExpectedLoadClaimCollision(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
  const target = e.meta?.['target'];
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return fields.some((f) => CLAIM_UNIQUE_COLUMNS.some((col) => f.includes(col)));
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
/**
 * ADR-0096 — the caller's statement of WHICH day it believes this slot is
 * scheduled for, and the only way to start a load against a slot that is not
 * today's.
 *
 * Deliberately NOT a boolean. `allowAnyDay: true` would close nothing — a stale
 * client would pass it exactly as happily as a correct one. Naming the day means
 * a caller that has not actually READ this slot cannot produce the value, so the
 * server's comparison is evidence that the operator was looking at the truck
 * they are reconciling rather than a permission the UI granted itself.
 */
export interface SlotReconciliation {
  /** The slot's own Pacific day, `YYYY-MM-DD`, as the caller rendered it. */
  acknowledgedSlotDayISO: string;
}

export async function startInboundLoad(args: {
  expectedLoadId: string;
  siteId: string;
  operatorUserId: string;
  /**
   * ADR-0127 — the haul number the operator READ BACK before confirming, exactly
   * as the card rendered it. REQUIRED, and compared against the slot's own
   * `external_mymrc_haul_id` inside the transaction.
   *
   * Deliberately not optional. An optional acknowledgement is one a stale tab, a
   * replayed POST or a forgetful future caller skips silently, which is the
   * `allowAnyDay: true` critique ADR-0096 made of its own guard — the value has
   * to be one a caller who never read this slot cannot produce. It is also NOT
   * the expected-load id restated: the id is what the operator TAPPED, and the
   * haul number is what they were shown; the whole point is that the two are
   * checked against each other.
   */
  acknowledgedHaulId: string;
  /**
   * ADR-0096 — present ONLY on the explicit "this truck arrived on a different
   * day" path. Absent means the ordinary path, which now requires the slot to be
   * due today.
   */
  reconcile?: SlotReconciliation | undefined;
  /** Injectable clock; the day comparison is Pacific, never UTC. */
  now?: Date | undefined;
}): Promise<{ id: string; claimed: boolean }> {
  try {
    return await prisma.$transaction(async (tx) => {
      // ADR-0120 — serialise against workbook promotion at this site.
      await lockSiteAgainstPromotion(tx, args.siteId);
      const expected = await tx.expectedLoad.findUnique({
        where: { id: args.expectedLoadId },
        select: {
          id: true,
          site_id: true,
          cancelled_at: true,
          // ADR-0096 — the day guard's input. Selected here rather than read
          // outside the transaction: a guard that reads outside the transaction
          // it is guarding is a race with better manners (`idempotency.ts`).
          expected_arrival_at: true,
          source_id: true,
          transporter_id: true,
          bol_number: true,
          // ADR-0127 — the acknowledgement's comparand. ADR-0128 — and the value
          // the child load now carries, so a dock capture is reconcilable.
          external_mymrc_haul_id: true,
          inbound_load: { select: { id: true } },
        },
      });
      if (!expected) throw new LoadAccessError(404, 'expected_load_not_found');
      if (expected.site_id !== args.siteId) {
        throw new LoadAccessError(403, 'expected_load_not_at_this_site');
      }
      if (expected.cancelled_at) throw new LoadAccessError(409, 'expected_load_cancelled');

      // ── ADR-0127 — THE CARD THE OPERATOR CONFIRMED IS THE CARD THAT OPENS ──
      //
      // Checked BEFORE the idempotent already-claimed return, deliberately. A
      // mismatch means the page the operator read no longer describes this slot,
      // and handing back somebody else's load in that state would answer a
      // question they did not ask. The claim branch below is for a double-tap on
      // a card that IS this slot.
      //
      // Trimmed on both sides but compared exactly otherwise: haul numbers are
      // machine-issued (`H-138155`) and a case-insensitive or fuzzy compare
      // would be a guess dressed as a check.
      if (args.acknowledgedHaulId.trim() !== expected.external_mymrc_haul_id.trim()) {
        throw new LoadAccessError(409, 'haul_number_mismatch');
      }

      if (expected.inbound_load) {
        // Already claimed — by this operator on a double-tap, or by another one.
        // Either way the load exists and minting a second is the one thing that
        // must not happen.
        return { id: expected.inbound_load.id, claimed: false };
      }

      // ── ADR-0096 — THE DAY GUARD, server-side at last ────────────────────
      //
      // ADR-0074 D5 bounds check-in to the current Pacific day, and until now
      // that bound lived ENTIRELY in the two read layers (`portal-hauls.ts` and
      // the queue page's `where`). ADR-0074 Am.1 recorded the server-side gap as
      // an open decision; ADR-0094 re-confirmed it was still open. A bookmarked
      // page, a replayed POST or a hand-written call could mint a child onto any
      // slot at the site, of any age — the 159-unit mis-booking the bound exists
      // to prevent, reachable by going around the UI that enforced it.
      //
      // PACIFIC, never UTC. After 5 PM PDT the UTC day has already rolled, so a
      // UTC comparison would refuse today's own slots for the last seven hours of
      // every Pacific day — the entire evening shift, including the 5:25 PM PT
      // moment this ADR was written in.
      const now = args.now ?? new Date();
      const slotDayISO = expected.expected_arrival_at
        ? pacificDayISO(expected.expected_arrival_at)
        : null;
      const todayISO = pacificDayISO(now);

      if (args.reconcile) {
        // An undated slot has no day to agree with, so agreement cannot be
        // demonstrated and the exception cannot be granted.
        if (slotDayISO === null) throw new LoadAccessError(409, 'expected_load_undated');
        if (args.reconcile.acknowledgedSlotDayISO !== slotDayISO) {
          throw new LoadAccessError(409, 'slot_day_mismatch');
        }
      } else if (slotDayISO !== todayISO) {
        // Includes the undated case: a NULL day cannot be PROVEN to be today, so
        // it falls on the refusing side (the same direction `portal-hauls.ts`
        // chose for the read layer).
        throw new LoadAccessError(409, 'expected_load_not_due_today');
      }

      const reconciled = slotDayISO !== null && slotDayISO !== todayISO;

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
          // ── ADR-0128 — the dock load carries its haul number ────────────────
          //
          // This column was NULL on all 774 production loads (measured
          // 2026-08-25), because only the MyMRC bridge and the EOD add-line ever
          // wrote it and neither touches a dock capture. The monthly
          // reconciliation upload matches DR3 loads to MyMRC haul rows ON THIS
          // COLUMN (`reconciliation.ts` `categorizeRows`), so every truck the
          // floor has ever counted was unreconcilable — it fell out as
          // `missing_in_dr3` against a load sitting right there in the table.
          //
          // The value is COPIED, not referenced, and that is the point: it is the
          // haul this load was booked against at the moment it was worked. A void
          // later severs `expected_load_id` (ADR-0090 C) and would otherwise take
          // the answer with it.
          external_mymrc_haul_id: expected.external_mymrc_haul_id,
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
            // ADR-0096 — a load minted against another day's slot must be
            // answerable later without re-deriving it from two timestamps.
            // Absent entirely on an ordinary same-day start, so the presence of
            // the key IS the signal.
            ...(reconciled ? { reconciled_from_day: slotDayISO, reconciled_on_day: todayISO } : {}),
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
  /**
   * ADR-0118 — `InboundLoadUncheckedUpdateInput`, NOT `InboundLoadUpdateInput`.
   * The write below is a guarded `updateMany`, and `updateMany` accepts SCALAR
   * fields only: a nested relation write (`submitted_by: { connect: … }`) is
   * rejected by Prisma at ARGUMENT VALIDATION, before the query is sent — the
   * ADR-0115 failure mode, which aborts the enclosing transaction and refuses
   * the transition at runtime with nothing having gone wrong in the data.
   *
   * The `Unchecked` variant is exactly the scalar-only surface, so `tsc` now
   * refuses a `connect` here instead of letting it reach production. The two
   * call sites that used one (`submitLoad`, `rejectLoad`) set
   * `submitted_by_id` directly; it is the same column.
   */
  data?: Prisma.InboundLoadUncheckedUpdateInput;
  /**
   * ADR-0090 Am.1 — narrow this particular write to a SUBSET of the edges
   * `ALLOWED_PRIOR[to]` declares.
   *
   * Two writes now arrive at `in_progress` from different priors and mean
   * different things: `beginUnload` (from `unload_started`) starts the count,
   * `reopenLoad` (from `finished`) goes back to correct it. `ALLOWED_PRIOR` is
   * the union — it has to be, or it stops being a complete statement of the
   * machine — so the narrowing lives at the call site. The intersection is taken
   * rather than the override trusted: a caller can only ever restrict, never
   * widen past the table.
   */
  allowedFrom?: readonly LoadStatus[];
  /** Recorded on the audit row's `after`, so two edges to one status are legible. */
  reason?: string;
}): Promise<void> {
  const current = await assertOwn({
    loadId: args.loadId,
    operatorUserId: args.operatorUserId,
    siteId: args.siteId,
  });
  const declared = ALLOWED_PRIOR[args.to];
  const allowed = args.allowedFrom
    ? declared.filter((s) => args.allowedFrom!.includes(s))
    : declared;
  if (!allowed.includes(current.status)) throw new TransitionError(current.status, args.to);

  // ── ADR-0118 — the transition is guarded, and its audit row rides with it ───
  //
  // `assertOwn` read the status above, on the shared client; the write was an
  // unguarded `update({ where: { id } })`, which succeeds whatever the row's
  // status is by the time it runs. `load-claim.ts:372-376` names this exact
  // defect in a comment. The floor makes it ordinary rather than exotic: one
  // load is reachable from the shared kiosk, the operator's own iPad and the
  // offline-queue replay endpoint, so two requests routinely pass the same
  // check and both write — the state machine's table is consulted and then not
  // enforced.
  //
  // The `updateMany` restates the status the transition was authorised FROM,
  // and `count === 0` raises the same `TransitionError` the pre-check raises,
  // so every route that already translates it keeps working. The in-file model
  // is `finishUnload`'s duration freeze (~line 905), which has used this shape
  // since ADR-0090 Am.1.
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.inboundLoad.updateMany({
      where: { id: args.loadId, status: current.status },
      data: { ...args.data, status: args.to },
    });
    if (count === 0) {
      const now = await tx.inboundLoad.findUniqueOrThrow({
        where: { id: args.loadId },
        select: { status: true },
      });
      throw new TransitionError(now.status, args.to);
    }
    // Hard rule #6 — same transaction as the state change it describes.
    await writeAudit(
      {
        actor_user_id: args.operatorUserId,
        action: 'update',
        table_name: 'inbound_loads',
        row_id: args.loadId,
        before: { status: current.status },
        after: { status: args.to, ...(args.reason ? { reason: args.reason } : {}) },
      },
      { tx },
    );
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
  // ADR-0124 — this function's entire body used to be `await assertOwn(args)`,
  // under the comment "no DB change needed; the weight stage gates only on the
  // user's choice, not on a status transition."
  //
  // The user's choice lived in a `useState` in one browser tab. It died on every
  // reload and every takeover, and the next operator was asked about the same
  // truck again. It is the `bolDone` defect with a softer landing — "None" is
  // always live, so nobody was trapped — but a step whose completion is recorded
  // only on the device that completed it is exactly the class ADR-0121 is about.
  //
  // NOT a status transition: "there is no weight ticket" and "the weight was
  // captured" are different claims, and `weight_captured` with a NULL
  // `weight_lbs` would assert the second while meaning the first. A dedicated
  // nullable instant says what happened.
  //
  // IDEMPOTENT on the stamp. A second "None" tap — the shape a takeover or a
  // double-tap produces — must not move the recorded instant, because that
  // instant is the operator's decision and re-stamping it would attribute an
  // earlier operator's call to a later one. `updateMany` with the NULL condition
  // ON the statement rather than a read-then-write (ADR-0118 D1), so two taps
  // racing cannot both pass a check taken before the write.
  await assertOwn(args);
  await prisma.$transaction(async (tx) => {
    const stamped = await tx.inboundLoad.updateMany({
      where: { id: args.loadId, weight_skipped_at: null },
      data: { weight_skipped_at: new Date() },
    });
    // Already stamped: the decision stands and there is nothing new to record.
    // An audit row here would claim a state change that did not happen.
    if (stamped.count === 0) return;
    // Hard rule #6 — the audit row rides the same transaction as the change it
    // describes (ADR-0118 D3).
    await writeAudit(
      {
        actor_user_id: args.operatorUserId,
        action: 'update',
        table_name: 'inbound_loads',
        row_id: args.loadId,
        before: { weight_skipped_at: null },
        after: { weight_skipped_at: 'set', reason: 'operator declared no weight ticket' },
      },
      { tx },
    );
  });
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
  // `allowedFrom` is not decoration. ADR-0090 Am.1 added `finished` to
  // `ALLOWED_PRIOR.in_progress` for the reopen; without this narrowing, a
  // hand-crafted POST to `beginUnloadAction` would reopen a finished load
  // through the door-open path, with no reopen reason on the audit row and no
  // operator intent behind it.
  await transition({ ...args, to: 'in_progress', allowedFrom: ['unload_started'] });
}

/**
 * ADR-0090 Amendment 1 (B) — go back from Finish to correct the count.
 *
 * JT, 2026-08-10: _"if you want to go back to fix or check what you entered is
 * correct, vision doesn't let you."_ The Finish stage was the hardest wall: an
 * operator who sees 47 and knows it should be 42 had no route back, and the only
 * remedy was to void the whole load and re-walk the truck.
 *
 * ## The one thing a reopen must not do
 *
 * Bill, 2026-08-10: the duration FREEZES at the first finish. `finishUnload`
 * computed `unload_duration_seconds` from `unload_started_at` to _now_, so a
 * re-finish would add the entire reopen gap — and that figure feeds throughput
 * and productivity surfaces, where it reads as "how long the truck took". An
 * operator who went back to correct a number would show up as an operator who
 * unloaded slowly. See `finishUnload`, where the freeze is a WHERE clause rather
 * than a branch.
 *
 * ## What a reopen deliberately does NOT change
 *
 * The slot. `expected_load_id` is untouched, and `in_progress` is inside
 * `OPEN_DOCK_STATUSES`, so a reopened load still consumes its haul — it is live
 * work again, and the real truck must not be able to check in underneath it.
 * That is the opposite of the void, which severs the slot precisely because the
 * load was never real.
 *
 * The void also stays reachable: `ALLOWED_PRIOR.voided` already lists both
 * `in_progress` and `finished`, so a reopen moves the load between two states
 * that are equally voidable and changes nothing about that set.
 *
 * Terminal-by-construction cases are refused rather than absorbed: unlike the
 * void's replay branch, a second reopen has no "the first one is the one that
 * happened" reading — the load is already `in_progress`, so the operator is
 * looking at the count and the honest answer is the 409.
 */
export async function reopenLoad(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
}): Promise<void> {
  await transition({
    ...args,
    to: 'in_progress',
    allowedFrom: ['finished'],
    reason: 'reopened_for_correction',
  });
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
    //
    // ── ADR-0090 Am.1 — and only if it is not VOIDED ──────────────────────────
    //
    // The sequence this closes: a stack lands, its response is lost so the queue
    // entry is retained, the operator notices the count was wrong and voids the
    // stack, and then the queue replays. Without the `voided_at` requirement the
    // replay finds a byte-for-byte match, reports 201, and the replay loop
    // deletes the entry — a stack of mattresses is gone from a billed total,
    // with no error and no record anywhere that the replay happened.
    //
    // `stack_index` is monotonic (the client counts over voided rows too), so an
    // index holding a voided row can ONLY be reached by a replay of the write
    // that was voided. There is no honest 201 here, so this is always a 409 and
    // the entry parks for a person.
    const existing = await prisma.loadStack.findUnique({
      where: {
        load_id_stack_index: { load_id: args.loadId, stack_index: args.stackIndex },
      },
      select: { unit_count: true, count_mode: true, voided_at: true },
    });
    if (
      existing?.voided_at == null &&
      existing?.unit_count === args.unitCount &&
      existing.count_mode === args.countMode
    ) {
      return;
    }
    throw new LoadAccessError(409, 'stack_index_conflict');
  }
}

/**
 * The statuses in which the floor may still CORRECT what it entered.
 *
 * Deliberately not `OPEN_DOCK_STATUSES`: `arrived` is excluded because at
 * `arrived` the operator is still standing on the weight stage — there is
 * nothing to go back to, and a weight written without the stage's
 * `arrived → weight_captured` move would leave the workflow re-offering a stage
 * the operator has already completed. Past `submitted` the load has left the
 * floor's hands and may already sit on an MRC invoice; correcting THAT is
 * ADR-0073's manager territory.
 */
const CORRECTABLE_STATUSES: readonly LoadStatus[] = [
  'weight_captured',
  'unload_started',
  'in_progress',
  'finished',
] as const;

/**
 * ADR-0090 Amendment 1 (B) — fix a weight that was entered wrong.
 *
 * An OVERWRITE of `weight_lbs` with NO status transition, and the record of the
 * change is a NEW audit row rather than an edit of the old one (CLAUDE.md hard
 * rule #6 — the log is append-only). Both halves matter:
 *
 *   - No transition, because a correction is not a stage move. Routing it
 *     through `recordWeightCapture` would push a load at `in_progress` back to
 *     `weight_captured` and re-offer the door-open stage it has already passed.
 *   - A second audit row, because "the weight was 12,000 and then it was 21,000"
 *     is the fact a manager reconciling against a scale ticket needs. Mutating
 *     the first row would leave the load asserting it had always said 21,000.
 *
 * Same 1..100,000 lb range as the capture, restated here rather than shared with
 * `recordWeightCapture` only because that one throws a bare `Error`; this raises
 * a typed 422 so the client gets an actionable status instead of a 500.
 */
export async function correctWeight(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
  weightLbs: number;
}): Promise<void> {
  if (!Number.isInteger(args.weightLbs) || args.weightLbs < 1 || args.weightLbs > 100_000) {
    throw new LoadAccessError(422, 'weight_out_of_range');
  }
  const current = await assertOwn(args);
  if (!CORRECTABLE_STATUSES.includes(current.status)) {
    throw new LoadAccessError(409, 'load_not_correctable');
  }
  if (current.weight_lbs === args.weightLbs) return; // Nothing changed; no audit noise.

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.inboundLoad.update({
      where: { id: args.loadId },
      data: { weight_lbs: args.weightLbs, weight_captured_at: now },
    });
    await writeAudit(
      {
        actor_user_id: args.operatorUserId,
        action: 'update',
        table_name: 'inbound_loads',
        row_id: args.loadId,
        before: { weight_lbs: current.weight_lbs },
        after: { weight_lbs: args.weightLbs, reason: 'weight_corrected' },
      },
      { tx },
    );
  });
}

/**
 * ADR-0090 Amendment 1 (B) — take back a stack that was counted wrong.
 *
 * SOFT, never a delete. A stack is a BILLED unit — `finishUnload` sums
 * `load_stacks` into `total_units` — so the row that was counted has to survive
 * as the evidence it was counted, and the append-only audit row has to point at
 * something that still exists. Both sum sites filter `voided_at IS NULL`
 * instead.
 *
 * ## Why `in_progress` only
 *
 * The count is live in exactly that state. On a `finished` load the route is
 * `reopenLoad` first, which is audited as its own event — so "the count changed
 * after the load was finished" always has a reopen row in front of it, rather
 * than a stack quietly vanishing out of a completed total.
 *
 * ## Why the stack id is checked against THIS load
 *
 * `stackId` comes from the client. `assertOwn` proves the operator holds the
 * LOAD; without the second check an operator holding load A could name a stack
 * on load B and remove units from a load they do not hold, and both loads would
 * look perfectly healthy afterwards.
 *
 * A second void of the same stack is a silent no-op, not an error — the screen
 * is reachable from a stale tab and the FIRST void is the one that happened.
 * Same shape as `voidLoad` and `finishUnload`'s ADR-0078 D7 branch.
 */
export async function voidStack(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
  stackId: string;
}): Promise<void> {
  const current = await assertOwn(args);
  if (current.status !== 'in_progress') {
    throw new LoadAccessError(409, 'load_not_unloading');
  }

  const stack = await prisma.loadStack.findUnique({
    where: { id: args.stackId },
    select: { id: true, load_id: true, stack_index: true, unit_count: true, voided_at: true },
  });
  // 404 and not 403: an id that names no stack and an id that names another
  // load's stack are the same answer to this operator — "there is no such stack
  // here" — and distinguishing them would confirm the existence of a row they
  // may not read.
  if (!stack || stack.load_id !== args.loadId) throw new LoadAccessError(404, 'stack_not_found');
  if (stack.voided_at) return;

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.loadStack.update({
      where: { id: stack.id },
      data: { voided_at: now, voided_by: args.operatorUserId },
    });
    await writeAudit(
      {
        actor_user_id: args.operatorUserId,
        action: 'update',
        table_name: 'load_stacks',
        row_id: stack.id,
        before: {
          load_id: stack.load_id,
          stack_index: stack.stack_index,
          unit_count: stack.unit_count,
        },
        after: { voided_at: now, voided_by: args.operatorUserId, reason: 'stack_voided' },
      },
      { tx },
    );
  });
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
    // ADR-0090 Am.1 — `voided_at: null`, and this is the sum site that matters
    // most. It rewrites `total_units` on an ALREADY finished load, so filtering
    // the primary sum below and not this one would let any keyed retry — a
    // dropped response on a dock connection is the ordinary case — silently
    // RESTORE voided units into a billed total, leaving the load looking
    // perfectly healthy. The two sums must be byte-identical in their filter.
    const late = await prisma.loadStack.findMany({
      where: { load_id: args.loadId, ...NOT_VOIDED_STACK },
      select: { unit_count: true },
    });
    const total = late.reduce((acc, s) => acc + s.unit_count, 0);
    const row = await prisma.inboundLoad.findUnique({
      where: { id: args.loadId },
      select: { total_units: true },
    });
    if (row && row.total_units !== total) {
      // ── ADR-0118 — the BILLED total and its audit row commit together ───────
      //
      // This branch rewrites `total_units` on an already-finished load, which
      // is the number the load is billed on. It was two sequential writes on
      // the shared client, so a failure between them left the billed total
      // changed with nothing recording that it had been — and the non-replay
      // path fifty lines below already does this inside a transaction, so the
      // two halves of one function disagreed about whether a total rewrite is
      // auditable.
      //
      // Guarded on `total_units: row.total_units`, the value the recompute was
      // measured against: two replays of the same queued stack both compute the
      // same total, and the second must not write a second audit row claiming a
      // change that had already happened. `count === 0` is that case and is a
      // silent no-op, not an error — a replay is the ordinary case on a dock
      // connection, which is the whole reason this branch exists.
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.inboundLoad.updateMany({
          where: { id: args.loadId, total_units: row.total_units },
          data: { total_units: total },
        });
        if (count === 0) return;
        await writeAudit(
          {
            actor_user_id: args.operatorUserId,
            action: 'update',
            table_name: 'inbound_loads',
            row_id: args.loadId,
            before: { total_units: row.total_units },
            after: { total_units: total, reason: 'stack replayed after finish (ADR-0078)' },
          },
          { tx },
        );
      });
    }
    return;
  }

  if (!ALLOWED_PRIOR.finished.includes(current.status)) {
    throw new TransitionError(current.status, 'finished');
  }

  const now = new Date();
  const startedAt = current.unload_started_at ?? now;
  const duration = Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000));
  // Same filter as the replay branch above. See NOT_VOIDED_STACK.
  const stacks = await prisma.loadStack.findMany({
    where: { load_id: args.loadId, ...NOT_VOIDED_STACK },
    select: { unit_count: true },
  });
  const totalUnits = stacks.reduce((acc, s) => acc + s.unit_count, 0);

  // ── ADR-0090 Am.1 — the duration FREEZES at the first finish ───────────────
  //
  // Bill's call, 2026-08-10, and it is the decision that unblocked the reopen.
  // `unload_duration_seconds` runs `unload_started_at → now`, so a re-finish
  // after a reopen would add the whole correction gap. The number feeds
  // throughput and productivity surfaces, where it is read as "how long the
  // truck took" — so an operator who went back to fix a count would show up as
  // an operator who unloaded slowly, and the surface that exists to reward
  // accuracy would punish it.
  //
  // Enforced as a CONDITIONAL UPDATE whose WHERE is
  // `unload_duration_seconds IS NULL`, not as a branch on a value read a moment
  // earlier and not as a decision in the UI. Three consequences, all wanted:
  //
  //   - The freeze holds however the second finish is reached — the reopen path,
  //     a replayed queue entry, a hand-crafted POST.
  //   - It holds under CONCURRENCY. Two finishes racing both compute a duration;
  //     the second matches zero rows rather than winning a read-then-write.
  //   - There is exactly ONE writer of these two columns, and it refuses to
  //     write twice. A future path that forgets the rule inherits it.
  //
  // `unload_finished_at` is frozen alongside it, deliberately. Advancing the
  // timestamp while freezing the duration would leave the pair disagreeing — the
  // schema documents the column as `unload_started_at → unload_finished_at` —
  // and anything that recomputed the duration from the timestamps would get a
  // different answer from the stored one. The instant of a RE-finish is not
  // lost: it is the audit row this transaction writes.
  await prisma.$transaction(async (tx) => {
    const timing = await tx.inboundLoad.updateMany({
      where: { id: args.loadId, unload_duration_seconds: null },
      data: { unload_finished_at: now, unload_duration_seconds: duration },
    });
    await tx.inboundLoad.update({
      where: { id: args.loadId },
      data: { status: 'finished', total_units: totalUnits, count_mode: args.countMode },
    });
    await writeAudit(
      {
        actor_user_id: args.operatorUserId,
        action: 'update',
        table_name: 'inbound_loads',
        row_id: args.loadId,
        before: { status: current.status },
        after: {
          status: 'finished',
          total_units: totalUnits,
          // Says which of the two this was, so a re-finish is legible in the log
          // without diffing timestamps.
          unload_timing: timing.count === 1 ? 'measured' : 'frozen_at_first_finish',
        },
      },
      { tx },
    );
  });
}

/**
 * ADR-0090 C — close a load that should never have been started.
 *
 * JT, 2026-08-10: _"I'm not able to fix the pending one under my name, it
 * doesn't let me 0 it out."_ She was right. `addStack` refuses `unitCount < 1`,
 * so a load cannot be zeroed, and no abandon path existed — a mis-tapped haul
 * stayed "pending, needs attention" forever. Three were fixed by hand-audited DB
 * surgery in August; this is the floor-side answer.
 *
 * ## A void is not a zero
 *
 * Deliberately NOT modelled as a 0-unit submit. A truck that arrived carrying
 * nothing is a real delivery with a real count, and it belongs in `submitted`
 * where the exports can see it. A load that was never a truck must not appear in
 * a delivery record at all. ADR-0077 D4 drew the same line between "not
 * recorded" and zero, and collapsing them is how a phantom haul reaches MyMRC.
 *
 * ## Why the slot is severed
 *
 * `inbound_loads.expected_load_id` is UNIQUE and `startInboundLoad` is
 * idempotent on it: a tap on a consumed slot returns the EXISTING child. So a
 * voided child that kept its parent would hand every future tap back the dead
 * load, and the real truck could never check in — precisely the dead end
 * ADR-0074 Am.1 closed from the other side. The void NULLs `expected_load_id`
 * and records it in `voided_from_expected_load_id`, which frees the slot for
 * both check-in surfaces (they read it through `toConsumedLoad`) without losing
 * the answer to "which haul did they mis-tap?".
 *
 * ## Authorization
 *
 * The holder only. Becoming the holder is the existing ADR-0082 takeover, which
 * is audited and names both parties — so a manager voids by taking over first,
 * and no second authorization path is invented. Two places that have to agree
 * about who holds a load is the defect ADR-0082 spent a whole section removing.
 *
 * ## ADR-0128 — authorization and ATTRIBUTION are now two arguments
 *
 * They used to be one. `operatorUserId` both proved the caller may void and
 * became `voided_by` and the audit row's `actor_user_id`, so a void performed on
 * an operator's behalf — by a script, by a manager, by ADR-0073 when it exists —
 * silently signed itself with that operator's name. The 2026-08-25 Lake County
 * correction did exactly that: `inbound_loads.voided_by` names Janette Tomas for
 * a decision Bill made and a script executed, and only a supplementary audit row
 * says otherwise (OPEN-ITEMS §0.BO, BO-6).
 *
 * `operatorUserId` keeps its ONE job — it is the holder, and the ownership check
 * is unchanged. `actor` is who decided. Omit it and behaviour is identical to
 * before, which is what the floor's own void panel wants: there the holder IS
 * the actor.
 */
export interface VoidActor {
  /** The deciding Vision user, when that is somebody other than the holder. */
  userId?: string | null;
  /**
   * A non-user actor — a script, a scheduled job — in the repo's established
   * `system:<slug>` shape (`audit_log.actor_label`, the 2026-08-06 terex
   * one-offs). A label rather than a borrowed `users.id`.
   */
  label?: string | null;
}

export async function voidLoad(args: {
  loadId: string;
  /** THE HOLDER. Authorization only — see {@link VoidActor} for attribution. */
  operatorUserId: string;
  siteId: string;
  reason: LoadVoidReason;
  note: string | null;
  /**
   * ADR-0128 — who is actually making this decision, when it is not the holder.
   * Absent ⇒ the holder is the actor (the floor's own void panel).
   */
  actor?: VoidActor | undefined;
}): Promise<void> {
  const note = args.note?.trim() || null;
  // Checked BEFORE the ownership read so a malformed request cannot be used to
  // probe which loads exist at a site.
  if (args.reason === 'other' && !note) {
    throw new LoadAccessError(422, 'void_note_required');
  }

  // ADR-0128 — an `actor` that names nobody is worse than no `actor` at all: it
  // would blank `voided_by` and put nothing in its place, leaving a voided row
  // that cannot say who closed it. Refused at the door rather than normalised
  // back to the holder, which would silently reinstate the bug this argument
  // exists to fix.
  const actorUserId = args.actor?.userId?.trim() || null;
  const actorLabel = args.actor?.label?.trim() || null;
  if (args.actor && !actorUserId && !actorLabel) {
    throw new LoadAccessError(422, 'void_actor_required');
  }

  const current = await assertOwn({
    loadId: args.loadId,
    operatorUserId: args.operatorUserId,
    siteId: args.siteId,
  });

  // Replay, not an error. The void is offered from a queue row that may be a
  // stale tab, and a second void must not overwrite the first one's reason,
  // actor or instant — the FIRST void is the one that happened. Same shape as
  // `finishUnload`'s ADR-0078 D7 branch, minus the recompute: there is nothing
  // to recompute, a voided load carries no units anywhere.
  if (current.status === 'voided') return;

  if (!ALLOWED_PRIOR.voided.includes(current.status)) {
    throw new TransitionError(current.status, 'voided');
  }

  const now = new Date();
  const severed = current.expected_load_id;
  const severedHaulId = current.external_mymrc_haul_id;
  // ADR-0128 — attribution. No `actor` ⇒ the holder decided, exactly as before.
  const attributedUserId = args.actor ? actorUserId : args.operatorUserId;
  const attributedLabel = args.actor ? actorLabel : null;
  await prisma.$transaction(async (tx) => {
    await tx.inboundLoad.update({
      where: { id: args.loadId },
      data: {
        status: 'voided',
        voided_at: now,
        voided_by: attributedUserId,
        voided_by_label: attributedLabel,
        void_reason: args.reason,
        void_note: note,
        expected_load_id: null,
        voided_from_expected_load_id: severed,
        // ── ADR-0128 — the haul number is severed WITH the slot ──────────────
        //
        // Not tidiness: `inbound_loads.external_mymrc_haul_id` is UNIQUE, and as
        // of ADR-0128 a dock capture carries it. A voided load that kept it
        // would hold the number against the whole table, so the re-check-in this
        // void exists to make possible would die inside `startInboundLoad` on a
        // `P2002` that `isExpectedLoadClaimCollision` correctly refuses to
        // absorb — a raw 500 on the one tap the operator has been told to make.
        // That is the ADR-0074 Am.1 dead end, reintroduced through a different
        // column, and it is closed here rather than discovered on a dock.
        //
        // The answer to "which haul did they mis-tap?" is not lost:
        // `voided_from_expected_load_id` still points at the slot, and this
        // transaction's audit row names the number outright.
        external_mymrc_haul_id: null,
      },
    });
    // In-transaction (ADR-0082): the void and the record of who made it commit
    // or roll back together. `before` carries the severed slot so the void is
    // reconstructible from the append-only log rather than merely asserted.
    await writeAudit(
      {
        actor_user_id: attributedUserId,
        actor_label: attributedLabel,
        action: 'update',
        table_name: 'inbound_loads',
        row_id: args.loadId,
        before: {
          status: current.status,
          expected_load_id: severed,
          external_mymrc_haul_id: severedHaulId,
        },
        after: {
          status: 'voided',
          void_reason: args.reason,
          void_note: note,
          voided_at: now,
          voided_from_expected_load_id: severed,
          // ADR-0128 — present ONLY when somebody other than the holder decided.
          // The presence of the key is the signal, the same way ADR-0096's
          // `reconciled_from_day` is; an ordinary floor void is byte-identical to
          // the rows written before this ADR.
          ...(args.actor ? { voided_on_behalf_of: args.operatorUserId } : {}),
        },
      },
      { tx },
    );
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
      submitted_by_id: args.operatorUserId,
    },
  });
}

/**
 * ADR-0113 — refuse the physical load, at any stage the floor still holds it.
 *
 * ## Why this stopped going through `transition()`
 *
 * It used to be a four-line `transition({ to: 'rejected' })`, and every one of
 * the following was missing rather than decided:
 *
 * - **The audit row said nothing.** `transition` writes
 *   `after: { status: 'rejected' }`, so in the entire history of this table no
 *   rejection's REASON has ever reached the append-only log. The category and
 *   note landed on the mutable `inbound_loads` row and nowhere else — which is
 *   the one place a later correction can overwrite them.
 * - **The evidence photo was a disabled button.** `stage-reject.tsx` gates on
 *   `!hasPhoto` client-side and the server never looked, so a hand-crafted POST
 *   could refuse a truck with no evidence at all. A rejection is a contractual
 *   assertion to the carrier and to MRC; the photo is the whole of the proof.
 * - **It cannot carry the stack sweep.** This bullet used to read "it was not
 *   transactional". That is **no longer true** — ADR-0118 gave `transition` a
 *   guarded `updateMany` and an in-transaction audit, closing that window on its
 *   own. Re-checked against the file on the 2026-08-24 rebase rather than
 *   carried over from the draft. What `transition` still cannot do is soft-void
 *   the load's stacks and audit each one in that SAME transaction, which is the
 *   whole of D4: a reject that flipped the status in one transaction and swept
 *   the stacks in another can leave a refused load whose stacks still count.
 * - **A second tap was a 409.** The screen is reachable from a stale tab, and
 *   ADR-0118's rewrite kept that shape — `count === 0` re-reads and re-throws
 *   `TransitionError`. There is still no replay branch.
 *
 * So this follows `voidLoad`'s shape, for the reasons ADR-0090 D2 gives, and the
 * two floor exits stay legible as siblings — with one deliberate divergence:
 * the status flip below is guarded the ADR-0118 way, which `voidLoad` is not.
 *
 * ## The stacks
 *
 * Every live stack is soft-voided in the SAME transaction (D4). Not deleted, and
 * their `unit_count` / `stack_index` / `count_mode` are untouched — ADR-0090
 * Am.1's rule, and the reason it matters here is that "we counted 47 before we
 * found the bugs" is evidence about the load, not a mistake to erase. Voiding
 * them is what stops `finishUnload`'s two sum sites from ever seeing them, and
 * `NOT_VOIDED_STACK` is the filter both already use.
 *
 * Doing it here rather than leaving the stacks live is not belt-and-braces:
 * `rejected` is outside every money allow-list, so the LOAD is already excluded,
 * but the stacks would remain the only rows in the database asserting that this
 * refused truck delivered units.
 *
 * ## The slot is RETAINED — the deliberate inversion of the void
 *
 * `voidLoad` NULLs `expected_load_id` because a void asserts the slot was never
 * legitimately consumed (wrong haul, or no truck), so the real haul must stay
 * checkable-in. A reject asserts the OPPOSITE: the truck came, against this
 * haul, and we refused it. That is a true and final fact about the slot, and
 * severing it would offer the refused haul for a second check-in — minting a
 * second child for one physical delivery, which is the collision
 * `expected_load_id`'s UNIQUE index exists to prevent.
 *
 * Both check-in surfaces already render this correctly and have since ADR-0091:
 * `toConsumedLoad` returns a non-null ref for a `rejected` child, `open` is
 * false (it is not in `OPEN_DOCK_STATUSES`), `describeConsumedSlot` answers
 * `worked`, and the card falls to `already_worked_status` — which reads
 * "Rejected at the dock" through `floorStatusKey`. That path was built for the
 * early reject and needs no change for the late one; the test pins it so a
 * future edit cannot sever the slot by analogy with the void.
 *
 * A fumigated redelivery days later is a NEW haul with a new appointment and a
 * new MyMRC row — not a re-entry into the slot of the delivery we refused.
 * Filing it there would date the redelivery to the day we turned it away.
 *
 * ## Authorization
 *
 * The holder, full stop — ADR-0090 D2.3, and the same rule the early reject
 * already had. The floor found the bugs mid-unload with the truck at the dock; a
 * path that requires finding a manager first IS the dead end, relocated. A
 * manager rejects by taking over (ADR-0082), which is audited and names both
 * parties.
 */
export async function rejectLoad(args: {
  loadId: string;
  operatorUserId: string;
  siteId: string;
  category: RejectionCategory;
  note: string | null;
}): Promise<void> {
  const note = args.note?.trim() || null;
  // Checked BEFORE the ownership read, like `voidLoad`'s, so a malformed request
  // cannot be used to probe which loads exist at a site.
  //
  // ADR-0113 D5 — this tightens the EXISTING pre-acceptance reject too, which
  // enforced neither this nor the photo. Deliberate: one function serves both
  // entry points, and a note rule that depended on WHEN the problem was spotted
  // would be the same incoherence the slot decision refuses. `other` is the only
  // category that says nothing on its own; `bedbugs` describes itself.
  if (args.category === 'other' && !note) {
    throw new LoadAccessError(422, 'rejection_note_required');
  }

  const current = await assertOwn({
    loadId: args.loadId,
    operatorUserId: args.operatorUserId,
    siteId: args.siteId,
  });

  // Replay, not an error — the FIRST rejection is the one that happened, and a
  // second tap must not overwrite its category, note, actor or instant. Same
  // shape as `voidLoad` and `finishUnload`'s ADR-0078 D7 branch. This replaces a
  // `TransitionError` 409 that an operator on a stale tab could reach by doing
  // nothing wrong.
  if (current.status === 'rejected') return;

  if (!ALLOWED_PRIOR.rejected.includes(current.status)) {
    throw new TransitionError(current.status, 'rejected');
  }

  // ADR-0113 D3 — the evidence photo, enforced where it can actually be
  // enforced. Read inside the same transaction as the write below so the check
  // and the decision cannot be separated by a photo purge.
  //
  // Counted, never trusted from the client: the `LoadPhoto` row is written by
  // `/api/photos/confirm` before this action fires (the reject is online-only —
  // it is not in `FLOOR_SCOPES`, so it is never replayed from the queue), which
  // means by the time we are here the row either exists or the operator has no
  // evidence.
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const photos = await tx.loadPhoto.count({
      where: { load_id: args.loadId, kind: 'rejection', purged_at: null },
    });
    if (photos === 0) throw new LoadAccessError(422, 'rejection_photo_required');

    // Selected before the update so the audit rows carry what was true.
    const liveStacks = await tx.loadStack.findMany({
      where: { load_id: args.loadId, ...NOT_VOIDED_STACK },
      select: { id: true, stack_index: true, unit_count: true },
      orderBy: { stack_index: 'asc' },
    });
    const unitsVoided = liveStacks.reduce((n, s) => n + s.unit_count, 0);

    const { count } = await tx.inboundLoad.updateMany({
      // ADR-0118 — the status the transition was authorised FROM is restated
      // here, so a concurrent finish, void or takeover landing between
      // `assertOwn` and this write LOSES instead of being silently overwritten.
      // `updateMany` is also scalar-only, which is why `submitted_by_id` is set
      // directly: a nested `connect` is refused at argument validation.
      //
      // `voidLoad` has not been given this guard (its write is still
      // `update({ where: { id } })`); that is recorded as a residual rather than
      // widened into a floor-facing PR.
      where: { id: args.loadId, status: current.status },
      data: {
        status: 'rejected',
        rejection_category: args.category,
        rejection_note: note,
        submitted_at: now,
        submitted_by_id: args.operatorUserId,
      },
    });
    if (count === 0) {
      const observed = await tx.inboundLoad.findUniqueOrThrow({
        where: { id: args.loadId },
        select: { status: true },
      });
      throw new TransitionError(observed.status, 'rejected');
    }

    await writeAudit(
      {
        actor_user_id: args.operatorUserId,
        action: 'update',
        table_name: 'inbound_loads',
        row_id: args.loadId,
        // `before` carries what the load was and what it was carrying, so the
        // rejection is RECONSTRUCTIBLE from the append-only log rather than
        // merely asserted by it. `expected_load_id` is recorded unchanged, which
        // is the readable difference from a void's `before`.
        before: {
          status: current.status,
          expected_load_id: current.expected_load_id,
          live_stacks: liveStacks.length,
          live_units: unitsVoided,
        },
        after: {
          status: 'rejected',
          rejection_category: args.category,
          rejection_note: note,
          rejected_at: now,
          expected_load_id: current.expected_load_id,
          stacks_voided: liveStacks.length,
          units_voided: unitsVoided,
          reason: 'rejected_after_unload_start',
        },
      },
      { tx },
    );

    // The stack sweep and its audit, together, and only when there is something
    // to sweep. A load refused before anyone counted is the ordinary case, not
    // an edge one, and it should touch neither table.
    if (liveStacks.length > 0) {
      await tx.loadStack.updateMany({
        where: { load_id: args.loadId, ...NOT_VOIDED_STACK },
        data: { voided_at: now, voided_by: args.operatorUserId },
      });
      // One row per stack, so "what happened to stack 7" is answerable through
      // the `([table_name, row_id])` index — the same shape `voidStack` writes
      // by hand. Batched because ledger mode writes one stack per mattress (D4).
      await writeAuditMany(
        liveStacks.map((s) => ({
          actor_user_id: args.operatorUserId,
          action: 'update' as const,
          table_name: 'load_stacks',
          row_id: s.id,
          before: {
            load_id: args.loadId,
            stack_index: s.stack_index,
            unit_count: s.unit_count,
          },
          after: {
            voided_at: now,
            voided_by: args.operatorUserId,
            reason: 'load_rejected',
          },
        })),
        { tx },
      );
    }
  });
}
