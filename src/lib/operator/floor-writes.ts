// ADR-0078 — the floor's write surface, in ONE place.
//
// Every operator write now exists as a named `FloorScope` with a zod schema, a
// rollout gate, a day-pin policy and a handler. The live API routes and the
// offline-queue replay endpoint both dispatch through this table, so "a replay
// is subject to the same gates as a live submit" is a structural fact rather
// than a claim two files have to keep agreeing on.
//
// That mattered more than the tidiness: the replay endpoint accepts a body that
// has been sitting in an iPad's IndexedDB, possibly for days, possibly edited.
// If it had its own copy of the auth/gate/day logic, the copy would drift, and
// the drift would be invisible until a stale entry wrote something the live path
// would have refused.
//
// ## Three rules that hold for every scope here
//
// 1. **Identity is re-derived from the session, never read from the payload.**
//    The handler receives `ctx` from `requireActivatedOperator`. A queued body
//    naming a user or a site is ignored — it is the one field an attacker (or a
//    stale queue) would most want to control.
// 2. **The day is pinned before dispatch, not inside the write.** A queued entry
//    carries the day it was FOR. If that is not today, it is refused (422
//    `date_not_today`) and stays queued as a conflict for a person to resolve.
//    Never retargeted to today — filing yesterday's count against today is a
//    silent money error, and it is the specific thing ADR-0065's pin exists to
//    prevent.
// 3. **The idempotency key is claimed in the write's own transaction** wherever
//    the write is an append (see `requiresAtomicClaim` below).

import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { withIdempotency } from '@/lib/idempotency';
import { reconcilePhysicalCount } from '@/lib/inventory/running-balance';
import {
  classifyAnchorWrite,
  describeSwing,
  loadPriorAnchor,
  loadSwingThresholdPct,
} from '@/lib/inventory/anchor-guardrail';
import { createHold, eligibleApprovers } from '@/lib/inventory/anchor-holds';
import { createFloorDropoff, FLOOR_DROPOFF_KINDS } from '@/lib/dropoffs/floor-dropoff';
import { isValidDropoffStorageKey } from '@/lib/r2';
import { confirmFloorInboundDay } from '@/lib/loads/floor-inbound';
import { upsertProcessedUnits } from '@/lib/loads/processed-units';
import { addStack, finishUnload } from '@/lib/load-service';
import { UI_SURFACE, type UiSurfaceCode } from '@/lib/notify/rollout';
import { pacificMidnightInstantOfDayISO } from '@/lib/time';
import type { OperatorSiteContext } from '@/lib/auth-helpers';

/** The write classes an operator device may submit — live or replayed. */
export const FLOOR_SCOPE = {
  COUNT_CREATE: 'operator.count.create',
  INBOUND_CONFIRM: 'operator.inbound.confirm',
  PROCESSED_CONFIRM: 'operator.processed.confirm',
  LOAD_ADD_STACK: 'operator.load.add_stack',
  LOAD_FINISH_UNLOAD: 'operator.load.finish_unload',
  /** ADR-0085 — walk-up Public / Incentive drop-off (units + required photo). */
  DROPOFF_CREATE: 'operator.dropoff.create',
} as const;

export type FloorScope = (typeof FLOOR_SCOPE)[keyof typeof FLOOR_SCOPE];

/** What a handler hands back to whichever transport invoked it. */
export interface FloorWriteResult {
  status: number;
  body: unknown;
}

export interface FloorWriteInput {
  ctx: OperatorSiteContext;
  /** Already-parsed payload. Each handler re-validates through its own schema. */
  payload: unknown;
  /** Client-minted idempotency key, or null to opt out of dedupe. */
  idempotencyKey: string | null;
}

interface ScopeDefinition {
  /** The ADR-0047 surface this write is gated on — identical live and replayed. */
  surface: UiSurfaceCode;
  /**
   * True when this write is FILED AGAINST A DAY and must therefore be pinned.
   *
   * Separate from `targetDay` returning null, and the distinction is the whole
   * point: `targetDay` returns null both for a scope that has no day (a stack)
   * and for a day-addressed payload whose day field is MISSING. Treating those
   * the same lets a replayed count with no `countDate` skip the pin entirely —
   * a hand-edited or old-format queue entry would sail past the one guard
   * standing between it and today's inventory. With this flag, a day-addressed
   * scope that yields no day is refused rather than waved through.
   */
  dayAddressed: boolean;
  /** Reads the target Pacific day (YYYY-MM-DD) out of a payload. */
  targetDay: (payload: unknown) => string | null;
  handler: (input: FloorWriteInput) => Promise<FloorWriteResult>;
}

// ─────────────────────────────────────────────────────────────────────────
// operator.count.create — the physical on-hand count (the inventory anchor)
// ─────────────────────────────────────────────────────────────────────────

export const CountCreate = z.object({
  // ADR-0078 D10. The count route previously took NO date at all and derived the
  // day server-side from `new Date()`. That is correct for a live submit and
  // WRONG for a replay: an entry queued on Tuesday evening and replayed on
  // Wednesday morning would silently anchor Wednesday's inventory with Tuesday's
  // count, with nothing anywhere recording that it had moved. The day the
  // operator counted is now part of the request, so it can be checked instead of
  // assumed.
  //
  // OPTIONAL in the schema, and that is a deployment fact rather than a
  // weakening. The floor iPads are kiosks running a service worker with
  // `skipWaiting: false`, so the OLD bundle persists until someone accepts the
  // update prompt — and the old bundle sends no `countDate` at all. Requiring it
  // here would 422 every count at BOTH sites for as long as a device stayed on
  // the old shell, which is a self-inflicted outage on the one surface this ADR
  // exists to make reliable.
  //
  // The default is applied by the LIVE route only, where "now" is genuinely the
  // count's day. The replay endpoint refuses a day-addressed payload with no day
  // (see `dayAddressed`), so a stale queued entry can never reach the default
  // and be silently re-filed against today — which is the D10 bug this ADR is
  // closing, and would be a bitter way to reintroduce it.
  countDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  unitsIndoor: z.number().int().nonnegative().nullable().optional(),
  unitsTotal: z.number().int().nonnegative().nullable().optional(),
  unitsInProcessing: z.number().int().nonnegative().default(0),
  programUnits: z.number().int().nonnegative().nullable().optional(),
  nonProgramUnits: z.number().int().nonnegative().nullable().optional(),
  poolAttribution: z.enum(['measured', 'legacy']).optional(),
});

export async function countCreate(input: FloorWriteInput): Promise<FloorWriteResult> {
  const parsed = CountCreate.safeParse(input.payload);
  if (!parsed.success) return { status: 422, body: { error: 'invalid_input' } };
  const d = parsed.data;
  const { ctx } = input;

  // Fail-closed. Both callers are required to have resolved a day before they
  // get here — the live route defaults it, the replay endpoint refuses without
  // it — so there is deliberately NO fallback in this shared core. A default
  // here would silently serve the replay path too, and "today" is exactly the
  // wrong answer for an entry that has been sitting in a queue overnight.
  const countDate = d.countDate;
  if (countDate === undefined) return { status: 422, body: { error: 'count_date_required' } };

  // ── ADR-0072 — the guardrail, enforced HERE ───────────────────────────────
  // Recomputed server-side from live state on every write. The client classifies
  // the same count only to decide what dialog to show; a request that skips the
  // dialog still meets this. If the UI and this disagree, this wins — which is
  // the difference between a control and a courtesy.
  const newTotal = (d.unitsTotal ?? d.unitsIndoor ?? 0) + d.unitsInProcessing;
  const [prior, thresholdPct] = await Promise.all([
    loadPriorAnchor(prisma, ctx.siteId),
    loadSwingThresholdPct(prisma, ctx.siteId),
  ]);
  const classification = classifyAnchorWrite({ prior, newTotal, thresholdPct });

  if (classification.requiresManagerApproval) {
    // Tier 2. NOT rejected and NOT written — held with its values intact so a
    // manager can release it, and so the operator's work is never lost to a
    // refusal. A 422 here means "a person must look at this", not "try again".
    //
    // Deliberately OUTSIDE the idempotency claim: a hold is not the write this
    // key names. Claiming the key here would mean the manager's later release,
    // or an honest resubmission, replays a 422 forever.
    const hold = await createHold(prisma, {
      siteId: ctx.siteId,
      createdBy: ctx.userId,
      input: {
        unitsIndoor: d.unitsIndoor ?? null,
        unitsTotal: d.unitsTotal ?? null,
        unitsInProcessing: d.unitsInProcessing,
        programUnits: d.programUnits ?? null,
        nonProgramUnits: d.nonProgramUnits ?? null,
        poolAttribution: d.poolAttribution ?? 'measured',
      },
      classification,
    });
    const approvers = await eligibleApprovers(prisma, ctx.siteId);
    return {
      status: 422,
      body: {
        error: 'manager_approval_required',
        holdId: hold.id,
        tier: 2,
        priorTotal: classification.prior?.total ?? null,
        newTotal: classification.newTotal,
        swingPct: classification.swingPct,
        thresholdPct: classification.thresholdPct,
        message: describeSwing(classification),
        approvers,
      },
    };
  }

  // The append that MUST be exactly-once. A physical snapshot has no natural key
  // — nothing about a second identical count distinguishes it from the first —
  // so the idempotency claim is the only thing standing between a double-tap and
  // two anchors. Claim and insert share one transaction; see idempotency.ts.
  // `reconcilePhysicalCount` computes `onHand` — a six-table aggregate — before
  // its write, and that now sits inside this transaction's wall clock. Prisma's
  // default interactive-transaction timeout is 5s, which was never a constraint
  // on this path before, so a slow aggregate would turn a perfectly good count
  // into a P2028 rollback and tell the operator it failed. Explicit, generous
  // bounds rather than inheriting a default that was tuned for something else.
  const outcome = await prisma.$transaction(
    (tx) =>
      withIdempotency(
        {
          key: input.idempotencyKey,
          scope: FLOOR_SCOPE.COUNT_CREATE,
          actorUserId: ctx.userId,
          siteId: ctx.siteId,
          payload: d,
          tx,
          statusCode: 201,
        },
        async () => {
          const result = await reconcilePhysicalCount({
            siteId: ctx.siteId,
            // D-3: the count anchors at Pacific-midnight of the day it was TAKEN
            // (never UTC-midnight — see anchorFlowBounds). Derived from the
            // request's `countDate`, which the day-pin has already proven is today.
            countedAt: pacificMidnightInstantOfDayISO(countDate),
            physical: {
              units_indoor: d.unitsIndoor ?? null,
              units_total: d.unitsTotal ?? null,
              units_in_processing: d.unitsInProcessing,
            },
            programUnits: d.programUnits ?? null,
            nonProgramUnits: d.nonProgramUnits ?? null,
            poolAttribution: d.poolAttribution ?? 'measured',
            actorUserId: ctx.userId,
            tx,
          });
          return {
            ...result,
            computedTotal: result.computedTotal.toString(),
            tier: classification.tier,
            priorTotal: classification.prior?.total ?? null,
            swingPct: classification.swingPct,
            thresholdPct: classification.thresholdPct,
          };
        },
      ),
    { timeout: 20_000, maxWait: 10_000 },
  );

  return { status: outcome.statusCode, body: outcome.body };
}

// ─────────────────────────────────────────────────────────────────────────
// operator.inbound.confirm / operator.processed.confirm
// ─────────────────────────────────────────────────────────────────────────
//
// Both of these already CONVERGE: inbound is a day-keyed delete-then-write and
// processed is an upsert on `(site_id, production_date)`, so a second identical
// submit produces the same single row rather than a duplicate. Per ADR-0078 they
// get response-dedupe — the value of the key here is that a retry returns the
// original response instead of racing the service — and no new natural key is
// invented for a table that already has one.
//
// Honest limitation, stated rather than papered over: these two services own
// their own internal transactions, so the claim and the write are NOT atomic
// with each other. The failure that leaves is one-directional and benign — the
// write can commit while the claim rolls back, which costs the dedupe on a
// subsequent retry, and that retry converges to the same row anyway. The
// dangerous direction (claim commits, write does not, so a retry is answered
// with a success for a write that never happened) cannot occur, because the
// claim only commits when the enclosing transaction does. Making these fully
// atomic means threading a transaction through both services; that is a real
// change to their locking, and it buys nothing here.

export const InboundConfirm = z.object({
  inboundDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totalUnits: z.number().int().positive(),
  programUnits: z.number().int().nonnegative(),
  nonProgramUnits: z.number().int().nonnegative(),
  correctionNote: z.string().max(120).optional(),
});

export async function inboundConfirm(input: FloorWriteInput): Promise<FloorWriteResult> {
  const parsed = InboundConfirm.safeParse(input.payload);
  if (!parsed.success) return { status: 422, body: { error: 'invalid_input' } };
  const d = parsed.data;
  const { ctx } = input;

  const outcome = await prisma.$transaction((tx) =>
    withIdempotency(
      {
        key: input.idempotencyKey,
        scope: FLOOR_SCOPE.INBOUND_CONFIRM,
        actorUserId: ctx.userId,
        siteId: ctx.siteId,
        payload: d,
        tx,
        statusCode: 201,
      },
      async () => {
        const row = await confirmFloorInboundDay({
          siteId: ctx.siteId,
          // D-3: key the day at Pacific-midnight; `${date}T00:00:00Z` round-trips
          // to the same YYYY-MM-DD day key `inboundArrivedAt` consumes.
          inboundDate: new Date(`${d.inboundDate}T00:00:00Z`),
          totalUnits: d.totalUnits,
          programUnits: d.programUnits,
          nonProgramUnits: d.nonProgramUnits,
          correctionNote: d.correctionNote ?? null,
          actorUserId: ctx.userId,
        });
        return { row };
      },
    ),
  );

  return { status: outcome.statusCode, body: outcome.body };
}

export const ProcessedConfirm = z.object({
  productionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  strippedProgram: z.number().nonnegative(),
  strippedNonProgram: z.number().nonnegative(),
  notes: z.string().max(2000).optional(),
});

export async function processedConfirm(input: FloorWriteInput): Promise<FloorWriteResult> {
  const parsed = ProcessedConfirm.safeParse(input.payload);
  if (!parsed.success) return { status: 422, body: { error: 'invalid_input' } };
  const d = parsed.data;
  const { ctx } = input;

  const outcome = await prisma.$transaction((tx) =>
    withIdempotency(
      {
        key: input.idempotencyKey,
        scope: FLOOR_SCOPE.PROCESSED_CONFIRM,
        actorUserId: ctx.userId,
        siteId: ctx.siteId,
        payload: d,
        tx,
        statusCode: 201,
      },
      async () => {
        const row = await upsertProcessedUnits({
          siteId: ctx.siteId,
          productionDate: new Date(`${d.productionDate}T00:00:00Z`),
          strippedProgram: d.strippedProgram,
          strippedNonProgram: d.strippedNonProgram,
          actorUserId: ctx.userId,
          notes: d.notes ?? null,
        });
        return { row };
      },
    ),
  );

  return { status: outcome.statusCode, body: outcome.body };
}

// ─────────────────────────────────────────────────────────────────────────
// operator.load.add_stack / operator.load.finish_unload
// ─────────────────────────────────────────────────────────────────────────
//
// The dock workflow's two counting writes. Not day-addressed — a load is
// identified by its id, and the day it belongs to was fixed when it arrived, so
// there is nothing here for the day pin to check. Ownership is checked instead,
// and more strictly: `assertOwn` inside the service refuses a load that is not
// assigned to the session's operator, so a queued entry replayed after a
// handover writes nothing and surfaces as a conflict.

export const LoadAddStack = z.object({
  loadId: z.string().min(1),
  stackIndex: z.number().int().positive(),
  unitCount: z.number().int().positive(),
  countMode: z.enum(['ledger', 'multiplier', 'total']),
});

export async function loadAddStack(input: FloorWriteInput): Promise<FloorWriteResult> {
  const parsed = LoadAddStack.safeParse(input.payload);
  if (!parsed.success) return { status: 422, body: { error: 'invalid_input' } };
  const d = parsed.data;
  await addStack({
    loadId: d.loadId,
    operatorUserId: input.ctx.userId,
    siteId: input.ctx.siteId,
    stackIndex: d.stackIndex,
    unitCount: d.unitCount,
    countMode: d.countMode,
    idempotencyKey: input.idempotencyKey,
  });
  return { status: 201, body: { ok: true } };
}

export const LoadFinishUnload = z.object({
  loadId: z.string().min(1),
  countMode: z.enum(['ledger', 'multiplier', 'total']),
});

export async function loadFinishUnload(input: FloorWriteInput): Promise<FloorWriteResult> {
  const parsed = LoadFinishUnload.safeParse(input.payload);
  if (!parsed.success) return { status: 422, body: { error: 'invalid_input' } };
  const d = parsed.data;
  await finishUnload({
    loadId: d.loadId,
    operatorUserId: input.ctx.userId,
    siteId: input.ctx.siteId,
    countMode: d.countMode,
    idempotencyKey: input.idempotencyKey,
  });
  return { status: 200, body: { ok: true } };
}

// ─────────────────────────────────────────────────────────────────────────
// operator.dropoff.create — the walk-up drop-off (ADR-0085)
// ─────────────────────────────────────────────────────────────────────────
//
// Day-addressed, and an APPEND with no natural key — two drop-offs of 4 units on
// the same day are a perfectly ordinary Tuesday, so nothing about the row itself
// distinguishes a double-tap from a second walk-up. That puts it in the same
// class as `operator.count.create`: the idempotency claim is the ONLY thing
// standing between a retry and a second row, and it is claimed in the same
// transaction as the insert.
//
// ## The photo, and why the hash omits its key
//
// `photoStorageKey` is REQUIRED by the schema — a payload without one is 422
// before any write is attempted, and `createFloorDropoff` refuses it again, and
// `consumer_dropoffs_floor_requires_photo` refuses the INSERT. Three layers,
// each independently sufficient.
//
// But the key is deliberately EXCLUDED from the idempotency payload hash, and
// that omission is load-bearing rather than lazy. An offline entry that PUTs its
// blob, loses the response to the submit, and replays will re-mint a FRESH R2
// key first (the presign expires in 10 minutes; the entry may be days old).
// Hashing the key would make that replay look like key reuse and answer 409,
// turning the exactly-once fix into a second, louder bug — the identical trap
// `/api/photos/confirm` documents at its own `payload:` line. The identity of
// this write is the day, the label, the count and the site. The photo is
// evidence attached to it, not part of what makes it that write.

export const DropoffCreate = z.object({
  dropoffDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kind: z.enum(FLOOR_DROPOFF_KINDS),
  units: z.number().int().positive().max(100_000),
  /**
   * REQUIRED — `.min(1)`, not `.optional()`. This is the server-side half of
   * "no drop-off without a photo": strip the client's disabled-submit guard and
   * the request dies here, before a transaction is opened.
   */
  photoStorageKey: z.string().min(1).max(512),
  photoContentType: z.string().min(1).max(128),
  photoByteSize: z.number().int().min(0).max(50_000_000).nullable().optional(),
});

export async function dropoffCreate(input: FloorWriteInput): Promise<FloorWriteResult> {
  const parsed = DropoffCreate.safeParse(input.payload);
  if (!parsed.success) return { status: 422, body: { error: 'invalid_input' } };
  const d = parsed.data;
  const { ctx } = input;

  // The storage key came from the client — from an iPad's IndexedDB, possibly
  // days old. The CHECK constraint only requires it to be non-null, so without
  // this a submitted drop-off could name any string at all, including another
  // site's object, and the row would record it as its evidence. Checked against
  // the prefix THIS session's site mints under.
  if (!isValidDropoffStorageKey(d.photoStorageKey, ctx.siteId)) {
    return { status: 422, body: { error: 'invalid_photo_key' } };
  }

  const outcome = await prisma.$transaction((tx) =>
    withIdempotency(
      {
        key: input.idempotencyKey,
        scope: FLOOR_SCOPE.DROPOFF_CREATE,
        actorUserId: ctx.userId,
        siteId: ctx.siteId,
        // See the header: the photo key is NOT part of the request identity.
        payload: {
          dropoffDate: d.dropoffDate,
          kind: d.kind,
          units: d.units,
        },
        tx,
        statusCode: 201,
      },
      () =>
        createFloorDropoff({
          tx,
          siteId: ctx.siteId,
          dropoffDate: d.dropoffDate,
          kind: d.kind,
          units: d.units,
          photo: {
            storageKey: d.photoStorageKey,
            contentType: d.photoContentType,
            byteSize: d.photoByteSize ?? null,
          },
          actorUserId: ctx.userId,
        }),
    ),
  );

  return { status: outcome.statusCode, body: outcome.body };
}

// ─────────────────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────────────────

function dayFrom(payload: unknown, field: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const v = (payload as Record<string, unknown>)[field];
  return typeof v === 'string' ? v : null;
}

/**
 * The allowlist. A scope absent from this map cannot be replayed — the endpoint
 * answers 400 `unknown_scope`. An allowlist rather than a lookup by convention:
 * a queued body must never be able to name an arbitrary server function.
 */
export const FLOOR_SCOPES: Record<FloorScope, ScopeDefinition> = {
  [FLOOR_SCOPE.COUNT_CREATE]: {
    dayAddressed: true,
    surface: UI_SURFACE.IPAD_COUNT,
    targetDay: (p) => dayFrom(p, 'countDate'),
    handler: countCreate,
  },
  [FLOOR_SCOPE.INBOUND_CONFIRM]: {
    dayAddressed: true,
    surface: UI_SURFACE.IPAD_INBOUND,
    targetDay: (p) => dayFrom(p, 'inboundDate'),
    handler: inboundConfirm,
  },
  [FLOOR_SCOPE.PROCESSED_CONFIRM]: {
    dayAddressed: true,
    surface: UI_SURFACE.IPAD_PROCESSED,
    targetDay: (p) => dayFrom(p, 'productionDate'),
    handler: processedConfirm,
  },
  [FLOOR_SCOPE.LOAD_ADD_STACK]: {
    dayAddressed: false,
    surface: UI_SURFACE.IPAD_QUEUE,
    targetDay: () => null,
    handler: loadAddStack,
  },
  [FLOOR_SCOPE.LOAD_FINISH_UNLOAD]: {
    dayAddressed: false,
    surface: UI_SURFACE.IPAD_QUEUE,
    targetDay: () => null,
    handler: loadFinishUnload,
  },
  // ADR-0085. Day-addressed: a drop-off is filed against the day it arrived, and
  // a queued entry replayed the next morning must be refused (422 `date_not_today`)
  // and held for a person rather than silently re-filed against today — a
  // mis-dated drop-off moves the inventory ledger on two days at once.
  [FLOOR_SCOPE.DROPOFF_CREATE]: {
    dayAddressed: true,
    surface: UI_SURFACE.IPAD_DROPOFF,
    targetDay: (p) => dayFrom(p, 'dropoffDate'),
    handler: dropoffCreate,
  },
};

export function isFloorScope(value: unknown): value is FloorScope {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FLOOR_SCOPES, value);
}
