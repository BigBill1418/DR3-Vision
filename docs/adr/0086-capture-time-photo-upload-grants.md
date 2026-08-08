# ADR-0086 — Capture-time photo upload grants (F-3)

**Date:** 2026-08-08
**Status:** **Proposed — NOT accepted, NOT implemented.** Decision-ready for Bill.
**Extends:** ADR-0005 (photo storage), ADR-0006 (offline queue), ADR-0078 + Amendment 1 (iPad reliability, site-scoped photo gate).
**Supersedes:** nothing. It does, however, **correct the design recorded in `docs/OPEN-ITEMS.md` §0.AJ "F-3"** — see §4, which is the reason this document is worth reading before anyone builds it.

> **Why the number is 0086 and not 0082.** The house rule is "take the next free number at draft time; numbers are never reserved". That rule assumes numbers are claimed by files on `main`. Right now four numbers — **0082, 0083, 0084, 0085** — are claimed by the in-flight #205 P2–P5 campaign and by nothing on `main`, so the next-free rule would hand this document a number another branch is already writing. This repo has been bitten twice already (`0067` exists twice, `0069` three times). 0086 sits above every in-flight claim. If 0084 is still unclaimed when this ADR is accepted, renumbering down is a rename, not a rewrite.

---

## 1. Context — the residual, stated exactly

ADR-0078 G7 fixed the auth failure that _looked_ like success, and G8c made recovery from a parked queue one tap. ADR-0078 Amendment 1 then loosened the photo gate from **load-owner** to **site**, so a photo queued by operator A drains under operator B's session as long as B is signed in at the same site.

What remains after all of that is narrow and real:

**A queued photo still needs a live, signed-in session at the same site in order to drain.** On iOS there is no closed-app execution to fall back on — no background sync, no service-worker wake. If the last operator of a shift signs out (or the session simply lapses) while photos are still in the device's IndexedDB, those photos sit there until somebody signs in again at that site on that same device. The bytes exist in exactly one place. A wipe, a reset, a replaced iPad, or a device that goes back in the drawer at the end of a season, and the evidence is gone permanently.

This is not hypothetical. The ADR-0078 build ran into the 99-photo-parked case live, and the only reason those photos survived is that somebody was still signed in when the CORS repair landed.

**The proposal:** authorize the upload at **capture time**, when a session provably exists, and carry that authorization with the photo so the drain does not need a session at all.

### 1.1 What is NOT the problem

Three things that look adjacent and are already solved — recorded so this ADR is not re-scoped into them:

- **Duplicate rows on replay.** Solved by ADR-0078 D3 (`withIdempotency`, claim in the write's transaction).
- **Cross-operator drain.** Solved by ADR-0078 Amendment 1 (site-scoped gate + `uploaded_by` attribution).
- **Invisible failure.** Solved by ADR-0078 D9/G8c (`blocked:` / `uploads-blocked` state, "Retry all").

F-3 is the remaining case where **there is no session at all**, which none of the above addresses.

---

## 2. The current auth path, read from the code (2026-08-08)

Both photo routes call the same guard, and that symmetry is load-bearing:

| Route                     | File                                    | Guard                                                                                |
| ------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------ |
| `POST /api/photos/upload-url` | `src/app/api/photos/upload-url/route.ts` | `requireOperatorAtLoadSite(load_id)` |
| `POST /api/photos/confirm`    | `src/app/api/photos/confirm/route.ts`    | `requireOperatorAtLoadSite(load_id)` |

`requireOperatorAtLoadSite` (`src/lib/load-photo-guard.ts`) requires, in order: a session; `role === 'operator'`; the load exists; and `session.user.primary_site_id === load.site_id`. It returns `actorUserId` (the session principal) and `loadOwnerUserId` (the load's assignee) as **separate** fields, and the confirm route stamps `uploaded_by = actorUserId` — never the load owner.

The mint call site carries an explicit instruction that constrains any change here:

> _"Mint and confirm must move together: a relaxed mint with a strict confirm PUTs bytes to R2 and then refuses to write the row, which is strictly worse than today — orphaned objects, no record, and a queue row that still cannot drain."_

**Any grant design that authorizes one route and not the other is refused on that basis alone.**

---

## 3. The drain path, read from the code — and the fact that breaks the recorded design

`replayUpload` (`src/lib/offline-queue.ts:721`):

```
const PRESIGN_TTL_MS = 8 * 60 * 1000;
const stale = !upload_url || Date.now() - row.queued_at > PRESIGN_TTL_MS;
if (!storage_key || stale) {  … POST /api/photos/upload-url …  }
```

And `mintUploadUrl` (`src/lib/r2.ts`):

```
const storage_key = `loads/${args.loadId}/${args.kind}/${randomUUID()}.${ext}`;
const upload_url  = await getSignedUrl(getClient(), cmd, { expiresIn: 600 });
```

Three consequences, all measured rather than assumed:

1. **The presigned R2 PUT lives 600 seconds.** The client treats it as stale at 480. Any photo queued longer than eight minutes — which is every photo F-3 exists for — **must** re-mint.
2. **Re-minting produces a brand-new `storage_key`**, because the key embeds a fresh `randomUUID()`.
3. Therefore the drain of an offline photo **always** transits `POST /api/photos/upload-url`, the session-gated route. `retryRow` reinforces this: it deliberately nulls `storage_key` and `upload_url` so a human pressing "try again" gets a fresh mint (`offline-queue.ts:578-586`, with a comment explaining that resetting `queued_at` alone would make a weeks-old presign look fresh and 403 the whole drain).

---

## 4. The recorded F-3 design does not work. Correcting it is the main content of this ADR.

`docs/OPEN-ITEMS.md` §0.AJ records the design "in full so it does not have to be re-derived":

> `/api/photos/upload-url` additionally returns `upload_grant`, an HMAC-signed token over `{v, load_id, kind, storage_key, actor_user_id, site_id, idempotency_key, exp ≈ 14d}`. Both photo routes accept **a session OR** an `X-Upload-Grant` whose signature validates and whose fields match the request **EXACTLY**.

Held against §3, that design is **circular and unbuildable as written**:

- The grant is signed over `storage_key`, and the fields must match the request **exactly**.
- But the drain re-mints, so the request at drain time carries a **different** `storage_key` than the one signed at capture.
- The grant therefore fails its own field-match check on every photo older than eight minutes — i.e. on 100% of the population it exists to serve.
- And the re-mint itself is a call to the session-gated route, so even a grant that _did_ validate on `/confirm` never gets the chance: the drain dies one step earlier.

This is not a detail to be patched during implementation. It changes what the token is: **the grant cannot be a claim about one R2 object, because the R2 object is not stable across the queue's lifetime.** It has to be a claim about *the right to attach one photo of one kind to one load*, with the object identity constrained structurally rather than by equality.

The recorded design is not wrong out of carelessness — it was written from the ADR-0078 confirm-route comment, which correctly notes that `storage_key` legitimately changes between an attempt and its replay. The same fact that makes `storage_key` excluded from the idempotency request hash makes it unusable in the grant payload, and that connection was not drawn at the time.

---

## 5. Proposed decision

### D1 — The grant binds the load, not the object

`PHOTO_UPLOAD_GRANT` payload, v1:

| Field            | Purpose                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------- |
| `v`              | Key/format version. Selects the verification key — see D6.                              |
| `load_id`        | The one load this grant can write to.                                                    |
| `kind`           | One of the five `PHOTO_KINDS`. A `bol` grant cannot post a `weight_ticket`.              |
| `actor_user_id`  | The capture-time operator. Becomes `uploaded_by`.                                        |
| `site_id`        | The load's site **as read at mint time**. Advisory only — see D3.                        |
| `idempotency_key`| The client-minted ULID this photo already carries. Single-use by construction.           |
| `exp`            | Unix seconds. 14 days from mint (see D5 for why 14 and what it costs).                   |

**`storage_key` is deliberately NOT in the payload.** Its absence is the correction from §4 and must not be "fixed" by a later reader.

### D2 — The grant authorizes BOTH routes, and `/upload-url` re-issues

- `POST /api/photos/upload-url` accepts a session **or** a valid `X-Upload-Grant`. On grant-auth it mints a fresh `storage_key` + presign as usual, **and returns a fresh `upload_grant`** carrying the same `exp` as the presented one (never an extended one — see D5).
- `POST /api/photos/confirm` accepts a session **or** a valid `X-Upload-Grant`.

This satisfies the "mint and confirm must move together" constraint from §2 exactly: both loosen, in the same commit, by the same predicate.

### D3 — What the object key check becomes

`/confirm` under grant-auth additionally requires:

```
storage_key.startsWith(`loads/${grant.load_id}/${grant.kind}/`)
```

That is the structural replacement for the impossible equality check. It cannot be spoofed into another load's prefix, and it does not care which UUID the mint produced.

`site_id` in the grant is **not** trusted as the authorization fact. Under grant-auth the route re-reads the load and uses the **live** `load.site_id`, comparing it to the grant's for a mismatch signal only. Rationale: a grant is a 14-day claim, and a load's site is mutable state; trusting a fortnight-old assertion about where a load lives is the same class of error as trusting a snapshot count that has since been superseded. If they diverge, refuse and record — do not guess which is right.

### D4 — Route-handler-is-the-real-gate, not a middleware exemption

Neither photo path is added to `PUBLIC_PATHS` or given a `startsWith` exemption in `src/lib/public-paths.ts`. The middleware keeps 307ing session-less requests, and the routes are reached by the grant-bearing client because the client sends `redirect: 'manual'` and the route itself performs the grant check.

This is not stylistic. `public-paths.ts` carries **ten** `/api/internal/*` exemptions (bonus, survey, audit, billing, ap, reimbursements, board-pack, workbook-sync, inventory, doc-ingest), each with a comment recording the same shape: a session-less POST 307s to `/login`, `fetch` follows the redirect, a **200 carrying the login page HTML** comes back, and the caller logs success for work that never happened. ADR-0068 Amendment 5 records walking into it as recently as the reimbursement re-send, where the first live call returned HTTP 200 carrying the login page and sent nothing. Adding a public exemption to make grants work would put a bearer-authorized *write* on the far side of the exact mechanism that has produced ten documented instances of that trap.

If the middleware genuinely must be taught about the header, it should let through **only** requests that carry a syntactically well-formed `X-Upload-Grant`, and the route must still be the thing that verifies it.

### D5 — Expiry: 14 days, and the cost is stated

14 days covers a long weekend, a holiday shutdown, and an iPad that spends a week in a drawer, which is the population F-3 is for.

It also means: **a grant outlives the operator's employment.** Kelsey Ruhland's availability ended 2026-08-08. A grant she minted on 2026-08-07 would still authorize a write on 2026-08-21, attributed to her, after her account was deactivated — because a grant is a bearer token verified by signature, and signature verification does not consult the `users` table.

Two candidate mitigations, and the recommendation:

- **(a) Re-check the actor at redemption.** On grant-auth, load `actor_user_id` and refuse if the user is inactive or is no longer an operator at the load's site. Cheap (one indexed read), and it restores the revocation property that sessions have and bearer tokens do not.
- **(b) Shorten `exp` to 72 hours.** Simpler, but it silently deletes evidence in exactly the scenario the feature exists for, which is the failure direction this repo consistently refuses.

**Recommend (a), and (a) is a hard requirement rather than a nice-to-have.** Without it, "revoke this person's access" stops being true for up to fourteen days, and that is a claim the compliance surface makes.

Note that D2's re-issue must **carry the original `exp` forward**, never mint a new 14-day window. Otherwise a device that sweeps hourly refreshes its own credential indefinitely and the expiry means nothing.

### D6 — Key provisioning and rotation

`PHOTO_GRANT_SECRET` follows the established fleet convention: a mode-600 file under `~/.dr3-vision-secrets/` on CHAD-HQ (e.g. `photo-grant.env`), mounted into the app via the `env_file` list in `docker-compose.yml` alongside `r2.env`, `auth.env`, `m365.env`. Never in the repo, never in a commit message. Generate with `openssl rand -base64 48`.

**Rotation is the part that needs a decision, because rotation is destructive here.** A single-key implementation that swaps the secret invalidates every grant in every iPad's IndexedDB at once — which converts a routine credential rotation into the exact evidence-loss event this ADR exists to prevent, and does it silently, because the device just sees 403s it will classify as a conflict.

Therefore: **`v` selects the key**, the verifier accepts `v=N` and `v=N-1`, the minter only ever issues `v=N`, and `N-1` may be retired no sooner than `max(exp)` — 14 days — after the rotation. The runbook must say this in those words, and the retirement must be a calendared action rather than a "when someone remembers".

### D7 — Falsification tests, and what each must actually measure

The mock-measuring-itself failure has been caught six times on the current campaign. Each test below is specified by **the property it falsifies**, not by the assertion it makes:

| Test                      | Must prove                                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| forged signature          | A payload signed with a **different key** is refused. Must run the real verifier over real HMAC bytes — a stubbed `verify()` returning false proves nothing. |
| expired grant             | `exp` in the past is refused. Must drive a real clock/injected `now`, not a mocked verifier branch.                                                        |
| field substitution        | A validly-signed grant for load A is refused on a request for load B; likewise `kind`. Must re-sign a **mutated payload with the real key**, so it fails on field mismatch rather than on signature. |
| cross-load key prefix     | A grant for load A cannot confirm a `storage_key` under `loads/B/…`. Must exercise D3's real prefix check.                                                |
| replay                    | The **second** redemption of the same `idempotency_key` returns the stored response and creates no second `load_photos` row. Must run against a real Postgres (`*.db.test.ts`, per the ADR-0078 CI step) — the whole point is the `ON CONFLICT` behaviour, which no in-memory fake reproduces. |
| revoked actor             | D5(a): a grant whose `actor_user_id` is now inactive is refused. Must flip a real `users` row.                                                            |
| key rotation window       | A `v=N-1` grant verifies while `N-1` is live and is refused after retirement. Must exercise two real keys.                                                |
| middleware not weakened   | An unauthenticated request with **no** grant still 307s, and the route still refuses. Guards D4 against a later "simplification". |
| symmetry                  | `/upload-url` and `/confirm` accept and refuse **the same** grants. Guards §2's mint-and-confirm-move-together constraint structurally, rather than by two files agreeing by habit. |

### D8 — Attribution improves, and that is worth saying

Under a grant, `uploaded_by` becomes the **capture-time** operator, which is the person who actually took the photo. Under the current site-scoped session path it is whoever happened to be signed in when the queue drained. So this change makes attribution *more* truthful, not less — a point that runs opposite to the usual direction for a bearer credential and should be weighed in its favour.

---

## 6. Security analysis

### 6.1 What the credential is

A 14-day bearer token that authorizes exactly one write: one photo, of one declared kind, to one named load, under one already-claimed idempotency key. It cannot read anything. It cannot enumerate. It cannot write a count, a bonus entry, an inventory row, or money. `PHOTO_KINDS` is a five-value enum validated by zod before the grant is even consulted.

### 6.2 Replay

Bounded by the `idempotency_key` binding, which is the strongest control in the design. The second redemption hits `withIdempotency`, matches actor + scope + payload hash, and returns the **stored** response without re-running the write. A captured grant replayed by an attacker therefore produces no second row.

Residual: a replay by a **different** actor earns 409 `idempotency_key_reused`, which parks the row as a visible conflict — the safe direction, and the behaviour ADR-0078 already documents.

Bytes-to-R2 replay is separately bounded: the presign is 600 s, and the S3 `PutObjectCommand` pins `ContentType`, which `r2.ts` already constrains to the five-value image allowlist added by the 2026-07-16 UPLOAD audit.

### 6.3 Exfiltration

The grant is stored in IndexedDB next to the photo it authorizes. A stolen or cloned iPad yields, per grant, the ability to attach one image to one load at one site. It does **not** yield read access to any photo, to any other load, or to any other site — the prefix check (D3) and the load-scoped payload are both hard.

The larger exposure on a stolen iPad is the queued photo bytes themselves and any live session, neither of which this ADR changes.

**Transport:** grants only ever travel to the app's own origin over the Cloudflare tunnel (TLS). They must never be placed in a URL — header only — so they do not land in access logs, `Referer`, or browser history. The proposal already uses `X-Upload-Grant`; this is the reason.

**Logging:** the grant must be redacted in every log, Sentry breadcrumb and error body. Sentry is wired here (`sentry.client.config.ts` / `.server.config.ts`) and a 403 handler that echoes the offending header would publish live credentials to an external service.

### 6.4 Privilege comparison — is this a net loosening?

Honest answer: **yes, narrowly, and it is worth it.**

- **Given up:** a write that previously required a live, site-matched, role-checked session can now be made by a 14-day bearer string held on a device.
- **Gained:** evidence that currently dies on an iPad survives; attribution becomes capture-time-accurate (D8); and with D5(a) the revocation property is preserved rather than lost.
- **Not given up:** cross-site is still refused (via the live load read, D3). Non-operators are still refused. A nonexistent load is still 404. The kind allowlist, the content-type allowlist, and the idempotency claim are all unchanged.

This is a smaller loosening than ADR-0078 Amendment 1 was, and that one was accepted for the same reason: the alternative is losing the evidence entirely.

### 6.5 Failure modes that must not be silent

- **Secret missing at boot.** The app must refuse to mint grants and say so on the health surface, rather than minting unsigned or fixed-key tokens. A grant feature that silently degrades to "no grants" reproduces today's behaviour without telling anyone it did.
- **Verification failure.** Must be a distinct, visible client state (`blocked:` in the ADR-0078 taxonomy), never folded into the generic offline retry — that conflation is precisely what let 97 photos accumulate invisibly behind the CORS 403.

---

## 7. Alternatives considered

| Option                                                              | Why not                                                                                                                                                                    |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Do nothing** (status quo)                                          | The residual is real and its failure mode is permanent evidence loss. But it is genuinely rare post-Am.1, so "do nothing" is a defensible decision for Bill to take — it is the reason this ADR is Proposed rather than pre-approved. |
| **Longer-lived sessions on floor iPads**                             | Trades a narrow one-write credential for a broad all-routes one, on a shared device. Strictly worse.                                                                        |
| **A device-scoped service credential** (TitanForge ADR-0040 pattern) | Also a bearer credential, but scoped to a *device* rather than to *one write* — much wider blast radius, plus a provisioning/revocation surface that does not exist here.  |
| **Background sync / service-worker drain**                           | Not available on iOS. This is the constraint that creates F-3.                                                                                                              |
| **Upload directly to R2 with a long-lived presign, confirm later**   | Moves the credential to R2 with no idempotency binding and no server-side kind check, and orphans objects with no row. Worse on every axis.                                 |
| **Server-side pull from the device**                                 | There is no addressable path to an iPad's IndexedDB. Not a real option; recorded so it is not re-proposed.                                                                  |

---

## 8. Consequences

**If accepted:**

- One new secret to provision, plus a rotation runbook with a **calendared** N-1 retirement (D6). This is the largest ongoing operational cost.
- `load-photo-guard.ts` grows a second entry point; the guard's return type (`LoadSiteAccess`) already carries exactly the fields a grant would supply, so the shape does not change.
- The `uploaded_by` column starts carrying capture-time actors, which is a **semantic** change to an existing column's meaning. It should be noted in `COMPLIANCE.md` rather than discovered later by whoever audits attribution.
- The revocation re-check (D5a) puts one indexed user read on the drain path. Negligible.

**If rejected or deferred:**

- The residual stands and should be stated on the operator-facing surface, not just in this register: an iPad with queued photos **must** be signed in at its site before it goes back in the drawer. That is an operational instruction JT can act on today, at zero engineering cost, and it closes most of the real-world exposure.

**Either way:** §4 must not be lost. The recorded F-3 design in `docs/OPEN-ITEMS.md` is unbuildable, and a future session reading that register without this ADR would implement it, watch every grant fail its field match, and conclude the approach itself was wrong.

---

## 9. Open questions for Bill

1. **Is the residual worth a bearer credential at all?** Post-Amendment 1 the stuck case requires *nobody* to sign in at that site before the device is wiped or retired. How often is that real?
2. **Revocation (D5a) — confirm it is mandatory.** The recommendation is that it is. Accepting the ADR without it means "access revoked" is untrue for up to 14 days.
3. **14 days, or shorter?** 14 covers a holiday shutdown. 3 covers a weekend and cuts the exposure window by ~80%.
4. **Who owns the rotation calendar entry?** A rotation runbook nobody is scheduled to execute is a rotation that will happen once, in an emergency, on the day it destroys 40 queued photos.
