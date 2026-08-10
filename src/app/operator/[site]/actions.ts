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
import type { CountMode, ConcernCategory, RejectionCategory } from '@prisma/client';

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

export async function startLoadAction(siteCode: string, expectedLoadId: string): Promise<void> {
  const { operatorUserId, siteId } = await ctx(siteCode);
  // ADR-0082 — `claimed` is deliberately NOT branched on here. Whether this call
  // made the claim or lost the race to a colleague, the destination is the same
  // load page; that page renders the workflow when you hold it and the held-by
  // panel when you do not. Branching in the action would mean two places that
  // have to agree about who holds a load, and the one that got it wrong before
  // was the one that redirected without saying anything.
  const load = await svc.startInboundLoad({ expectedLoadId, siteId, operatorUserId });
  revalidatePath(`/operator/${siteCode}/queue`);
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
  redirect(`/operator/${siteCode}`);
}
