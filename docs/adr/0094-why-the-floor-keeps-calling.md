# ADR-0094 — Why the floor keeps calling: the state machine models the schedule, not the yard

**Date:** 2026-08-11 (Pacific)
**Status:** Accepted (analysis + prevention plan; no code in this change)
**Author:** Terry (research/architecture pass, commissioned by Bill)
**Related:** ADR-0065 Am.1, ADR-0074 + Am.1, ADR-0078, ADR-0082, ADR-0086 Am.1, ADR-0090, ADR-0091, ADR-0092, ADR-0019.1 Am.2 / 0019.3 / 0019.4 / 0019.5
**Scope note:** This ADR answers *why* and proposes *what to do*. A parallel agent is
sweeping the code for remaining instances of the defect class; that inventory is
deliberately not duplicated here.

> **Landing note — 2026-08-11, 10:15 PM PT.** This analysis was written earlier the
> same evening and held out of git because the shared checkout carried another
> session's work. It is committed here **unmodified except for this note and a date
> correction**: the header read `2026-08-12`, which is the UTC day, not the Pacific
> one — the exact bleed `CHANGELOG.md` warns about at the top of the file, and the
> same defect commit `0101306` corrected for ADR-0093 a few hours earlier.
>
> Two claims moved between authorship and landing. They are recorded here rather
> than edited into the body, which stands as the record of what was true when it
> was written:
>
> - **§5 P2's late-arrival case has shipped** as ADR-0096 (`a10b887`, merged
>   2026-08-11 8:59 PM PT). It followed this ADR's prescription rather than the
>   tempting shortcut: it did **not** widen the ADR-0074 D5 day bound, and gave the
>   divergent case its own named state (`reconcilableExpectedLoadId`) instead.
> - **§5 P2's server-side day-guard gap is closed.** The parenthetical noting that
>   `assertCurrentPacificDay` was absent from `src/lib/load-service.ts` was accurate
>   at authorship; ADR-0096 enforced the bound inside `startInboundLoad` and cites
>   this ADR as the confirmation that the gap was still open.
>
> Everything else was re-verified against `origin/main` at `a10b887` before commit
> and still holds — including §3 RC-4's phantom `ADR-0065 Amendment 2` citation,
> which is addressed by the follow-up work this ADR's P5 describes.

---

## The question

Bill, after the second floor-blocking incident in two days:

> "I need to understand why these issues keep happening — they should not need to
> call for help daily for this kind of issue."

This is the answer, grounded in production data from `dr3_vision` on CHAD-HQ and in
the repo's own paper trail. All times Pacific.

---

## 1. First, a correction to the premise

The working assumption has been that the floor system "went live around June" and
that Eugene's late-July go-live broadened it. **The production data does not support
that, and the difference matters.**

`inbound_loads` records the first operator-claimed load on **2026-07-29**. Before
that date there are zero rows with an `assigned_operator_id` — every inbound load in
June and early July was a bulk, paper, or MyMRC-aggregate row with no floor operator
attached. Weekly, by `arrived_at`:

| Week of | iPad-floor loads | Operator-claimed | Distinct operators |
|---|---|---|---|
| 2026-06-01 → 07-20 | 0 | **0** | 0 |
| 2026-07-27 | 1 | 11 | 4 |
| 2026-08-03 | 0 | 38 | 4 |
| 2026-08-10 (2 days) | 0 | 15 | 3 |

The claim/count/submit workflow — the thing that is failing — has been in real floor
use for **ten operating days**: 2026-07-29, 07-30, 07-31, 08-03, 08-04, 08-05, 08-06,
08-07, 08-10, 08-11. Floor write volume over those ten days, from `audit_log` on
`inbound_loads` / `load_stacks` / `load_photos`:

```
07-28:  1     08-03: 47     08-10: 92
07-29: 13     08-04: 53     08-11: 58
07-30: 20     08-05: 42
07-31: 21     08-06: 24
              08-07: 60
```

**Volume grew roughly 60-fold in ten operating days, and 2026-08-10 — the peak at 92
writes — is the day that produced three ADRs and the incident that produced a
fourth.** This is not a mature system that started failing. It is a two-week-old
workflow meeting reality, with load doubling weekly. That reframes the diagnosis and
it reframes the fix: the correct question is not "what broke" but "why does each new
piece of reality cost a phone call."

---

## 2. The core finding: 48% of the work does not follow the happy path

The state machine was designed around a clean sequence: a scheduled truck arrives on
its scheduled day, one operator claims it, works it continuously, and submits it the
same day. I measured how often that actually holds. Across all 89 non-cancelled
`expected_loads` slots scheduled between 2026-07-25 and now:

| Divergence from the happy path | Count | Of 89 |
|---|---|---|
| Slot never produced a child load at all (truck never checked in) | 29 | 33% |
| Truck arrived on a **different calendar day** than scheduled | 7 | 8% |
| Arrived **>4h late** | 10 | 11% |
| Arrived **>4h early** | 4 | 4% |
| Slot carried **no expected unit count** (0 or NULL) | 14 slots live | 14% |
| Load **closed by someone other than the claimer** | 1 | 1% |
| Claim **crossed midnight** Pacific (of 64 submitted claims) | 6 | 9% |
| Load had an **operator change** (handoff/takeover) | 15 | 23% of claims |

**Deduplicated: 43 of 89 slots — 48.3% — diverge from the happy path in at least one
way.**

That number is the root cause in a single figure. The design treats divergence as
exceptional. In the yard it is a coin flip. And the system's response to nearly every
divergence class it did not anticipate is the same: **it renders a card with
information on it and no way to act.**

That shape is what Bill is seeing as "daily calls." It is not many different bugs. It
is one defect class — *informative-but-actionless UI at the point of divergence* —
being discovered one branch at a time, at the rate the floor encounters new kinds of
mess.

### The three incidents are three branches of one tree

| Incident | Divergence the design didn't model | What the floor saw |
|---|---|---|
| 8/11 07:50 — Pablo, Costco-Innovel | Session gap: iPad slept mid-load | "Already started by another operator" — a sentence, no control (ADR-0091) |
| 8/10–8/11 — H-136796, 15h strand | Claim abandoned across a shift boundary | Nothing at all; no surface represented it (ADR-0092) |
| 8/11 17:18 — H-136980, Speedy Delivery | Truck arrived a **day late** | Card rendered "view only"; tap did nothing |

ADR-0091 already named the mechanism precisely, and it is worth quoting because the
repo diagnosed itself correctly:

> "The fix gave the card **a sentence and no control** … `ConsumedLoadRef` carried
> `status`, `open`, `totalUnits`, `workedAt` — **and no holder identity at all**. So
> the card could not have said anything else. It was not a wrong branch; it was a
> missing field."

And ADR-0074 Am.1 had already written the rule that would have prevented all three:

> "**never show a control whose only outcome is a refusal**" … "**A dead end with
> reassuring copy is worse than a bare one.**"

The rule existed. It was prose in an ADR. Nothing enforced it.

### The abandoned-claim backlog: the clearest single illustration

`audit_log` records 16 operator-change events, all on 2026-08-10 and 08-11 — because
ADR-0082's takeover control only shipped at 03:16 on 08-08. Measuring each takeover
against the age of the claim it displaced splits them into two clean populations:

**Population A — 2026-08-10, 08:28–08:44 (8 takeovers in 16 minutes).** Ages of the
claims displaced: **12.8, 9.8, 4.9, 4.9, 4.9, 4.6, 4.0, and 2.9 days.**

**Population B — the other 8, spread across both days.** Ages: 20 min, 40 min, 45
min, 50 min, 58 min, 178 min, 179 min, 431 min.

Population B is ADR-0082 working as designed — within-shift handoffs, lunch breaks,
the thing JT asked for. Population A is something else entirely: **a 13-day backlog of
abandoned claims, reaching back to the very first days of floor use, cleared by hand
in a 16-minute burst on the first morning a tool existed to clear it.**

Nothing in the system had noticed. Nothing could have — there was no representation
for "claimed and abandoned," so the condition accumulated silently from day one and
was only visible once someone went looking. ADR-0092's watchdog, which now exists,
has fired exactly once (Janette Tomas, 296 idle minutes, 2026-08-11 12:51 PT,
delivered 2/2). That watchdog is the correct shape of fix and I will come back to it.

---

## 3. Root causes, ranked by evidence strength

I rank these by how well the evidence supports them, and estimate what share of this
week's pain each explains. The shares overlap and deliberately do not sum to 100 —
these are contributing causes to the same events, not a partition.

### RC-1 — The domain model encodes the schedule; the floor works the yard. (Very strong; explains ~60%)

**Evidence:** the 48.3% divergence rate, measured directly, n=89. All three of this
week's floor-blocking incidents are divergence classes. The design's day-bounded
check-in (ADR-0074 D5 bounds both check-in surfaces to the current Pacific day) is a
correct guard against minting a child load onto the wrong slot — but it means a truck
that arrives on any day other than its scheduled one has **no first-class
representation at all**, and 8% of trucks do exactly that.

**Why this is the primary cause:** every other factor below determines how *fast* a
given branch gets found and fixed. This one determines how *many branches there are*.
At a 48% divergence rate with volume doubling weekly, fixing one branch per incident
is a losing race, and the arithmetic says so.

**Honest caveat:** some of the 29 orphaned slots are legitimately "the truck never
came," which is a real business outcome and not a defect. I did not separate those
from "the truck came and the floor couldn't check it in," because the system does not
record the difference — which is itself the finding. The 33% is an upper bound on
that class; the other divergence classes are exact.

### RC-2 — Parity between surfaces was convention, not test. (Strong; explains ~25%)

**Evidence:** the Queue and Hauls screens have now failed **identically, twice**.
ADR-0074 Am.1 stated the mechanism in its own header — *"The blindness was identical
but the code was not shared, so fixing one would have left the other"* — and then
ADR-0091, seven days later, hit the same seam because Am.1 shared the
*classification* (`toConsumedLoad`) and left each surface to re-derive the *decision*.

ADR-0091 fixed this properly, with a shared `describeConsumedSlot` plus two
`it.each` chokepoint tests, and stated the general principle:

> "The two lists are deliberately different files, **which is itself the argument for
> a shared function over a convention.**"

**But the fix is scoped to one card family.** The same duplication pattern is
documented as still open elsewhere: six status allow-lists remain duplicated
(ADR-0090 Q3, OPEN-ITEMS AW-4), and ADR-0092's own sweep found `ops-overview.ts`
carrying a *byte-for-byte copy* of `OPEN_DOCK_STATUSES` under a local name that was
never imported. ADR-0090 D1 puts the cost plainly: inlining a `??` chain at five call
sites is *"precisely how `held-by-panel.tsx` came to label a `submitted` load
'Counting' for five days."*

**What this explains:** not why bugs appear, but why fixing one leaves its twin
armed — which is what makes the failures feel relentless rather than diminishing.

### RC-3 — Ship velocity outran the verification loop. (Strong; explains ~40% of the *recurrence rate*)

**Evidence** (committer timestamps verified as Pacific — `git log --format='%cI'`
shows `-07:00` offsets, so these are wall-clock, not UTC):

On Monday 2026-08-10, four behavior-changing PRs merged into the floor surfaces at
**13:59, 16:29, 17:34, and 19:54 PT**. At **07:50 PT the next morning**, Pablo was
stranded — by the 16:29 ship (ADR-0074 Am.1). ADR-0091 traces the causal chain
explicitly. The fix for *that* merged at 08:44 PT, 55 minutes after the report.

The pattern repeats earlier: four PRs covering the entire P2–P5 floor campaign
(ADR-0082, 0084, 0085, 0086) merged in a **43-minute window between 02:34 and 03:17
on Saturday 2026-08-08**. ADR-0084's own verification section admits what that cost:
*"No Postgres was reachable from the build host … It has not been executed locally;
that is the honest status"* — a database test shipped un-run at 2:34 AM.

Cadence: **11 ADRs in the 8 August working days to date**, against 32 in all of July.

**What this explains:** the interval between "a change lands" and "the floor finds
what it broke" is currently *one night*. There is no verification step in between
that exercises the floor surfaces as a floor operator. ADR-0091's own root-cause
reproduction — signing in as Pablo against the running container — is exactly the
check that, run automatically at 06:00, would have caught this before he did.

**Honest caveat:** the velocity is not straightforwardly bad. Report-to-merge times
this week were 55 minutes (ADR-0091), 48 minutes (ADR-0086 Am.1), and same-day
(ADR-0090). That responsiveness is genuinely excellent and is why each incident cost
a morning rather than a week. The problem is not that the team ships fast; it is that
**fast shipping without a floor-shaped verification gate converts every fix into a
coin flip on the next morning.**

### RC-4 — Forward promises live in prose, and prose does not execute. (Strong; explains ~15%, and all of the adjacent findings)

**Evidence:** roughly 42 distinct promises of future work appear across the 13
floor-related ADRs. **Not one carries an issue number.** The single tracking
mechanism is `docs/OPEN-ITEMS.md` — 2,024 lines, currently 8 items marked OPEN, 4
WATCH, 1 DEFERRED against 37 DONE. About half the promises name that register; the
other half — including all five of ADR-0092's residuals and both of ADR-0091's — are
pure prose in a Consequences block with no handle at all.

The consequences of this are not theoretical, and this week produced three:

1. **The health pill.** Promised in ADR-0019.1 §4, then *cited as a live control* by
   two later ADRs. ADR-0019.1 Amendment 2 (2026-08-11) is titled "the health pill
   never shipped" and states: *"This does not exist … its subsystem list is hardcoded
   and closed at six entries … **Both sites sat in exactly that state from the
   2026-07-07 incident until 2026-08-11 with no visible symptom.**"* Four months.
2. **The 08:30 auto-override safety net** — dead at both sites for a month because a
   seed re-reverted it (ADR-0019.3).
3. **Escalation pages silently dropped for a week** on an em-dash header bug, while
   the counters reported the attempts as successes (ADR-0019.5).

There is a fourth instance nobody has noticed yet: **six source files and one test
cite "ADR-0065 Amendment 2," and no such amendment exists.**

```
src/app/dashboard/[site]/ops/OpsClient.tsx:41
src/app/dashboard/[site]/equipment/EquipmentClient.tsx:24
src/app/dashboard/[site]/processed-units-close/ProcessedUnitsEntryClient.tsx:20
src/app/dashboard/[site]/loads-inventory/LoadsInventoryClient.tsx:61
src/app/admin/processed-units/ProcessedUnitsClient.tsx:27
src/lib/app-today-iso.test.ts:1
```

`grep -c "Amendment 2" docs/adr/0065-*.md` returns 0. The *work* shipped; the record
did not. This is precisely the failure ADR-0064 documented about itself — *"This ADR
was referenced by the code it governs … but the file itself was never committed"* —
recurring undetected.

**The pattern that matters:** the three items above share a shape with the floor
incidents. A safety net that is an *event on a channel* rather than *standing,
readable state* fails silently. Nobody notices a page that did not arrive. This is
the same defect as a card that renders without a control: **the system's failure mode
is silence, and silence is indistinguishable from health.**

### RC-5 — Maturation curve, and the curve is knowable. (Moderate-strong; context for all of the above)

**Evidence:** ten operating days; 60-fold volume growth; the peak-volume day produced
the most incidents. Distinct operators went 2 → 4. Divergence classes are surfacing
roughly in proportion to exposure, which is what a maturation curve looks like.

**What the curve predicts:** divergence classes are discovered at a rate proportional
to (volume × operator count × distinct real-world conditions). Volume is climbing;
operator count is climbing; and Eugene broadens the condition space further. **The
incident rate will not decay on its own over the next two to four weeks — it will
rise before it falls**, unless the discovery mechanism changes from "the floor calls
Bill" to something that finds branches ahead of the floor.

**Honest caveat:** ten operating days and 64 claims is a small sample. The 48.3%
figure is solid for the population measured but the per-class rates (especially the
4 early arrivals) rest on single-digit counts and should be re-derived at a few
hundred loads. ADR-0092 makes the same point about its own thresholds.

---

## 4. So: is "informative-but-actionless UI" the right frame?

**Yes, with one amendment.** The frame is correct and the data supports it, but it is
the *symptom layer*. Stated fully, the causal chain is:

> The domain model has **no state for divergence** → so a diverged object falls
> through every `if` branch → so it lands in a default render path → and the default
> render path shows what it knows and offers nothing, **because a card with no modeled
> state has no modeled action.**

The dead card is not a UI bug. It is the visible end of a missing state. That
distinction determines the fix: adding a button to each dead card is whack-a-mole,
because the next unmodeled state produces the next dead card. Naming the divergence
states — and making it impossible to render an unnamed one — is the fix that
generalises.

### The real-world messiness inventory

Assembled from production data and the ADR trail. Measured classes carry counts;
unmeasured ones are named so they stop being surprises.

| # | Real-world condition | Modeled today? | Observed |
|---|---|---|---|
| 1 | Truck arrives **late** (different day) | No — both check-in surfaces day-bounded | 7 slots; caused the 8/11 PM incident |
| 2 | Truck arrives **early** | Partially — ADR-0074 Am.1 | 4 slots |
| 3 | Truck **never arrives** | No | 29 slots (upper bound) |
| 4 | Claim **abandoned** across a shift | Now detected (ADR-0092), not prevented | 8 claims aged 2.9–12.8 days |
| 5 | **Session gap** (iPad sleep / PWA reload) | Now routed (ADR-0091) | The 8/11 AM incident |
| 6 | **Operator handoff** mid-load | Yes (ADR-0082) | 15 loads |
| 7 | Work **crosses midnight** | Partially — Pacific-day keys | 6 claims |
| 8 | Slot has **no expected count** | No | 14 live slots |
| 9 | **Offline gap** / queued writes | Yes (ADR-0078) | Known residual |
| 10 | **Device swap** mid-load | Unknown — untested | Unmeasured |
| 11 | **Multi-day** unload | No | Unmeasured |
| 12 | Duplicate / double-entered count | Yes (ADR-0084) | — |
| 13 | Truck arrives **not on any slot** | Partially (walk-up, ADR-0085) | Unmeasured |
| 14 | Two trucks, **same source, same day** | Yes (ADR-0090) | — |

Rows 10, 11 and 13 are the ones I would expect to produce the next incident. None has
a test, and none has been observed — which given a 48% divergence rate is more likely
to mean "not yet encountered" than "does not happen."

---

## 5. Prevention plan

Ordered by leverage per hour, not by ambition. Each item states what it buys and what
it does not.

### P0 — Instrument the dead end. (1 day) — DO THIS FIRST

Every render of an actionable domain object that offers **no control** emits a
structured event: `{surface, objectId, objectType, reason, userId, siteId}`. Aggregate
into a daily digest at 06:30 PT, plus the existing ops dashboard.

**Why first:** today, the discovery mechanism for this entire defect class is *Bill's
phone*. This converts it into a metric. It requires no domain redesign, it works on
every branch including the ones not yet found, and it turns RC-5's maturation curve
from a surprise into a readout. It would have surfaced the H-136980 class on 8/11
morning rather than at 17:18 via a phone call.

**Per ADR-0037:** a digest and a dashboard tile, **not** a page. A dead-end render is
not actionable within 5 minutes. Only a *threshold* breach (same object dead-ended by
the same user 3+ times in an hour — the signature of someone stuck right now) earns
`high`, and it routes to the load page.

**Does not buy:** any fix. It buys knowing, one working day ahead of a phone call.

### P1 — The Dead-End Rule, enforced by a chokepoint test. (2–3 days)

Codify ADR-0074 Am.1's existing prose rule as a design rule with teeth:

> **No card representing an actionable domain object may render without either (a) a
> control, or (b) an explicit, named, tested `noActionReason` drawn from a closed
> enum.**

Implement by generalising the ADR-0091 pattern: one shared, client-safe descriptor
function per card family returning a discriminated union, plus an `it.each`
chokepoint test asserting every rendering surface calls it. ADR-0091 proved the
pattern works; this extends it from the consumed-slot family to the others.

**Why:** this is the single change that makes RC-2 structural rather than
aspirational, and it converts the class from "found by the floor" to "found by CI."
ADR-0084 already articulated the principle: *"A sentence asking the next author to
remember `voided_at: null` is a sentence the next author never reads. A test that
reads their code is."*

**Does not buy:** correctness of the *reasons*. A card can pass with an honest
`noActionReason` and still leave an operator stuck. That is what P2 is for.

### P2 — Name the divergence states and give each a route. (3–4 days, after P0/P1)

Turn the §4 inventory into a first-class `SlotDivergence` enum in the domain layer,
with an explicit decision per state: route, control, or documented terminal state.
Priority order by observed frequency: late arrival (row 1), never-arrived (row 3),
no-expected-count (row 8), then the unmeasured rows 10/11/13.

**Specifically for the 8/11 PM incident:** do not simply widen the ADR-0074 D5 day
bound. That bound exists to stop a child load being minted onto the wrong slot, and
removing it re-arms the 159-unit mis-booking of ADR-0074 Am.1. The right shape is a
distinct, explicit **"this truck arrived on a different day — reconcile it"** path
that names the slot it is reconciling against and asserts the match server-side.
(Note: `assertCurrentPacificDay` still does not exist in `src/lib/load-service.ts` —
the day guard remains UI-layer only, which ADR-0074 Am.1 recorded as an open decision
for Bill and which is still open.)

**Does not buy:** completeness. New divergence classes will keep appearing; P0 is what
finds them.

### P3 — A floor-shaped smoke check that runs before the floor arrives. (2 days)

Automate what ADR-0091 did by hand: mint a session as a real floor operator, render
every floor surface against the deployed container, and assert no surface presents an
open object with no route. Run at **06:00 PT daily** and post-deploy.

**Why:** this closes RC-3 without slowing anyone down. It puts a verification step in
the one-night gap between "a change lands" and "the floor finds it." Pairs with a
process rule (P4).

### P4 — Shipping-window rule. (process only, no engineering cost)

Floor-surface behavior changes do not merge after **15:00 PT** unless they are active
incident fixes. Anything landing in the afternoon gets the P3 smoke check green before
the floor arrives.

**Justification:** 2026-08-10's 16:29 ship produced 2026-08-11's 07:50 escalation. The
02:34–03:17 Saturday batch shipped a database test that had never been run. This costs
nothing and removes the single highest-correlation factor in this week's incidents.
It explicitly does **not** slow incident response — 55-minute report-to-merge stays.

### P5 — Make promises executable. (2 days)

Two CI checks:
1. **ADR citation resolver** — every `ADR-NNNN` (and `Amendment N`) reference in
   `src/` must resolve to an existing ADR file and section. Fails the build otherwise.
   This catches the phantom "ADR-0065 Amendment 2" and the ADR-0064 class of drift.
2. **Promise linter** — a `Consequences`/residual block containing a promise marker
   (`Recorded`, `not built`, `follow-up`, `Deferred`, `out of scope here`) must carry
   a GitHub issue link. Prose-only promises fail review.

**Why:** ~42 untracked promises, zero issue numbers, and a four-month invisible gap on
a payroll safety net that two later ADRs believed was live. `OPEN-ITEMS.md` at 2,024
lines has become a place promises go, not a place they come back from.

### P6 — One half-day with the floor. (0.5 day) — highest value per hour

Walk JT and Pablo through the messy cases in §4 and ask, for each: *what do you
actually do when this happens?* Rows 10, 11 and 13 are unmeasured guesses; the floor
already knows the answers.

**Why:** every incident this week was a state the floor encounters routinely and the
model had never heard of. The cheapest way to enumerate the remaining ones is to ask
the people who work them. This is the item most likely to change the plan itself.

### Sequencing

| Order | Item | Size | Rationale |
|---|---|---|---|
| 1 | P0 dead-end telemetry | 1 d | Converts phone calls into a metric; works on unknown branches |
| 2 | P4 shipping window | 0 d | Free; removes the top correlate |
| 3 | P6 floor session | 0.5 d | Cheapest way to find the unknown states |
| 4 | P1 dead-end rule + chokepoint tests | 2–3 d | Makes the class CI-detectable |
| 5 | P3 floor smoke check | 2 d | Closes the overnight gap |
| 6 | P2 divergence state model | 3–4 d | The durable domain fix |
| 7 | P5 promise/citation CI | 2 d | Stops the silent-drift class |

**Total: ~11–13 engineering days**, front-loaded so that the first 1.5 days change
what Bill knows and the first 4 change what CI catches.

---

## 6. What this does not fix, stated plainly

- **P0–P6 do not reduce the 48% divergence rate.** That is the yard, not the software.
  The goal is that divergence stops costing a phone call, not that it stops happening.
- **The incident rate will likely rise before it falls.** Volume and operator count are
  both climbing, and P0 will make previously-invisible dead ends visible — the first
  week of telemetry will look worse than this week did. That is the instrument
  working, not a regression, and it should be read that way when the numbers arrive.
- **P1's chokepoint test proves a reason exists, not that it is a good reason.** A
  surface can pass CI and still strand someone with an honest explanation.
- **Nothing here prevents a claim being abandoned.** ADR-0092 said this about itself —
  *"This is a reader, not a cure"* — and it remains true.
- **The sample is small.** 64 claims over 10 operating days. Every per-class rate in
  §4 should be re-derived at a few hundred loads before anyone plans against it.
- **I did not separate "truck never came" from "floor couldn't check it in"** in the 29
  orphaned slots, because the data does not distinguish them. That gap is itself worth
  closing and is a candidate for P2.

---

## 7. Answering Bill's question directly

The floor is not calling daily because the software is unusually buggy. It is calling
because **a two-week-old workflow is meeting a world that diverges from its model
about half the time, and every divergence the model doesn't name turns into a screen
that explains the problem and offers no way out.**

Three things make that worse than it needs to be: the same decision is re-derived on
each surface, so fixing one leaves its twin armed (RC-2); changes land in the evening
and are first exercised by the floor the next morning (RC-3); and the fixes the team
promises itself live in prose that nothing executes (RC-4).

The way out is not to fix branches faster. It is to (a) find them before the floor
does — P0 and P3, three days of work — and (b) make an unnamed state impossible to
render — P1 and P2. The floor should stop being the discovery mechanism. That is the
whole plan.

---

## Sources

All verified 2026-08-11 Pacific (2026-08-12 UTC — the queries were run in the
evening, which is why the UTC stamp reads a day ahead).

- **Production:** `dr3_vision` on `dr3-vision-postgres`, CHAD-HQ. Tables
  `inbound_loads`, `expected_loads`, `audit_log`, `load_stacks`, `stale_claim_alerts`.
  Queries: weekly adoption curve; 89-slot divergence taxonomy; 16-event takeover
  age analysis; daily floor write volume.
- **Repo paper trail:** ADR-0060, 0061, 0064, 0065 (+Am.1), 0074 (+Am.1), 0078
  (+Am.1), 0082 (+Am.1), 0084 (+Am.1), 0085, 0086 (+Am.1), 0090 (+Am.1), 0091, 0092;
  ADR-0019.1 Am.2, 0019.3, 0019.4, 0019.5; `docs/OPEN-ITEMS.md`; `CHANGELOG.md`.
- **Git:** `git log --format='%h %cI %s'` — committer timestamps carry `-07:00` and
  are Pacific wall-clock, verified directly rather than assumed.
