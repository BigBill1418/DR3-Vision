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
healthy (HTTP 200).

> **CORRECTION (2026-07-29, same day).** This ADR originally guessed that the gap
> was Bill's topic subscription. **That guess is FALSIFIED.** A diagnostic publish
> to `dr3-vision-system` (message id `mgTbY3HYWq5P`, HTTP 200) **arrived on his
> phone**, and `ntfy user list` shows `noc-reader` holds `read-only access to
> topic *` — so neither delivery nor ACL was ever the problem.
>
> **The ntfy leg's historical failure is therefore UNEXPLAINED.** Candidates, none
> confirmed: the publish threw at the time and `.catch(() => undefined)` ate it
> (env/token not yet provisioned on that code path); the ADR-0037 fingerprint
> cooldown suppressed it (unlikely — the fingerprint is per-request); or the pages
> did arrive and went unnoticed among other traffic. The app container has since
> been recreated, so the logs that would settle it are gone.
>
> What IS proven either way: the EMAIL leg resolved to an empty recipient set and
> sent nothing, every time. That is the defect this ADR fixes, and it stands
> untouched by the correction.

**Consequence for
this design: the empty-recipient alarm emails Bill as well as paging him.**
Relying on a single channel to report a *notification* failure is the shape of
the original bug regardless of which channel is healthy — a defence-in-depth
argument, not a claim that ntfy is broken. The correction above does not weaken
it: an alarm about undelivered notifications should not itself depend on one
delivery path.

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

## Implementation note — §1.5, the escalation scanner (2026-07-29)

Shipped as `scripts/ap-escalation-scan.mjs` (hourly, :10 past) →
`/api/internal/ap/escalation-scan` → `runApEscalationScan()` in
`src/lib/ap/escalation-scan.ts`. Five decisions worth recording, because each one
was a fork where the obvious choice would have re-created the defect above.

**1. The scanner does not implement escalation.** It decides _when_, and the
resolver decides _what_. `resolveSecondApproval(…, { escalated: true })` already
expresses the additive widening and is already consumed by the authorization
check; re-deriving "who is the fallback" here would have re-created exactly the
two-implementations-of-one-question shape that caused the outage. The same applies
to the no-routing-row case: the scanner reads
`outcome === 'fallback_no_routing_row'` rather than re-querying the table and
re-deciding. The only thing it reads from `ap_approval_routing` directly is the
numeric `fallback_after_hours` threshold, and only once the resolver has already
confirmed a row exists.

**2. Idempotency is a WRITE predicate, not a read filter.** `escalated_at IS NULL`
appears in the candidate query _and_ as a condition on the claiming `updateMany`.
Only the second is load-bearing: two overlapping scans can both read a row (a slow
run meeting the next hourly fire; a restart mid-run), and the read filter would
let both proceed. The audit row is written inside that same transaction, so there
is no window in which a request is stamped escalated with no trail. The test runs
the scan twice and counts one notification and one audit row.

**3. A dedicated escalation email, not `notifySecondApprovalNeeded()`.** Reusing
the existing function was the obvious move and is wrong: it pages
`dr3-vision-system` unconditionally, so an hourly scanner would have pushed a
staff workflow nudge onto Bill's phone. Hard rule #5 reserves ntfy for Bill and
system-level events, and ADR-0037's gate agrees — an invoice waiting a day is
neither actionable-in-five-minutes nor customer-visible.
`notifySecondApprovalEscalated()` is email-only through `notifyStaff()`. The two
conditions that _do_ page from the scanner are both genuinely system-level: a
routing misconfiguration (`reportSecondApprovalRoutingProblem`, which emails as
well as pages, per §B.5) and a scan that could not run.

**4. Only the people escalation ADDED are emailed.** §1.6 says
`second_approval_request` fires to "the individual it routed to, plus the fallback
on escalation" — that describes the event's audience across its whole lifetime,
not one send. The peer received theirs at first-approval time; re-sending it every
escalation would train them to ignore it. The pref filter is applied _after_
routing, so it can only subtract.

**5. Two "impossible" states escalate immediately rather than aging.** A request
with no routing row (§1.4, explicit) and a request in `pending_second_approval`
with no `first_approved_at` (a data defect the clock cannot evaluate). Treating
the latter as "not due yet" would leave it invisible forever, which is the failure
class this ADR exists to remove. Escalation is additive, so making a defective row
_more_ visible costs nothing, and the routing alarm carries the reason.

**Fail-loud posture (§B.8 / ADR-0057 D9).** A scan that cannot run pages
`dr3-vision-system` and re-throws so the route 500s. It must never return a clean
empty result — "0 escalated" from a broken scanner is indistinguishable from "0
escalated because the backlog is healthy," and that indistinguishability is the
defect. A single poisoned row is contained so it cannot strand the rest of the
backlog, but it still pages. Cooldown 6h (the AP poll deadman class), so a
hard-down scanner pages 4×/day rather than 24.

**Weekday clock.** `businessHoursElapsedExceeds()` from `business-clock.ts`, no new
date arithmetic. Verified at the three instants that matter: first-approved Friday
4pm PT is 8 business hours old on Saturday 4pm (no escalation), 16 on Monday 8am
(no escalation), and 24 on Monday 4pm (escalates). A holiday pauses the clock only
when observed at every site.

**Deliberately out of scope.** The scanner writes no digest — §1.7's 06:00 warning
lines consume the `problems` it returns, and that consumer is not built here. The
compose service is declared but **not deployed** (deploys are manual on svdp-dev).
Unlike its siblings the daemon carries no Pacific offset-reprobe math: it fires
hourly, and an hour is an hour in every zone. That is pinned by a test across both
DST transition days so it does not get "fixed" back into wall-clock arithmetic.

## Amendment 1 — 2026-07-29: the §1.4/§1.6 admin surface

Both tables shipped as data with no way to see or change them outside a
migration. That is the wrong end state for a design whose whole premise is
"staff change, code should not" — and §1.4's own `problems` string already told
admins to "configure the pair at `/admin/ap/routing`", a route that did not
exist. This amendment builds it.

**One screen, two routes.** `/admin/ap/routing` and `/admin/ap/notifications`
render the same component (`src/app/admin/ap/config/render.tsx`). Bill's
instruction was explicit — _"two separate pages for six rows of config is
worse."_ The routes exist because the two halves are separately linkable (the
resolver's warning names the routing one); they are not separate surfaces. The
filter state is carried across the cross-link by a single serializer,
`src/app/admin/ap/config/list-url.ts`, per ADR-0017 Amendment 1.

**The picker is keyed on reachability, and this is the load-bearing decision.**
Only accounts that are ACTIVE, hold an approver role, and HAVE AN EMAIL are
offered as a second approver or fallback — `getApConfig().selectable`, re-checked
server-side in `saveRoutingRow()`. This is the same rule, in the same shape, that
the seed had to learn: Bill, Janette and Morena each have a second, **email-less
operator PIN account with the same name**. A name-keyed picker would let an admin
select one, and the routing table would read as fully populated while every
notification resolved to nobody — the outage, reintroduced through its own admin
screen. Excluded namesakes are **disclosed** in the UI rather than hidden, and
every option is labelled with its email, so two same-named accounts are
distinguishable at the point of choice.

**Self-approval is refused at three layers**: the picker never offers the first
approver as their own peer, `saveRoutingRow()` rejects the pair before writing,
and the DB `CHECK (first_approver_id <> second_approver_id)` backstops both. The
constraint violation is **caught by name** and mapped to a readable message —
the storage-layer guarantee is the last line of defence, not a 500.

**Totality is surfaced, not assumed.** The screen enumerates active
manager/admin accounts, diffs them against the active routing rows, and renders
the gap using the same wording the resolver reports to the 06:00 digest. A
missing row is graded `error` when the subject is an admin or sits on the
`ap_approvers` roster (they can genuinely first-approve today) and `warning`
otherwise (an approver-role account that would degrade silently the day they are
added). Rows pointing at an unreachable second approver or fallback are reported
the same way.

**Prefs are shown as EFFECTIVE values.** A user with no `ap_notification_prefs`
row is rendered with the column defaults and badged "Defaults", because a missing
row means defaults, never "notify nobody" — showing blank checkboxes would
misrepresent what the sender actually does. The first write materialises the row
**from the defaults**, so flipping one event never silently switches the other
three off. `second_approval_request` carries its full semantics in the UI: it is
never a broadcast, and the toggle can only remove someone from their own routed
requests.

**`decision_outcome` is rendered and refused.** It ships as a column with
everyone false and no send path, so the API rejects any attempt to enable it and
the checkbox is disabled with a "Not wired" badge. Hiding the column would leave
it undocumented exactly where it would be configured; making it writable would
promise an email nobody sends.

Every mutation writes its `audit_log` row (`table_name` `ap_approval_routing` /
`ap_notification_prefs`, before/after JSON) **inside the same transaction** as
the write, per `src/lib/admin-users.ts` and hard rule #6.

Gating is `role === 'admin'` at both the page layer and the API layer — an admin
POWER, never the `all_sites` reach flag (hard rule #2).

Deliberately out of scope: deleting a routing row (deactivate instead — deletion
would break totality and lose the pair's history), editing `ap_second_approvers`
(deprecated, read-only history), and any i18n (the admin surface is English-only
per ADR-0017, with every literal in `src/app/admin/messages.ts`).

Tests: `src/app/api/admin/ap/config/config.test.ts`,
`src/app/admin/ap/config/ApConfigScreen.test.tsx`,
`src/app/admin/ap/config/list-url.test.ts`.

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
