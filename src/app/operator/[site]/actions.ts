'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { auth, signOut } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import * as svc from '@/lib/load-service';
import { takeOverLoad, readClaimHolder, type TakeoverActionResult } from '@/lib/loads/load-claim';
import { assertUiSurfaceActivated } from '@/lib/loads/record-guards';
import { UI_SURFACE } from '@/lib/notify/rollout';
import type { CountMode, ConcernCategory, LoadVoidReason, RejectionCategory } from '@prisma/client';

// Server-action wrappers for the operator workflow. Every action
// re-derives operator + site from the active session (no client-trusted
// site or operator ids) and then dispatches to `load-service` which
// owns the state-machine guards.
//
// ADR-0065 — `ctx()` also enforces the per-site `ipad_queue` rollout gate. Before
// this, the dock workflow was the ONE floor write path with no rollout gate at
// all: hiding the queue card only hid the link, so a bookmarked
// /operator/<site>/load/<id> could still drive these actions. They write
// `inbound_loads`, which feeds `onHand` and billing — gating the page without
// gating the action would have been a money-safety hole, not a cosmetic one.

// ADR-0078 D11 — these were bare `Error`s. A server action's throw reaches the
// client as an opaque digest, and anything that goes through `loadsErrorResponse`
// hit its 500 branch, so "your session ended" and "the database is down" were
// indistinguishable to both the operator and the logs. `LoadAccessError` carries
// the real status and a stable reason code.
async function ctx(siteCode: string) {
  const session = await auth();
  // Split 2026-08-10, same reasoning as `load-photo-guard.ts`. The 401 was
  // already the right answer for the case that actually happens on the floor —
  // an expired session, which arrives as a HUSK whose `user` is truthy and
  // whose `role` is undefined (`src/lib/session-husk.test.ts`) — but the single
  // predicate reached it by accident, via the role comparison, and gave the
  // same 401 to a signed-in NON-operator, for whom signing in again changes
  // nothing. Read the id for identity; read the role for authorization.
  if (!session?.user?.id) {
    throw new svc.LoadAccessError(401, 'not_authenticated_as_operator');
  }
  if (session.user.role !== 'operator') {
    throw new svc.LoadAccessError(403, 'not_an_operator');
  }
  const site = await prisma.site.findUnique({
    where: { code: siteCode },
    select: { id: true, code: true },
  });
  if (!site) throw new svc.LoadAccessError(404, 'unknown_site');
  if (session.user.primary_site_id !== site.id) {
    throw new svc.LoadAccessError(403, 'operator_not_assigned_to_site');
  }
  // Fail-closed: unregistered / `pilot` / read-error ⇒ not activated.
  await assertUiSurfaceActivated('operator', UI_SURFACE.IPAD_QUEUE, site.id);
  return { operatorUserId: session.user.id, siteId: site.id, siteCode };
}

/**
 * ADR-0127 — check in the truck on the card the operator confirmed.
 *
 * `acknowledgedHaulId` is the haul number the card RENDERED and the operator
 * read back on the confirm step. It is not an authorization token and is not
 * trusted as one: it is compared against `expected_loads.external_mymrc_haul_id`
 * inside the same transaction that writes, and a mismatch is a 409. The
 * operator, the site and the load id all still come from the session via `ctx()`.
 */
export async function startLoadAction(
  siteCode: string,
  expectedLoadId: string,
  acknowledgedHaulId: string,
): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  // ADR-0082 — `claimed` is deliberately NOT branched on here. Whether this call
  // made the claim or lost the race to a colleague, the destination is the same
  // load page; that page renders the workflow when you hold it and the held-by
  // panel when you do not. Branching in the action would mean two places that
  // have to agree about who holds a load, and the one that got it wrong before
  // was the one that redirected without saying anything.
  const load = await svc.startInboundLoad({
    expectedLoadId,
    siteId,
    operatorUserId,
    acknowledgedHaulId,
  });
  revalidatePath(`/operator/${siteCode}/queue`);
  redirect(`/operator/${siteCode}/load/${load.id}`);
}

/**
 * ADR-0096 — check in a truck whose slot is scheduled for a DIFFERENT Pacific day.
 *
 * The 2026-08-11 incident: H-136980 (Speedy Delivery, Union City) was booked for
 * 8/10 09:00 PT, nobody checked it in, and the truck turned up on the 11th. Both
 * check-in surfaces are day-bounded (ADR-0074 D5), so the card rendered
 * read-only with no control and tapping it did nothing. Bill: *"We are clicking
 * it and it does nothing."*
 *
 * ## Why this is a separate action rather than a wider `startLoadAction`
 *
 * The day bound is not incidental — it is what stops a child load being minted
 * onto the wrong slot, and removing it re-arms the 159-unit mis-booking of
 * ADR-0074 Am.1. So the ordinary path keeps its exact meaning and this one is
 * the explicit, noisier exception: the operator confirms the slot's own
 * scheduled day, that day travels to the server, and `startInboundLoad` refuses
 * unless it matches the row. A stale page cannot produce the value, which is
 * what makes the acknowledgement evidence rather than a permission the UI
 * granted itself.
 *
 * `acknowledgedSlotDayISO` is NOT trusted as an authorization token — it is
 * compared against the row inside the same transaction that writes. The
 * operator, the site and the load id all still come from the session via
 * `ctx()`, exactly as the ordinary path.
 */
export async function startLoadReconciledAction(
  siteCode: string,
  expectedLoadId: string,
  acknowledgedSlotDayISO: string,
  acknowledgedHaulId: string,
): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  const load = await svc.startInboundLoad({
    expectedLoadId,
    siteId,
    operatorUserId,
    // ADR-0127 — this path already read the haul number back to the operator; it
    // now travels and is checked, exactly like the day. Two acknowledgements on
    // the noisier path, one on the ordinary one, and both are compared server-side.
    acknowledgedHaulId,
    reconcile: { acknowledgedSlotDayISO },
  });
  revalidatePath(`/operator/${siteCode}/queue`);
  revalidatePath(`/operator/${siteCode}/hauls`);
  redirect(`/operator/${siteCode}/load/${load.id}`);
}

/**
 * ADR-0082 — take over a still-open dock load held by another operator.
 *
 * ONLINE-ONLY, and that is a decision rather than an omission (ADR-0082 D5): this
 * write is NOT registered in `FLOOR_SCOPES` and is never enqueued to the offline
 * queue. A takeover is a CONTENTION action — its entire meaning is "I am at this
 * load now and the other person is not" — so replaying one minutes or hours later
 * would resolve a contest that has already been settled, against a load whose
 * state has moved on. It also captures no operator data: refusing it offline
 * loses nothing but a tap, whereas refusing a count loses a count. The idempotency
 * key still rides along, because a double-tap on a live connection is real.
 */
export async function takeOverLoadAction(
  idempotencyKey: string,
  siteCode: string,
  loadId: string,
): Promise<TakeoverActionResult> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  const h = await headers();
  const result = await takeOverLoad({
    loadId,
    operatorUserId,
    siteId,
    idempotencyKey,
    // Recorded on the audit row. `admin-equipment.ts` carries the same pair for
    // the same reason: a claim change is a security-relevant event, and
    // `load-service.ts` has historically dropped both.
    ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: h.get('user-agent'),
  });
  revalidatePath(`/operator/${siteCode}/queue`);
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);

  // Flattened to (outcome, holderName) because that is exactly what the panel
  // renders. The union's two holder fields mean different people — the operator
  // it came FROM on success, the operator who has it now on a loss — and the
  // copy differs accordingly, so they are collapsed here rather than in the UI.
  switch (result.outcome) {
    case 'taken':
      return { outcome: 'taken', holderName: result.previousHolder?.name ?? null };
    case 'claim_moved':
    case 'not_open':
      return { outcome: result.outcome, holderName: result.currentHolder?.name ?? null };
    default:
      return { outcome: result.outcome, holderName: null };
  }
}

/**
 * ADR-0082 — "is this load still mine?", asked by the client after a stage write
 * failed for a reason it cannot read.
 *
 * `mine` is the only field the caller acts on; `holderName` is there so the
 * refreshed page has a name to show without a second round trip. Deliberately
 * NOT a bare `string | null`: an UNASSIGNED load and a load you still hold both
 * have no other holder to name, and collapsing them would tell the operator
 * their claim is intact when the row says nobody holds it.
 *
 * Read-only and session-scoped: the site comes from `ctx()`, so this cannot be
 * used to reach a load at another site. It reveals one operator's name to another
 * operator at the same site, who can already read that name off the queue.
 */
export async function claimStatusAction(
  siteCode: string,
  loadId: string,
): Promise<{ mine: boolean; holderName: string | null }> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  const holder = await readClaimHolder({ loadId, siteId });
  return { mine: holder?.userId === operatorUserId, holderName: holder?.name ?? null };
}

export async function bolCapturedAction(siteCode: string, loadId: string): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.recordBolCapture({ loadId, operatorUserId, siteId });
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
}

export async function weightSkipAction(siteCode: string, loadId: string): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.recordWeightSkip({ loadId, operatorUserId, siteId });
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
}

export async function weightCapturedAction(
  siteCode: string,
  loadId: string,
  weightLbs: number,
): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.recordWeightCapture({ loadId, operatorUserId, siteId, weightLbs });
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
}

export async function doorOpenCapturedAction(siteCode: string, loadId: string): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.recordDoorOpenCapture({ loadId, operatorUserId, siteId });
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
}

export async function beginUnloadAction(siteCode: string, loadId: string): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.beginUnload({ loadId, operatorUserId, siteId });
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
}

// ADR-0078 — the idempotency key leads. A server action cannot carry an HTTP
// header, so the key is the first ARGUMENT; putting it first makes a call site
// that forgot it a compile error rather than an argument silently shifted into
// the wrong slot.
export async function addStackAction(
  idempotencyKey: string,
  siteCode: string,
  loadId: string,
  stackIndex: number,
  unitCount: number,
  countMode: CountMode,
): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.addStack({
    loadId,
    operatorUserId,
    siteId,
    stackIndex,
    unitCount,
    countMode,
    idempotencyKey,
  });
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
}

export async function finishUnloadAction(
  idempotencyKey: string,
  siteCode: string,
  loadId: string,
  countMode: CountMode,
): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.finishUnload({ loadId, operatorUserId, siteId, countMode, idempotencyKey });
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
}

export async function addConcernAction(
  idempotencyKey: string,
  siteCode: string,
  loadId: string,
  category: ConcernCategory,
  note: string | null,
): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.addConcern({ loadId, operatorUserId, siteId, category, note, idempotencyKey });
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
}

export async function submitLoadAction(siteCode: string, loadId: string): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.submitLoad({ loadId, operatorUserId, siteId });
  await signOut({ redirect: false });
  revalidatePath(`/operator/${siteCode}/queue`);
  redirect(`/operator/${siteCode}`);
}

/**
 * ADR-0090 C — close a load that should never have been started.
 *
 * ONLINE-ONLY, and that is a decision rather than an omission — the same one
 * ADR-0082 D5 recorded for the takeover, for the same reason. A void is a
 * CONTENTION-shaped act ("this load is not real"), and replaying one hours later
 * would disown a load whose state has moved on — possibly one a colleague picked
 * up and legitimately worked in the meantime. It also captures no operator data:
 * refusing it offline costs a tap, whereas refusing a count loses a count. So it
 * is deliberately NOT in `FLOOR_SCOPES` and is never enqueued.
 *
 * Redirects to the QUEUE rather than signing out, which is where this differs
 * from `submitLoadAction` / `rejectLoadAction` and their ADR-0004 auto-logout.
 * Those end a piece of real work. A void is nearly always followed by "now tap
 * the RIGHT haul" — the freed slot is back on the queue this redirect lands on —
 * and forcing a PIN re-entry between the mistake and its correction is friction
 * with no safety value.
 */
export async function voidLoadAction(
  siteCode: string,
  loadId: string,
  reason: LoadVoidReason,
  note: string | null,
): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.voidLoad({ loadId, operatorUserId, siteId, reason, note });
  revalidatePath(`/operator/${siteCode}/queue`);
  // The hauls screen reads the same freed slot through `toConsumedLoad`.
  revalidatePath(`/operator/${siteCode}/hauls`);
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
  redirect(`/operator/${siteCode}/queue`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0090 Amendment 1 (B) — going back.
//
// JT, 2026-08-10: "if you want to go back to fix or check what you entered is
// correct, vision doesn't let you."
//
// All three are ONLINE-ONLY and none is registered in `FLOOR_SCOPES`, which is a
// decision rather than an omission — the same one ADR-0082 D5 recorded for the
// takeover and ADR-0090 D2.4 for the load void. A correction is a statement
// about the CURRENT state of a record ("that stack is wrong", "that weight is
// wrong"), and replaying one hours later would apply it to a state that has
// moved on. They also capture no operator data: refusing one offline costs a
// tap, whereas refusing a count loses a count.
//
// That leaves the reverse hazard — a write queued BEFORE the correction
// replaying after it — and the honest place to stop that is the offer.
// `review-panel.tsx` withholds all three while `pendingActionsForLoad` is
// non-zero, and says why.
//
// None of them redirects or signs out. The operator is mid-load and the whole
// point is to put them back where they were; `revalidatePath` re-renders the
// same url with the corrected server truth.
// ─────────────────────────────────────────────────────────────────────────────

/** Reopen a finished load to correct its count. The duration stays frozen. */
export async function reopenLoadAction(siteCode: string, loadId: string): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.reopenLoad({ loadId, operatorUserId, siteId });
  // The load leaves the "ready to submit" group on the queue's unfinished list.
  revalidatePath(`/operator/${siteCode}/queue`);
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
}

/** Take back a stack counted in error. Soft — the row survives, the total drops. */
export async function voidStackAction(
  siteCode: string,
  loadId: string,
  stackId: string,
): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.voidStack({ loadId, operatorUserId, siteId, stackId });
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
}

/** Overwrite a mis-entered weight. Appends an audit row; no status transition. */
export async function correctWeightAction(
  siteCode: string,
  loadId: string,
  weightLbs: number,
): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.correctWeight({ loadId, operatorUserId, siteId, weightLbs });
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
}

/**
 * Refuse the physical load. ADR-0113 made this reachable from `in_progress` and
 * `finished` as well as the inspection stage, so one action now serves both the
 * gate refusal and the mid-count one.
 *
 * ONLINE-ONLY, deliberately, on the same reasoning as the void (ADR-0090 D2.4):
 * not in `FLOOR_SCOPES`, never enqueued. A rejection is contention-shaped and
 * replaying one hours later would refuse a load whose state has moved on. The
 * reverse hazard — a stack queued BEFORE the rejection replaying after it — is
 * stopped at the OFFER, in `late-reject-panel.tsx`, the way `review-panel.tsx`
 * stops it for the ADR-0090 Am.1 corrections. `addStack` refuses anything but
 * `in_progress`, so a replay that slips through parks as a conflict for a person
 * rather than resurrecting units into a refused load.
 *
 * Keeps the ADR-0004 auto-logout, and that is the difference from the void. A
 * void is followed by "now tap the RIGHT haul", so signing out is friction
 * between a mistake and its correction. A rejection ENDS the work: the truck is
 * turned away and there is nothing to tap next.
 */
export async function rejectLoadAction(
  siteCode: string,
  loadId: string,
  category: RejectionCategory,
  note: string | null,
): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  await svc.rejectLoad({ loadId, operatorUserId, siteId, category, note });
  await signOut({ redirect: false });
  revalidatePath(`/operator/${siteCode}/queue`);
  // ADR-0113 D5 — the slot is RETAINED, not severed, so the hauls screen must
  // re-render to show the haul as refused rather than as still-open dock work.
  // The void revalidates this path to show a slot going FREE; the reject
  // revalidates it to show one going final. Missing it would leave the refused
  // truck rendering as live work until the cache expired.
  revalidatePath(`/operator/${siteCode}/hauls`);
  revalidatePath(`/operator/${siteCode}/load/${loadId}`);
  redirect(`/operator/${siteCode}`);
}
