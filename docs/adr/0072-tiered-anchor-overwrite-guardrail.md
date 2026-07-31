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
