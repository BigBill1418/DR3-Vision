import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isValidLoadPhotoStorageKey } from '@/lib/r2';
import {
  PHOTO_GRANT_HEADER,
  grantFingerprint,
  verifyPhotoGrant,
  type PhotoGrantPayload,
} from '@/lib/photo-grant';
import type { PhotoKind } from '@prisma/client';

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
  // NO IDENTITY ⇒ 401, and the split from the role check below is the whole
  // point (2026-08-10). These were one predicate answering 403 for both.
  //
  // `!session?.user` cannot see an expired session. Auth.js answers idle expiry
  // — five minutes for an operator — and the ADR-0053 D2 kill-switch with an
  // EMPTY token rather than a null one, and `@auth/core` builds a session from
  // any non-null token. What arrives here is a HUSK: `session.user` is a truthy
  // object carrying no `id` and no `role`. So the old check fell through to
  // `undefined !== 'operator'` and called an unauthenticated request FORBIDDEN.
  //
  // That is not a wording quibble. `offline-queue.ts`'s `isAuthResponse`
  // classifies 401 as `auth:` — the state the floor chrome renders as "sign in
  // and this will send" — and deliberately excludes 403, which is
  // authenticated-but-refused and parks as a conflict no sign-in can clear. On
  // 2026-08-10 Woodland's first load rejection sat behind a camera sheet longer
  // than the idle window; the mint that followed the shutter answered 403 and
  // the iPad offered a retry that could never work, while the evidence was
  // never queued.
  //
  // `!session?.user?.id` is the predicate the other fourteen identity guards in
  // this codebase already use (`requireOperatorForSite` in `auth-helpers.ts`
  // and its siblings). This one was the outlier; it is no longer.
  if (!session?.user?.id) {
    throw new Response('unauthenticated', { status: 401 });
  }
  // A REAL signed-in person who is not an operator stays 403. Widening this to
  // 401 would invite the client to offer a sign-in that changes nothing.
  if (session.user.role !== 'operator') {
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

// ── ADR-0086 — the SECOND entry point: session OR capture-time grant ─────────
//
// `LoadSiteAccess` above already carries exactly the fields a grant supplies, so
// the shape does not change — only how the identity is established. Everything
// downstream (the `uploaded_by` stamp, the cross-operator audit row, the
// idempotency actor pin) reads the same struct and does not need to know which
// credential produced it.
//
// ## The order, and why it is grant-FIRST
//
// A valid grant is the NARROWER credential: it authorises one photo, of one
// kind, to one load, under one already-claimed idempotency key, and it names the
// operator who actually took the picture. A session authorises every photo at a
// whole site under whoever happens to be signed in when the queue drains.
//
// Preferring the grant therefore does two things. It makes attribution
// capture-time-accurate (D8 — the point that runs OPPOSITE to the usual
// direction for a bearer credential), and it means this path is exercised by
// ordinary drains rather than only during the emergency it was built for. Code
// that runs only in an emergency is code you find out is broken during one.
//
// ## What happens when a grant is presented and REFUSED
//
// It falls through to the session. This is load-bearing: a device whose grant
// expired but whose operator is signed in must drain exactly as it does today.
// A design where presenting a stale grant made a working upload fail would be
// strictly worse than not having the feature.
//
// Only when BOTH fail does the request get refused — and then with **401**, not
// 403, carrying the grant's reason. 401 is the honest answer (a sign-in genuinely
// fixes it) and it keeps the ADR-0078 G7/G8c recovery affordance working: the
// client's `isAuthResponse` classifies it as `auth:`, the chrome says "sign in
// and everything drains", and one PIN entry resolves it. The `grant` field in
// the body is what makes the refusal DISTINCT per §6.5 — the client maps it to
// its own `auth:grant_refused` state rather than folding it into a generic
// retry, which is precisely the conflation that let 97 photos accumulate
// invisibly behind the CORS 403.

/** How the identity on a `LoadSiteAccess` was established. */
export type PhotoAuthKind = 'session' | 'grant';

export interface LoadPhotoAccess extends LoadSiteAccess {
  via: PhotoAuthKind;
  /** Set iff `via === 'grant'`. The key the confirm's `Idempotency-Key` MUST equal. */
  grantIdempotencyKey: string | null;
}

export interface GrantRequestFacts {
  loadId: string;
  kind: PhotoKind;
  /** Present on `/confirm` only — `/upload-url` has not minted a key yet. */
  storageKey?: string;
  /** Injected in tests so expiry is driven by a real clock, not a stubbed branch. */
  nowMs?: number;
}

/**
 * Why a presented grant did not authorise THIS request.
 *
 * Every value names the field that failed, because a refusal that says only
 * "forbidden" cannot tell an operator staring at the conflicts screen whether
 * the load moved, the shift ended, or the account was closed.
 */
export type GrantRefusal =
  | 'grant_not_configured'
  | 'grant_malformed'
  | 'grant_unknown_key_version'
  | 'grant_bad_signature'
  | 'grant_expired'
  | 'grant_load_mismatch'
  | 'grant_kind_mismatch'
  | 'grant_load_not_found'
  | 'grant_site_mismatch'
  | 'grant_actor_unknown'
  | 'grant_actor_inactive'
  | 'grant_actor_not_operator'
  | 'grant_actor_site_mismatch'
  | 'grant_storage_key_prefix';

type GrantOutcome =
  | { ok: true; access: LoadPhotoAccess; payload: PhotoGrantPayload }
  | { ok: false; reason: GrantRefusal };

async function authorizeByGrant(token: string, facts: GrantRequestFacts): Promise<GrantOutcome> {
  const verified = verifyPhotoGrant(token, facts.nowMs);
  if (!verified.ok) return { ok: false, reason: verified.reason };
  const grant = verified.payload;

  // Field match. These two ARE the scope of the credential: a grant for load A
  // must not write to load B, and a `bol` grant must not post a `weight_ticket`.
  if (grant.load_id !== facts.loadId) return { ok: false, reason: 'grant_load_mismatch' };
  if (grant.kind !== facts.kind) return { ok: false, reason: 'grant_kind_mismatch' };

  const load = await prisma.inboundLoad.findUnique({
    where: { id: facts.loadId },
    select: { id: true, site_id: true, assigned_operator_id: true },
  });
  if (!load) return { ok: false, reason: 'grant_load_not_found' };

  // D3 — the LIVE load's site is the authorization fact; the grant's `site_id`
  // is only compared against it. A grant is a 14-day claim and a load's site is
  // mutable state, so trusting a fortnight-old assertion about where a load
  // lives is the same class of error as trusting a snapshot count that has since
  // been superseded. If they diverge, refuse — do not guess which is right.
  if (grant.site_id !== load.site_id) return { ok: false, reason: 'grant_site_mismatch' };

  // D5(a) — REVOCATION, and it is a hard requirement rather than a nice-to-have.
  //
  // A grant is a bearer token verified by signature, and signature verification
  // does not consult the `users` table. Without this read, "revoke this person's
  // access" stops being true for up to fourteen days — and that is a claim the
  // compliance surface makes. Kelsey Ruhland's availability ended 2026-08-08; a
  // grant she minted on 08-07 would otherwise still authorise a write on 08-21,
  // attributed to her, after her account was deactivated.
  //
  // One indexed primary-key read on the drain path. Negligible, and it restores
  // the revocation property that sessions have and bearer tokens do not.
  const actor = await prisma.user.findUnique({
    where: { id: grant.actor_user_id },
    select: { id: true, is_active: true, deleted_at: true, role: true, primary_site_id: true },
  });
  if (!actor) return { ok: false, reason: 'grant_actor_unknown' };
  if (!actor.is_active || actor.deleted_at !== null) {
    return { ok: false, reason: 'grant_actor_inactive' };
  }
  if (actor.role !== 'operator') return { ok: false, reason: 'grant_actor_not_operator' };
  // "…or is no longer an operator AT THE LOAD'S SITE" (D5a). This is the same
  // predicate the session guard applies, so a grant is never wider than the
  // session that minted it.
  if (actor.primary_site_id !== load.site_id) {
    return { ok: false, reason: 'grant_actor_site_mismatch' };
  }

  // D3 — object identity, constrained structurally. Only `/confirm` names a key.
  if (facts.storageKey !== undefined) {
    if (!isValidLoadPhotoStorageKey(facts.storageKey, grant.load_id, grant.kind)) {
      return { ok: false, reason: 'grant_storage_key_prefix' };
    }
  }

  return {
    ok: true,
    payload: grant,
    access: {
      loadId: load.id,
      siteId: load.site_id,
      // D8 — the CAPTURE-TIME operator, i.e. the person who actually took the
      // photo, rather than whoever happened to be signed in when the queue
      // drained. This change makes attribution MORE truthful, not less.
      actorUserId: grant.actor_user_id,
      loadOwnerUserId: load.assigned_operator_id,
      via: 'grant',
      grantIdempotencyKey: grant.idempotency_key,
    },
  };
}

/**
 * Require a signed-in operator at the load's site **or** a valid capture-time
 * grant for exactly this load and kind.
 *
 * Throws a `Response` on failure so the route handler can return it directly —
 * same contract as `requireOperatorAtLoadSite`, which this wraps rather than
 * replaces. Both photo routes call THIS one, and they must keep doing so
 * together: a relaxed mint with a strict confirm PUTs bytes to R2 and then
 * refuses to write the row, which is strictly worse than today — orphaned
 * objects, no record, and a queue row that still cannot drain.
 */
export async function requireOperatorOrGrantAtLoadSite(
  req: Request,
  facts: GrantRequestFacts,
): Promise<LoadPhotoAccess> {
  const token = req.headers.get(PHOTO_GRANT_HEADER);
  let refusal: GrantRefusal | null = null;

  if (token) {
    const outcome = await authorizeByGrant(token, facts);
    if (outcome.ok) return outcome.access;
    refusal = outcome.reason;
  }

  try {
    const session = await requireOperatorAtLoadSite(facts.loadId);
    return { ...session, via: 'session', grantIdempotencyKey: null };
  } catch (e) {
    // A grant was presented and refused, and there is no session to fall back
    // on. Answer 401 with the REASON so the device can park the row in its own
    // distinct, visible state — never a generic retry (§6.5). 401 rather than
    // 403 because a sign-in genuinely resolves it: the session path takes over
    // and the photo drains.
    //
    // The token itself never appears in the body or the logs (§6.3) — Sentry is
    // wired here, and a handler that echoed the offending header would publish
    // live credentials to an external service. The fingerprint is a salted
    // truncated digest and is not a credential.
    if (refusal !== null) {
      throw new Response(
        JSON.stringify({
          error: 'unauthenticated',
          grant: refusal,
          grant_fp: grantFingerprint(token!),
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
    }
    throw e;
  }
}
