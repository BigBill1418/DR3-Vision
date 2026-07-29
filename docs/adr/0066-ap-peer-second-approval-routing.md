# ADR-0066: AP second-approval routing becomes person-to-person, with per-user notification scoping

**Date:** 2026-07-28
**Status:** Accepted
**Supersedes:** ADR-0046 Amendment 5 (D-M5-3) site-based second-approver routing
**Supplements:** ADR-0047 (`notifyStaff()` rollout chokepoint), ADR-0036/0037 (ntfy policy)

## Context — a silent, week-long money outage

Invoices ≥ $1,000 correctly transitioned to `pending_second_approval`. Bill
received nothing — no ntfy, no email — and they sat indefinitely.
`docs/operator/ap-approvals.md` claimed both channels fire.

The cause is an **authorization/notification divergence**, and both halves are
visible in the Amendment 5 CHANGELOG entry:

> **Authorization is server-side only.** Eligible = admin role OR an active
> `ap_second_approvers` row for the decision's site.

> **Notification:** `notifySecondApprovalNeeded` … emails the routed second
> approver … **Fail-soft — never fails the first approval.**

> **Operator handoff:** … **Bill/Woodland needs no row; admin-eligibility** covers it.

In code:

| Path                             | Resolution                                                      |
| -------------------------------- | --------------------------------------------------------------- |
| `canFulfillSecondApproval()`     | `if (actor.role === 'admin') return true` **then** roster check |
| `activeSecondApproversForSite()` | roster check **alone**                                          |

Bill was **deliberately** never given a `woodland` roster row, because
admin-eligibility already covered his authority. So every Woodland second-approval
resolved to an **empty recipient set**. Because the notify path is fail-soft, it
sent nothing and raised nothing. Shannon — an explicit `eugene` row — was notified
normally, which is why the system looked healthy from the Eugene side and would
have passed any Eugene-side test.

**Fail-soft is correct for a notification** (a paging failure must never roll back
a committed approval). **Fail-soft over an empty recipient set is
indistinguishable from success** — that indistinguishability _is_ the defect.

### Investigation (§1.3 Checks A–D, run 2026-07-29 against prod)

| Check                | Result                                                                                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** — backlog      | **0 rows** in `pending_second_approval`. Bill had already cleared them by hand: four invoices first-approved Jul 22–23 all received their second signature on **Jul 27 in one batch** — the signature of "nobody was notified, then swept manually." |
| **B** — roster       | Exactly one active row: Shannon / `eugene`. Zero Woodland rows. Hypothesis confirmed.                                                                                                                                                                |
| **C** — notify path  | `notifySecondApprovalNeeded` (`src/lib/ap/notify.ts:165`) resolves via `activeSecondApproversForSite(siteCode)`; on an empty set it logs a warn and `return`s without sending email.                                                                 |
| **D** — rollout gate | `ap_notify` is `live` at both sites (flipped 2026-07-15). Not the cause.                                                                                                                                                                             |

**Check C found something the hypothesis did not predict:** an ntfy page to
`dr3-vision-system` fires _before_ the empty-recipient check, so Bill should have
been paged even with no email recipient. He was not — and that publish is wrapped
in `.catch(() => undefined)`, swallowing every error. Publisher auth verifies
healthy (HTTP 200), so the likely gap is topic subscription. **Consequence for
this design: the empty-recipient alarm emails Bill as well as paging him.**
Relying solely on ntfy to report a notification failure would repeat the exact
failure mode being fixed.

## Decision

### 1. Routing is person → person (§1.4)

Second approval is determined **solely by who signed first**. Site-based routing
is retired. Separation of duties improves: the two people who work the same floor
check each other and carry the context to catch a wrong charge.

| First approver     | Second approver |
| ------------------ | --------------- |
| Janette            | Morena          |
| Morena             | Janette         |
| Kelsey (until 8/8) | Morena          |
| Rick               | Shannon         |
| Shannon            | Rick            |
| Bill               | Morena          |

Data-driven in `ap_approval_routing`, not hardcoded — staff change, code should
not. A DB `CHECK (first_approver_id <> second_approver_id)` makes self-approval
impossible at the storage layer.

**The table must be total.** An approver with no row falls back **immediately**
(no 24h wait) to the fallback approver and raises a warning line in the 06:00
digest so the missing pair gets configured.

### 2. One shared resolver, consumed by both halves

`src/lib/ap/second-approval-resolver.ts` is the single source of truth.
`resolveSecondApproval()` returns `{ authorizedUserIds, recipients, routedTo,
outcome, problems }`, and `canFulfillSecondApprovalByRouting()` expresses the
authorization half **through the same function**. They cannot drift apart again.

**The invariant — `recipients` is non-empty whenever `authorizedUserIds` is
non-empty** — is asserted directly in `second-approval-resolver.test.ts`, for
every roster member and for an approver with no routing row at all. If routing
cannot produce a reachable human, the resolver falls back to reachable admins
**and** reports a `problems` entry. It never returns "authorized by someone,
notifiable by nobody."

**Authorization semantics are unchanged** — admin-eligibility is correct and the
handoff's DO-NOT list is explicit about it. Only routing and notification changed.

### 3. `ap_second_approvers` is deprecated, not dropped

We stop reading it; the table and its data remain for audit continuity. Recorded
in ADR-0046's amendment history.

### 4. Per-user, per-event notification scoping (§1.6)

`ap_notification_prefs` generalizes what would otherwise be a hardcoded
"don't email Shannon" exception.

| Event                     | Fires to                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `new_invoice`             | every user with the pref on (broadcast to the working queue)                              |
| `second_approval_request` | **only the individual it routed to**, plus the fallback on escalation. Never a broadcast. |
| `daily_digest`            | Bill only                                                                                 |
| `decision_outcome`        | **nobody** — ships as a column, all false, for future flexibility                         |

Seeded exactly as tabulated in §1.6. **Shannon's net effect is exactly one kind of
email — a second-approval request when Rick first-signed — and nothing else,
ever.** Asserted directly in a test rather than implied by pref rows.

Prefs filter _within_ the ADR-0047 `notifyStaff()` chokepoint and the `ap_notify`
gate; they never bypass either.

### 5. 24-hour fallback on a weekday clock (§1.5)

Escalation is **additive, never a transfer** — the routed peer stays able to sign
and whoever acts first completes it. Hourly, idempotent on `escalated_at IS NULL`.
Business-hours accrual reuses the existing weekend/holiday skip logic rather than
introducing a second calendar, and the Pacific-day helpers from ADR-0065 rather
than new date arithmetic.

## A near-miss worth recording: the seed nearly reintroduced the bug

The first draft of the migration seed matched users **by name**. In production,
Bill, Janette and Morena each have **two live accounts**: their manager/admin
account with an `@svdp.us` address, and an **operator PIN account created
2026-07-28** for the iPad floor rollout — which has **no email at all**. Taking
the most recent row by `created_at` selected the operator accounts.

The routing table would have looked fully populated while every second approver
resolved to an address that does not exist — **an empty recipient set: precisely
the defect this ADR exists to fix, reintroduced by its own seed.**

The seed now keys on **email** with a `role IN ('manager','admin')` guard, and the
migration was validated against live production data inside a rolled-back
transaction asserting **0 unreachable second approvers** and **0 prefs on
email-less accounts**. A regression test models the email-less operator account
explicitly.

## Consequences

- Bill is out of the bottleneck for routine second approvals while remaining the
  weekday-clock backstop.
- Notification scoping solves Shannon's noise problem as an instance of a general
  rule rather than a hardcoded exception.
- `secondApproverSiteLabel()` ("Woodland (Bill)" / "Eugene (Shannon Rockwell)")
  becomes wrong under person routing and is replaced by the resolved individual.
- Any approver added without a routing row degrades **loudly** (immediate fallback
  - digest warning), not silently.

## Implementation note — §1.7, the 06:00 PT morning digest (2026-07-29)

Shipped **live**, not pilot. Bill: _"we want that daily digest to go live as
well - its time."_

**Files:** `src/lib/ap/morning-digest.ts` (build + render + send),
`src/app/api/internal/ap/morning-digest/route.ts` (loopback-guarded internal
route), `scripts/ap-morning-digest.mjs` (thin Pacific scheduler), compose service
`dr3-vision-ap-morning-digest`.

**Audience.** Resolved through `dailyDigestRecipients()` — the
`notify_daily_digest` pref (§1.6) — never a hardcoded address. Bill's framing:
_"it's an oversight tool, the team works off the live queue."_ A test asserts the
digest re-targets when the pref moves, so the roster is data, not code.

**Coverage** is the widest option, as chosen: `pending_second_approval` (each
naming the individual who owes the signature, resolved through the §1.4 shared
resolver rather than re-derived), `pending` with no first approval, Holds stale
at 3+ days, escalations since the previous digest, plus two warning classes —
active approvers with no `ap_approval_routing` row, and any invoice 3+ days old
(which also marks the whole mail `importance: high`). Every row carries a tier-1
deep link to `/dashboard/ops/ap?request=<id>`; that URL policy is now **exported
from `notify.ts`** rather than re-declared, so the digest and the notification
emails cannot drift on click targets.

**Suppression, and its one refinement.** Nothing pending ⇒ **no email at all**,
asserted on the send path (`notifyStaff` never called), not merely on a payload
flag. "Nothing" means no items **and** no warnings. A routing-coverage warning
over an empty queue **does** send: suppressing it would keep a missing pair
invisible until an invoice happened to arrive — a real misconfiguration wearing
the costume of silence, which is the precise failure this ADR exists to remove.
It is a one-minute fix that then stops recurring, so it cannot become chronic
noise.

**Clock.** Weekday gating is `isBusinessDayNow()` from the shared §1.5 module —
no second calendar. Ages are counted in **Pacific calendar days**
(`pacificCalendarDaysBetween`, built on the ADR-0065 day key): counting in UTC
would roll the boundary at 4/5 PM Pacific and trip the 3-day alarm a full day
early on every evening arrival. The escalation delta window is anchored to
Pacific midnight of the previous **business** day rather than the previous 06:00
fire instant — that keeps it built purely from `pacificDayStartInstantPlus`
instead of reconstructing a wall-clock hour across the DST seam. It over-covers
by up to six hours (an escalation can appear in two consecutive digests) and that
is the correct direction to be wrong in.

**DST.** 06:00 PT is 13:00 UTC under PDT and 14:00 UTC under PST, so **no fixed
UTC cron expression can express it** — either literal is wrong for half the year
and would put the "morning" digest at 05:00 PT all winter. There is no crontab:
the daemon re-derives the next 06:00 Pacific wall-clock instant every iteration
from the tz database via the shared offset-reprobe helper. Pinned by
`src/__tests__/cron-dst-schedule.test.ts`, which asserts both absolute UTC
instants and the fall-back seam.

**Rollout surface.** Sent through `notifyStaff()` on the **existing `ap_notify`**
surface, deliberately: `ap_notify` is `live` at both sites (Check D above), while
a newly registered surface would be born `pilot` and would _not_ ship live. No
new `rollout_surfaces` row, no migration.

**Separate email.** Bill picked 06:00 without the "merge with a future
document-ingestion digest" option, so this owns one subject line and one cron
service; an ingestion digest gets its own.

**Deliberately out of scope.** No `/admin/ap/routing` page (the warning names the
table, not a link to a page that does not exist yet); no per-send ledger table
(the digest writes nothing, so a re-fire is at worst a duplicate oversight
email); no ntfy — CLAUDE.md hard rule #5 keeps ntfy to system-level events, and
staff notification is email.

## References

- CLAUDE.md hard rules #2 (site separation), #5 (ntfy is Bill-only, system events), #6 (append-only audit)
- ADR-0046 Amendment 5 D-M5-3 — the superseded site-based routing
- ADR-0047 — the `notifyStaff()` chokepoint and rollout gate
- ADR-0065 — the Pacific-day helpers reused by the weekday clock
