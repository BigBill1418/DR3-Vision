import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// ADR-0078 Amendment 1 — the photo gate is SITE-scoped, not OWNER-scoped.
//
// Bill, 2026-08-07, mid-drain: *"we need to drain all users regardless of who is
// signed in... let's just not have this have to be a issue in the future."*
//
// ## What changed, stated plainly
//
// This guard used to require `load.assigned_operator_id === session.user.id`.
// It now requires only that the signed-in operator's site matches the load's
// site. **That is a real loosening of an authorization control** and it is
// recorded as such rather than described as a refactor.
//
// The trade, both directions:
//
//   - GIVEN UP: an operator at a site can now attach a photo to any load at
//     that site, not only the one assigned to them.
//   - GAINED: the evidence actually survives. Photo blobs live in ONE iPad's
//     IndexedDB and nowhere else. Under the owner check, a photo queued by
//     operator A could not drain while operator B was signed in — it parked as
//     a conflict forever, and if that device were wiped, reset or replaced the
//     evidence was gone permanently. On a shared floor iPad that is not an edge
//     case; it is the normal end of a shift.
//   - ALSO GAINED: attribution went from NOTHING to recorded. `load_photos`
//     previously had no uploader column at all, so under the strict gate we
//     enforced who could upload and then kept no record of who did. Every
//     confirm now writes `uploaded_by`, and a cross-operator upload writes an
//     audit row.
//
// The residual risk is an authenticated operator, PIN'd in at the same site,
// attaching a photo to a colleague's load — which on a warehouse floor is
// frequently the legitimate case (a second operator helping unload). It is now
// attributable, which it was not before.
//
// ## What did NOT change — do not "restore" it
//
//   - Cross-SITE is still refused. Eugene and Woodland are separate MRC
//     contracts in separate jurisdictions (CLAUDE.md hard rule #2); a
//     cross-site photo is a compliance problem, not a convenience one. Pinned
//     by `photo.cross-site-still-refused`.
//   - Non-operators are still refused.
//   - A load that does not exist is still a 404.
//
// The function was RENAMED along with the behaviour on purpose. Left as
// `requireOperatorOwnsLoad`, the next reader would reasonably conclude the
// missing ownership check was an accident and put it back — reintroducing the
// stuck-queue defect this amendment exists to remove.

export interface LoadSiteAccess {
  loadId: string;
  siteId: string;
  /**
   * The operator performing THIS request — from the session, always. This is
   * the identity to attribute the upload to and to pin an idempotency replay
   * against.
   */
  actorUserId: string;
  /**
   * The operator the load is assigned to, or null if unassigned. Recorded so a
   * caller can tell a cross-operator upload from a self-upload.
   *
   * NEVER conflate this with `actorUserId`. Stamping the load owner as the
   * uploader would write a claim that a person did something they did not do —
   * the same false-claim class ADR-0077 introduced `SystemActorContext` to
   * avoid, and one that an append-only audit table can never take back
   * (CLAUDE.md hard rule #6).
   */
  loadOwnerUserId: string | null;
}

/**
 * Require a signed-in OPERATOR whose site matches the load's site.
 *
 * Returns the load + both identities on success; throws a `Response` on failure
 * so the route handler can return it directly.
 */
export async function requireOperatorAtLoadSite(loadId: string): Promise<LoadSiteAccess> {
  const session = await auth();
  if (!session?.user || session.user.role !== 'operator') {
    throw new Response('forbidden', { status: 403 });
  }
  const load = await prisma.inboundLoad.findUnique({
    where: { id: loadId },
    select: { id: true, site_id: true, assigned_operator_id: true },
  });
  if (!load) throw new Response('load not found', { status: 404 });
  // The site check. Load-bearing, and deliberately the ONLY authorization check
  // left here — see the header.
  if (session.user.primary_site_id !== load.site_id) {
    throw new Response('forbidden', { status: 403 });
  }
  return {
    loadId: load.id,
    siteId: load.site_id,
    actorUserId: session.user.id,
    loadOwnerUserId: load.assigned_operator_id,
  };
}
