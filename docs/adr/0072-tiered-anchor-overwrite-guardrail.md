# ADR-0072 — iPad physical count go-live + tiered anchor-overwrite guardrail

**Status:** accepted, implemented (2026-07-31)
**Builds on:** ADR-0037 §3 (pool split), ADR-0060 (floor count surface), ADR-0065 (per-surface iPad rollout gates), ADR-0068 (the dual-approval CHECK pattern this borrows)

## Context

`ipad_count` was the last high-value floor surface still at `pilot`. Bill's
decision (2026-07-30): turn it on at **both** sites — he trusts the crew to
re-anchor — but not without friction proportional to the damage.

The damage is specific. A physical count becomes the inventory **anchor**, and
every downstream number is computed forward from it: the floor balance, the
loads/inventory screens, the COR filing. So a mistyped count does not produce a
wrong count. **It silently moves the entire floor.** Woodland's anchor is a
known-good 2,483 (1,597 program / 886 non-program, 2026-07-22); a fat-fingered
digit on an iPad would have replaced it with one tap and no trace beyond a
snapshot row nobody looks at.

Bill rejected a blanket authorisation gate — that would put a manager in the way
of Eugene's first count, which is the thing we most want to happen. He chose a
**tiered** guardrail, and tightened the large-swing threshold from a proposed 40%
to **20%**: on a 2,483 floor, 40% lets roughly 1,000 units through on a tap.

## Decision

### The tiers

| Tier  | When                         | What happens                                                                                                          |
| ----- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **0** | No existing anchor           | Writes straight through, zero friction. Every Eugene count today, and any site's first count.                         |
| **1** | Overwrite, swing ≤ threshold | One confirm screen: current-vs-new, and the change **in words**.                                                      |
| **2** | Overwrite, swing > threshold | **Held.** The operator cannot release it. A manager approves by PIN on the device, or remotely from their own screen. |

The swing is **relative** (`|new − prior| / prior`) and symmetric. An absolute
unit threshold would be paranoid at 3,000 and useless at 300, and a guardrail
that only watched decreases would miss a doubled floor — which over-reports units
to MRC rather than under-reporting them.

Exactly the threshold is Tier 1: the threshold is the largest swing an operator
may confirm alone.

### Enforced on the server, not in the dialog

`classifyAnchorWrite` runs on the **write path**, recomputed from live state on
every request. The client classifies the same count only to decide which screen
to show. A hand-crafted request that skips the confirm still meets the same
function on the server, and a Tier 2 write without an approval is refused with a
**422**. The UI is a courtesy; this is the control.

### A held count is held, not rejected

A Tier 2 count persists with its entered values until a manager releases it or
someone explicitly discards it. It never silently drops and never auto-writes. An
operator who counted 1,200 against a floor of 2,483 has either found a real
problem or fat-fingered a digit, and **both deserve a person, not a timeout**.
The 422 means "someone must look at this", not "try again".

### The rule that cannot be bent

**The operator who entered the count can never release it.** Enforced three
times: in `releaseHold`, in the route, and by a `CHECK` constraint
(`approved_by <> created_by`) — the ADR-0068 posture, because the rule that
matters most is the one a future code path cannot forget.

Two details that are easy to get wrong and are deliberately not:

- The self-release check runs **before** the PIN check, so a self-release attempt
  cannot be used as an oracle for whether a PIN is correct.
- The rule binds the **person, not the surface**. A manager who entered the count
  on the floor cannot release it from their desk either.

### The swing is recomputed at release

The hold stores the swing that caused it, but approval does not trust that
figure. The anchor may have moved between hold and release, and writing a stale
figure against a changed baseline is how a guardrail becomes theatre.

### Recovery, by appending

`site_inventory_snapshots` is append-only, so a bad overwrite is survivable.
`/admin/inventory/anchors` re-activates a prior anchor by writing a **new**
snapshot carrying its figures — never editing or deleting the bad row. Deleting
the mistake would leave a history that never contained it, and the next person
asking "why did the floor jump 1,200 units?" would find nothing. The chain reads:
good anchor, bad anchor, correction — with the audit row naming who decided and
which snapshot they restored from.

The screen also lists **pending holds**, which are otherwise invisible to anyone
but the operator standing at the iPad that produced them.

## The flip

`ipad_count` moved `pilot → live` at **both** sites in the migration, so it is
reproducible and reviewable rather than a hand-run UPDATE nobody can find later.
Verified before writing it: both sites were `pilot`, and `ipad_queue` /
`ipad_inbound` were already `live`.

**`ipad_processed` and `ipad_today_summary` are untouched** and remain `pilot`.
The UPDATE names `ipad_count` alone — this migration must not become the one that
quietly turned on three surfaces because they were adjacent in a table.

## Divergence from the handoff

The handoff asks to "keep `assertCurrentPacificDay()` on the count write". **That
function is not on this path and never was** — verified against `src/app/api/
operator/[site]/count/route.ts`. The count route accepts **no date input at
all**; it pins the anchor server-side to Pacific midnight of today
(`pacificMidnightInstantOfDayISO(pacificDayISO(new Date()))`). That is _stronger_
than asserting a client-supplied date, because there is no client-supplied date
to assert. Shipped code wins; the protection the handoff wanted is present in a
better form and unchanged by this ADR.

## Consequences

- Eugene can establish its first anchor with no friction (Tier 0).
- A Woodland re-count within 20% costs one extra tap.
- A large swing cannot be written by the floor alone, by any route.
- Every overwrite records prior anchor, swing, tier, approver and path.
- A bad count is recoverable to any prior anchor without erasing anything.
- **Cost, stated plainly:** a genuinely large real change — a site that actually
  did lose half its floor — now needs a manager. That is the intended trade, but
  it means a real emergency re-count at 6am waits for a person. The remote
  approval path exists so that wait is a phone call, not a drive.

## Verification

26 tests. Every guard **falsified before being kept** — broken on purpose,
observed red, restored:

| Break                                                  | Went red |
| ------------------------------------------------------ | -------- |
| `>=` instead of `>` (exactly-threshold becomes Tier 2) | ✅ 1     |
| only decreases guarded (a doubled floor walks through) | ✅ 1     |
| self-release allowed                                   | ✅ 3     |
| PIN checked before the self-release rule (PIN oracle)  | ✅ 1     |
| pending-status check dropped (double release)          | ✅ 2     |
| trust the stored swing instead of recomputing          | ✅ 1     |

Cases covered from the real numbers: Woodland 2,483 → 2,150 is Tier 1 (13%);
2,483 → 1,200 is Tier 2 (52%); a count of **0** against a real anchor is a 100%
swing and IS held; re-entering the identical figure is a zero swing and is Tier 1,
never held; a **zero prior anchor** is Tier 1 rather than an infinite swing, or a
site that once counted empty would hold every count forever.

## Amendment 1 — 2026-11-06: no held count could ever be approved

**What broke.** Measured live 2026-11-06: 4 Tier 2 holds pending at Woodland,
and **zero holds ever approved** at any site. Both release paths were dead:

1. **The iPad PIN path** is the only UI that approved anything. `releaseHold`
   (`path: 'pin'`) calls `verifyPin`, which refuses any user whose role is not
   `operator` and any user with no `pin_hash`. Approvers are managers and admins
   (`eligibleApprovers`), and 0 of 7 managers and 0 of 1 admin had a PIN. Every
   attempt answered 401 `bad_pin`.
2. **The iPad then mislabelled that refusal.** `classifyWriteRefusal` maps every
   401 to `signed_out`, and `approve()` called it before its own `bad_pin`
   branch, so the floor saw "session expired" and `err_bad_pin` was unreachable.
3. **The remote path had no screen.** `POST/DELETE /api/manager/<site>/count-holds/<id>`
   (manager session, no PIN, self-release refused, CAS-safe per ADR-0118) was
   built with this ADR, and §Consequences leaned on it ("the remote approval path
   exists so that wait is a phone call") — but nothing in `src` called it. The
   admin anchors page listed pending holds read-only.

**Why it went unseen.** The guardrail's tests proved the rules (self-release,
recompute, double release) at the service and route. No test asked whether any
real approver could reach either path, and a hold that is never approved fails
silently by design — it writes nothing.

**The fix.**

- **Manager screen `/dashboard/<site>/held-counts`** — lists the site's pending
  holds (on record then, counted, change and swing %, entered-by / counted-by /
  confirmed-by, entered time in Pacific) with **Approve** (one tap + confirm) and
  **Discard** (reason required), calling the existing manager routes. Gated by
  `checkManagerForSite`, the same guard as the route, with no rollout switch in
  front of the only working approval path. It shows the count on record now
  (release re-checks against it) and names every refusal the route can answer
  (`operator_cannot_self_release`, `not_a_manager`, `hold_not_found`, 409 not
  pending, 401 signed out). Linked from the site dashboard nav with the pending
  count, and from the admin anchors page.
- **Flags, not decisions** (`src/lib/inventory/held-count-review.ts`): a
  prominent warning when the swing is at least **twice the site's threshold**;
  and a "possible duplicate" mark when several pending holds share the same
  Pacific day and total, asking the manager to approve one and discard the rest.
- **iPad:** a 401 whose body is `bad_pin` is no longer treated as a dead
  session; a reason-free 401 still is. `err_bad_pin` and `hold_remote_note` now
  name the desktop "Held counts" page.
- **Found in passing — cross-site hold ids.** Both hold routes authorized the
  caller for the URL's site but never checked the hold belonged to it;
  `discardHold` checks status only, so a user of one site could discard another
  site's held count by id. `isHoldAtSite` now gates both routes (manager and
  operator) and a foreign hold answers 404 `hold_not_found`, like a missing one.

**Unchanged on purpose.** PIN and auth policy (`verifyPin` stays operator-only;
no manager was given a PIN), and the four-eyes rule: the person who entered a
count still cannot release it, on any path.

**Residual.** A pending hold still raises no alert; a manager learns of it from
the dashboard link count or the iPad operator. Whether managers should hold a
floor PIN is a policy question for Bill, not decided here.

**Verification.** Route test through the real `checkManagerForSite` (cross-site
release and discard both 404 and write nothing — falsified by removing the
check: 2 red). iPad regression: 401 `bad_pin` renders `err_bad_pin`, a
reason-free 401 still renders session-expired (falsified by restoring the old
order: 1 red). Screen, page-gate and flag tests alongside.

## Amendment 2 — 2026-11-06: managers approve on the iPad with their own floor PIN

**What broke.** Amendment 1 made held counts approvable from the desktop, but the
on-device path still could not succeed for anyone: approvers are manager/admin
accounts, which carry no `pin_hash` (ADR-0016: Entra sign-in), and `verifyPin`
refuses every non-operator. Two Woodland site managers each hold **two** accounts:
an operator account with a floor PIN they already use, and a manager account
without one. The iPad told them their PIN was wrong.

**Decision (Bill, 2026-11-06).** Let a manager approve on the iPad with the floor
PIN they already know, by **explicitly linking** their manager account to the same
person's operator account. Keep the desktop Held counts page.

- **Schema** (`20260871_adr0072_am2_floor_pin_link`, additive, clean-replay safe):
  nullable `users.floor_user_id`, FK to `users.id` `ON DELETE SET NULL`, `UNIQUE`
  (one operator account backs at most one manager account), `CHECK` no self-link.
  The migration writes no rows.
- **Release, PIN path** (`releaseHold`): the PIN is verified with
  `verifyPin(floor_user_id, pin)`, so the existing per-account sliding-window
  lockout (5 failures / 60 s → 15 min) lands on the linked operator account. No
  link → `NoFloorPinError`, answered 403 `no_floor_pin`, and the iPad says
  _"This manager has no floor PIN; approve from the desktop Held counts page"_
  (en/es/ur) instead of "wrong PIN". It is decided before any PIN is verified, so
  it burns no attempt and reveals nothing about a PIN. A link to an account that
  is not an active operator fails inside `verifyPin` → `bad_pin`. The audit row
  records `pin_verified_user_id`. The approver of record stays the manager account.
- **Four-eyes by PERSON, both paths.** The self-release check (still before the
  PIN) now treats an account, the account it links to and the account linking to
  it as one person. A count entered under someone's operator login cannot be
  released by their linked manager account on the iPad **or** from the desktop
  (`path: 'remote'`), and vice versa. The rule compares `created_by` only, as it
  did before: `counted_by` / `confirmed_by` are free-text names (ADR-0138), not
  account ids. The DB `CHECK (approved_by <> created_by)` still guards the
  account-level case.
- **Link management:** `scripts/link-floor-pin.mjs`, admin-only (`--actor` must be
  an active admin and is the audit actor), exact user ids only, dry run by
  default, `--apply` writes the link and its audit row in one guarded
  transaction. It refuses different primary sites, a target that is not an active
  operator with a PIN, an operator already linked, and a manager already linked
  elsewhere (`--clear` first). A manager must share the operator's primary site;
  an **admin** account has no site and may link to an operator at any site
  (PR #316), the operator still needing one.
- **Follow-ups (PR #315):** a linked floor account inside its PIN lockout answers
  `423 pin_locked` (own message, not "wrong PIN"). The link is **not** cleared when
  a role or site changes, because it is also the same-person record behind the
  four-eyes rule and clearing it would reopen self-approval; instead the PIN path
  requires the linked account to still be an active operator at the hold's site,
  else `no_floor_pin` and nothing is verified.
- **Incident:** `docs/2026-11-06-woodland-held-count-self-approval.md` records the
  self-approval that motivated the by-person rule.
- **Folded in from the PR #313 review:** `discardHold` is now a guarded
  `updateMany({ id, status: 'pending' })` with its audit row on the same
  transaction (the ADR-0118 shape), so a discard can no longer overwrite a hold a
  manager released a moment earlier (`HoldNotPendingError` instead). The site
  dashboard's held-count read degrades to the plain "Held counts" label on
  failure instead of failing the page.

**Unchanged on purpose.** `verifyPin` stays operator-only. No manager gets a
`pin_hash`. A manager cannot sign in as an operator: the link is consulted only by
`releaseHold`, and the Credentials sign-in provider is untouched. The approver
list on the iPad still lists every eligible manager/admin, linked or not.

**Security reasoning.** The PIN proves the same thing it proves for a floor
action: the person who holds that operator account is present. The link is what
says that person is also this manager, and it is admin-set, per person, by exact
id, audited. Without a link nothing changes from Amendment 1.

**Residual risk.**

- The linkage is only as right as the admin who sets it. A wrong link lets one
  person approve on another manager's name with their own floor PIN. Mitigations:
  exact ids, same-site check, dry run, audit row, and the release audit names whose
  PIN was used.
- The PIN lockout is per **operator** account. Five wrong approval PINs lock that
  person out of floor sign-in for 15 minutes too, and floor PIN failures count
  toward approval lockout. Shared on purpose: one PIN, one counter.
- A floor PIN is a 4-digit secret typed on a shared iPad. Approving with it is no
  stronger than any other floor action; the desktop path remains the stronger one.
- A successful approval PIN stamps the operator account's `last_login_at`, as any
  floor PIN use does.
- A pending hold still raises no alert (Amendment 1 residual).

**Verification.** Unit (`anchor-holds.test.ts`): PIN verified against the linked
account, `no_floor_pin` before any PIN check, person-level refusal on both paths
and from both sides of the link (falsified by restoring the id-only check: 3 red),
discard CAS (falsified: 1 red), dashboard fallback. Real Postgres
(`floor-pin-link.db.test.ts`): constraints (UNIQUE, CHECK, SET NULL), real Argon2
`verifyPin` through the link, operator-only rule through the link, lockout lands
on the operator row, self-release by person on both paths, discard races (the
two-discards case falsified against the unguarded update: 2 audit rows), and the
link script's refusals, dry run and audited apply.
