// ADR-0085 — the iPad walk-up drop-off write. Deliberately NOT in `service.ts`.
//
// JT: *"a tile or static button on the iPad; hitting it prompts Public Drop Off
// or Incentive Drop, then asks for total units and a photo."* Bill, scoping it:
// **no money, no PII** — not the payee's name, not the Incentive programme's
// $3/unit, not a check number. The Public/Incentive choice is a LABEL and
// nothing else.
//
// ## Why this is a separate module from `createDropoff`
//
// `createDropoff` in `service.ts` exists to record money and identity: it
// resolves the `collector_incentive` rule, computes a capped `incentive_cents`,
// defaults `incentive_amount_cents` to units × 300¢, and requires a
// `person_name`. Every one of those is correct there and forbidden here.
//
// Sharing one function and passing nulls would have worked and would have been
// wrong. A parameter you must remember not to pass is a rule that survives
// exactly as long as everyone remembers it, and the money-minting default in
// `defaultIncentiveAmountCents` is precisely what that kind of memory failure
// looks like when it has been running for a year. `createFloorDropoff` has NO
// money parameter and NO name parameter, so a caller cannot supply one — not
// because they are disciplined, but because the type does not have the field.
//
// Three layers say the same thing, and each is independently sufficient:
//
//   1. this signature — no money/name argument exists to pass;
//   2. the explicit `null`s written below — visible in the diff, not implied;
//   3. `consumer_dropoffs_floor_no_money_or_pii` — a CHECK constraint, so even
//      a raw SQL write or a future service that ignores this file is refused.
//
// Layer 3 is the one that matters in two years. Layers 1 and 2 are what make it
// readable now.
//
// ## What this write deliberately does NOT touch
//
// Only `consumer_dropoffs`. Not `inbound_loads`, not `processed_units_daily`.
//
// `onHand` (running-balance.ts) already adds `SUM(consumer_dropoffs.units)` into
// the PROGRAM pool with no `kind` filter, so these rows reach inventory the
// moment they are written and no aggregation needs teaching about them. The
// double-count risk here was never the enum — every aggregation is kind-blind —
// it is writing the same physical mattresses into a second leg. The MyMRC
// inbound bridge avoids exactly this by excluding `type='Consumer Dropoff'`
// (`mymrc/inbound-bridge.ts`); this path avoids it by writing one row to one
// table. `processed_units_daily` and its `source='mymrc' AND closed_at IS NULL`
// precedence are untouched because this flow is not a processing figure and has
// no business having an opinion about one.

import type { Prisma } from '@prisma/client';
import { assertWholeUnits } from '@/lib/dropoffs/service';
import { lockSiteAgainstPromotion } from '@/lib/audit/promotion-lock';
import { RecordValidationError } from '@/lib/loads/record-guards';

const TABLE = 'consumer_dropoffs';

/**
 * The two label-only kinds, narrowed from `ConsumerDropoffKind`.
 *
 * Narrowed rather than reusing the full enum so the compiler refuses a caller
 * that hands this path `incentive` — which would resolve a payout rule and a
 * per-person cap on a flow that captures no person.
 */
export const FLOOR_DROPOFF_KINDS = ['floor_public', 'floor_incentive'] as const;
export type FloorDropoffKind = (typeof FLOOR_DROPOFF_KINDS)[number];

export function isFloorDropoffKind(value: unknown): value is FloorDropoffKind {
  return (FLOOR_DROPOFF_KINDS as readonly string[]).includes(value as string);
}

export interface FloorDropoffPhoto {
  /** The R2 object key minted by `/api/photos/dropoff-upload-url`. */
  storageKey: string;
  contentType: string;
  byteSize: number | null;
}

export interface CreateFloorDropoffArgs {
  /**
   * REQUIRED, and the caller's own transaction. Same contract as
   * `withIdempotency`: the idempotency claim and this insert must commit or roll
   * back together, or a retry is answered with a stored success for a row that
   * was never written.
   */
  tx: Prisma.TransactionClient;
  siteId: string;
  /** Pacific day, `YYYY-MM-DD`. The caller has already pinned it to today. */
  dropoffDate: string;
  kind: FloorDropoffKind;
  units: number;
  /** REQUIRED. There is no overload without it — see `assertPhoto`. */
  photo: FloorDropoffPhoto;
  /** The submitting operator's session id. Never a name anyone typed. */
  actorUserId: string;
}

/**
 * The photo gate, server-side.
 *
 * The client blocks the submit button until a photo is attached and the zod
 * schema on the route requires the key — but both of those live on the far side
 * of the network from the row. This is the one that is still standing when a
 * hand-rolled POST arrives, and it is what the `dropoff.photo-required` test
 * strips the client check to reach.
 *
 * Below it, `consumer_dropoffs_floor_requires_photo` refuses the INSERT outright.
 * This check exists so the refusal is a 422 with a reason rather than a
 * constraint violation with a stack trace.
 */
function assertPhoto(photo: FloorDropoffPhoto | undefined | null): asserts photo is FloorDropoffPhoto {
  if (!photo || typeof photo.storageKey !== 'string' || photo.storageKey.trim() === '') {
    throw new RecordValidationError('a photo is required for every drop-off');
  }
}

export interface FloorDropoffResult {
  id: string;
  dropoffDate: string;
  kind: FloorDropoffKind;
  units: number;
}

/**
 * Record one walk-up drop-off: a day, a label, a unit count, and a photo.
 *
 * Returns a deliberately thin view. The response body is stored verbatim by
 * `withIdempotency` and replayed to a retry, so it holds only what the iPad
 * renders — no money fields to echo back, and nothing a later reader could
 * mistake for a payout record.
 */
export async function createFloorDropoff(args: CreateFloorDropoffArgs): Promise<FloorDropoffResult> {
  assertWholeUnits(args.units);
  assertPhoto(args.photo);
  if (!isFloorDropoffKind(args.kind)) {
    throw new RecordValidationError(`unsupported floor drop-off kind: ${String(args.kind)}`);
  }

  // `dropoff_date` is `@db.Date`. UTC-midnight of the Pacific day key is how
  // every other day-addressed floor write keys its row (`inboundConfirm`,
  // `processedConfirm`), and it is what `running-balance`'s `dateWindow`
  // compares against. Not `new Date()` — the day came from the request and has
  // already been pinned; deriving it here would silently re-file a replayed
  // entry against today, which is the one thing ADR-0078's day pin exists to
  // prevent.
  const day = new Date(`${args.dropoffDate}T00:00:00Z`);

  // ADR-0120 — serialise against workbook promotion at this site. Taken on the
  // CALLER's transaction (this function requires one), so the hold ends with the
  // idempotency claim and the insert it guards.
  await lockSiteAgainstPromotion(args.tx, args.siteId);

  const created = await args.tx.consumerDropoff.create({
    data: {
      site_id: args.siteId,
      dropoff_date: day,
      kind: args.kind,
      units: args.units,

      // ── The nulls, written out rather than omitted ────────────────────────
      // Prisma would default every one of these to null if the key were simply
      // absent, and that is exactly why they are here: an omitted field reads as
      // an oversight to the next person, and the next person's instinct on an
      // "oversight" in a money column is to fill it in. Stated, they read as the
      // decision they are. Bill, 2026-08-07: no money and no PII on this flow,
      // including for Incentive — its $3 is tracked elsewhere, deliberately.
      person_name: null, // CIP PII — not collected at the door
      consumer_name: null, // CIP PII
      incentive_cents: null, // no rule resolved, no payout computed
      incentive_amount_cents: null, // NOT units × 300¢ — see service.ts
      check_number: null,
      paid_at: null,
      slip_number: null,
      retrac_id: null,

      photo_storage_key: args.photo.storageKey,
      photo_content_type: args.photo.contentType,
      photo_byte_size: args.photo.byteSize,
      photo_uploaded_by: args.actorUserId,
      photo_captured_at: new Date(),

      source: 'manual',
      created_by: args.actorUserId,
    },
    select: { id: true },
  });

  await args.tx.auditLog.create({
    data: {
      actor_user_id: args.actorUserId,
      action: 'insert',
      table_name: TABLE,
      row_id: created.id,
      // No name and no cents to record, because none were written. The photo key
      // is recorded so the evidence for a given row can be found later without
      // reading the row itself.
      after: {
        dropoff_date: args.dropoffDate,
        kind: args.kind,
        units: args.units,
        photo_storage_key: args.photo.storageKey,
        source_surface: 'ipad_dropoff',
      },
    },
  });

  return {
    id: created.id,
    dropoffDate: args.dropoffDate,
    kind: args.kind,
    units: args.units,
  };
}
