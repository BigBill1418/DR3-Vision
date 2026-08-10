# ADR-0074 — The iPad floor sees every portal haul: an open, searchable, newest-first read surface

- **Status:** Accepted
- **Date:** 2026-08-03 (all times Pacific)
- **Partially supersedes:** ADR-0065 **D5**, and only its READ half. D5's write
  scoping is untouched and remains in force.
- **Builds on:** ADR-0038 (mirror tables), ADR-0057 (full-object ingestion),
  ADR-0059 (hauls → inventory inbound bridge), ADR-0070 + Amendment 1
  (`disappeared_at` semantics, delivered-feed freshness), ADR-0047 (rollout gate),
  ADR-0060 / ADR-0065 (the iPad floor surfaces).

---

## Context

### The directive

Bill, 2026-08-03: **on-site iPad operators must be able to see any pending haul or
load from the MyMRC portal — searchable, newest to oldest.**

### What the floor could actually see

The iPad's only window onto MyMRC was `/operator/[site]/queue`. It lists
`expected_loads`, bounded to the current Pacific day and to `cancelled_at IS NULL`
(ADR-0065 D5). Measured directly against production (`dr3_vision` on CHAD-HQ,
2026-08-03 13:17 PT):

| set                                                 | rows      |
| --------------------------------------------------- | --------- |
| `mymrc_hauls_mirror` (every haul the portal showed) | **7,285** |
| `expected_loads` (the bridged, dock-workable slice) | 718       |
| mirror rows carrying an `expected_loads` sibling    | 714       |
| **visible on the iPad on 2026-08-03**               | **5**     |

**Five rows out of 7,285 — 0.07%.** An operator with a truck at the door and a
haul number on a BOL had no way to look it up, and no way to answer "is this one
of ours?" without a manager at a desktop.

### The census that shaped every decision below

Full status × type breakdown, same measurement:

| site         | status    | type             | rows      | with `disappeared_at` | undated   |
| ------------ | --------- | ---------------- | --------- | --------------------- | --------- |
| woodland     | Delivered | General          | 6,269     | 5,455                 | 2,322     |
| woodland     | Delivered | Consumer Dropoff | 992       | 992                   | 992       |
| woodland     | Confirmed | General          | 19        | 1                     | 0         |
| woodland     | Rejected  | General          | 3         | 3                     | 0         |
| woodland     | Inactive  | Consumer Dropoff | 1         | 1                     | 1         |
| woodland     | Inactive  | General          | 1         | 1                     | 1         |
| **eugene**   | —         | —                | **0**     | —                     | —         |
| **combined** |           |                  | **7,285** | **6,453**             | **3,316** |

### Four premises corrected by measurement

Design work on this surface began from four assumptions. Each was checked against
production before a line was written; three were wrong, and the fourth was right
for a reason worth recording.

1. **"Some mirror rows have a NULL status, so the filter must be NULL-tolerant."**
   Production carries **zero** NULL-status rows today. The tolerance is kept
   anyway — a list-pass row legitimately exists before its detail pass lands, and
   ADR-0070 Am.1 §3 already established that "money-safe" means never letting an
   un-detailed row be swept away by a set-membership test.
2. **"There are four haul statuses."** There are **five**. `Inactive` is
   undocumented anywhere in ADR-0038/0057 and appears on 2 rows. It is treated as
   retired alongside `Rejected` — but the filter is a **denylist**, so a sixth
   status MyMRC invents next surfaces rather than vanishing.
3. **"Eugene will need its own scoping rules."** Eugene has **zero** mirror rows,
   by construction: Rick's site runs on hand-filled paper and has no portal feed
   (see ADR-0049's parallel finding on the workbook). Eugene renders the honest
   empty state and needs no special case.
4. **"The consumer type string is `Consumer-Dropoff`."** Live it is
   **`Consumer Dropoff`**, unhyphenated. No code in this ADR matches on it, which
   is deliberate: type is displayed, never branched on.

### Why this is not a re-litigation of ADR-0065 D5

D5 quotes Bill directly:

> _"vision on the ipad is only going to show hauls from the current day … no
> historical or future views."_

That instruction was given about the **actionable queue** — the screen where an
operator confirms counts and starts loads. It stopped an operator paging back
through past production days and writing against them, which is a real
money-safety property and is **entirely preserved here**. Nothing in this ADR
touches `assertCurrentPacificDay`, the ADR-0060 D5 `per_load_exists` refusal, the
three-value partial unique index, the day-scoped inbound API, or any write guard
anywhere.

What changes is that **looking is no longer rationed**. The same distinction
ADR-0065 Amendment 1 already drew for unfinished dock loads — "D5 is about
browsing, and it was also, unintentionally, applied to unfinished work" — applies
again, one level out: D5 was also applied to _knowing what exists_, and that cost
the floor 99.93% of its visibility into the portal it works from.

---

## Decisions

### D1 — Read the MIRROR, not `expected_loads`

`listPortalHauls` (`src/lib/loads/portal-hauls.ts`) reads
`prisma.mymrcHaulsMirror`.

`expected_loads` is the wrong table for this job twice over: it holds 714 of the
mirror's 7,285 hauls (9.8%), and it exists to drive the dock workflow — a row
there means "this is startable", which is a much stronger claim than "this haul
exists". Widening it to be a catalogue would corrupt the meaning of every
downstream consumer, including the bridge and the queue.

### D2 — `disappeared_at` IS NOT A FILTER — and this is load-bearing

**5,455 of the 6,269 `Delivered` / `General` rows carry a `disappeared_at`
stamp; 6,453 of all 7,285 rows do.** Per ADR-0070 Amendment 1 §3, the stamp means
_"this id was absent from the last swept LIST VIEW"_ — and that amendment's own
conclusion is the point: **"'Not in this list' stops meaning 'gone' the moment one
mirror has two partial views."** MyMRC's list views are narrow and windowed; a
delivered haul rolls out of the active view as a matter of course.

Filtering on it would hide **87% of the delivered hauls** — reproducing, in a
different disguise, exactly the blindness this ADR exists to end. The module
header says so in full, and `portal-hauls.test.ts` case (a) fails if anyone adds
the filter. That test was **falsified by hand before commit**: adding
`disappeared_at: null` to the query turned case (a) red and left the other eight
green.

### D3 — Population, ordering, and the undated chip

- **Population:** every mirror row for the site except `Rejected` and `Inactive`
  — **7,280 of 7,285** today. Not "Confirmed only", not "recent only".
- **Order:** `docking_appointment_date DESC NULLS LAST`, tiebroken by
  `external_haul_id DESC`. Newest first, as directed, with a total and stable
  order.
- **`NULLS LAST` is not cosmetic.** Postgres sorts NULLs FIRST under `DESC`, so
  without it the **3,316 undated rows** would sit above every real appointment and
  bury the newest work.
- **Undated is reachable, not hidden.** An `Undated (N)` chip flips the list to
  exactly that set. Undated rows are never dropped — they are an upstream gap
  (ADR-0070's `undated:2301` finding, since grown), and hiding a gap is how it
  stays open.
- **Pending pinned on top.** The 19 `Confirmed` hauls render in an unpaginated
  block above the list, labelled with the fact that MyMRC reports **0 units until
  delivery** — otherwise the zeros read as an empty truck.

### D4 — Search, and the URL is the state

Case-insensitive substring search over `external_haul_id`, `transporter_name`,
`collection_site`, `collection_source` — the four handles an operator actually
has (a haul number off a BOL, a carrier name on a door, a site name on a manifest).

View state lives entirely in `?q=&page=&undated=`, serialized by
`src/app/operator/[site]/hauls/list-url.ts`, a deliberate sibling of the
`admin/equipment` module per ADR-0063 D5 rather than a premature generalisation.
On a **shared iPad** this matters more than on a desktop: an operator hands the
device to the next shift mid-search, and the screen must be reproducible from what
is on it. Page size is 50 and **server-fixed** — a client cannot widen it.

### D5 — Read-only. Synthesizing an `InboundLoad` is FORBIDDEN

The surface writes nothing. A row renders a check-in affordance **only** when a
live (non-cancelled) `expected_loads` sibling already exists, in which case it
reuses the existing `QueueRow` / `startLoadAction` path — the same gated,
audited code the queue uses. Every other row renders read-only with **no control
at all**.

Making an unbridged mirror row "actionable" would mean minting an `ExpectedLoad`
(or worse, an `InboundLoad`) from a read screen. That is a billing record. It
would bypass the ADR-0059 bridge, invent a provisional the bridge would later
duplicate, and put units into the inventory ledger on the strength of a tap.
`portal-hauls.test.ts` case (f) pins the null.

### D6 — Its own rollout gate, `ipad_hauls`, born pilot

Registered in `UI_SURFACE` (`src/lib/notify/rollout.ts`), seeded per site by
migration `20260826_adr0074_ipad_hauls_surface` and by `prisma/seed.mjs`, both
idempotent.

Born **`pilot`** per ADR-0047 decision #3, with no deviation. ADR-0065's migration
deviated from born-pilot because it was retrofitting gates over surfaces that were
already live to operators, and seeding those `pilot` would have taken working
screens away. That reasoning does not apply here: this is 7,280 previously
invisible rows reaching the floor for the first time. There is nothing working
today that `pilot` takes away.

Its own row — not `ipad_queue` — so Bill can ramp Woodland (the only site with a
feed) without touching the actionable dock queue, and pull it back without taking
the queue down with it. Gated off, the page degrades to the already-translated
"not turned on yet" block **below a rendered heading**, with the chrome's back and
Log Out intact: never a 404, never a throw, never a dead end.

### D7 — Auth is unchanged

`checkOperatorForSite` — the same guard every floor page uses. The site id is
derived **server-side** from the session; the `[site]` path segment is never
trusted as a data scope. ADR-0030 single-site operators only; there is no
`all_sites` path on the floor, and this ADR does not create one.

`'hauls'` is added to `WORK_SEGMENTS` in `floor-nav.ts`. Omitting it would resolve
the route as a user id — a pre-PIN auth surface with black chrome, no back and no
Log Out.

---

## Alternatives considered

- **Widen `/queue` instead of adding a screen.** Rejected. The queue is the
  actionable dock surface; every row on it is a promise that tapping does
  something. Mixing 7,280 look-only rows into it destroys that contract and
  reintroduces the historical-browsing risk on a screen that writes.
- **List `expected_loads` unbounded (drop the day filter there).** Rejected.
  Reaches 718 rows, not 7,285 — it still cannot answer "is this haul number
  ours?" for 90% of the portal — and it loosens the day bound on the surface where
  the bound is protecting writes.
- **Show `Confirmed` hauls only.** Rejected. 19 rows. It answers "what is coming"
  and nothing else; the directive says _any_ pending haul **or load**, and an
  operator's commonest question is about a haul already delivered.
- **Filter out `disappeared_at`.** Rejected, emphatically — see D2. It looks like
  hygiene and deletes 87% of the delivered hauls.
- **Sort undated rows first (they "need attention").** Rejected. They are an
  upstream data gap, not a work queue; putting 3,316 of them above every real
  appointment makes the default view useless. They get a chip instead.
- **Build it on the manager desktop instead.** Rejected. It solves the wrong
  person's problem: the operator with the truck at the door is the one who cannot
  answer the question, and routing them through a manager is the paper process
  this product replaces.
- **Ship it ungated.** Rejected. ADR-0047 #3 exists for exactly this — new
  staff-visible output ramps on Bill's word, not a deploy's.

---

## Consequences

- The floor iPad goes from **5** visible portal hauls to **7,280**, searchable and
  newest-first, at Bill's flip.
- **ADR-0065 D5 now means, precisely:** the _actionable_ queue and every _write_
  are current-Pacific-day scoped. Reading the portal catalogue is not. Both halves
  of that sentence should be quoted together in future work.
- **One new index**, `mymrc_hauls_mirror_site_docking_idx` on
  `(site_id, docking_appointment_date DESC)`, additive and `IF NOT EXISTS`. The
  site-only index left the sort unindexed on a table that grows forever.
- **Money safety is unchanged by construction.** No write path was touched, no
  guard was relaxed, no aggregate row can originate here.
- **Accepted residual — the 3,316 undated hauls are now VISIBLE, not FIXED.** This
  surface makes an upstream MyMRC gap legible to the floor for the first time
  (`Docking_Appointment_Date__c` arrives as JSON `null` with the companion time
  field as the empty template — ADR-0070's finding, measured again here at 3,316).
  Operators will ask about them. That is the correct outcome of making a gap
  visible; closing it is an operational chase with MRC, not a code change.
- **Accepted residual — Eugene renders an honest empty state.** No portal feed
  exists for that site. Nothing is broken; the screen says so.
- **Operator action outstanding (OPEN-ITEMS O-6):** Bill flips `ipad_hauls` to
  `live` at `/admin/rollout` once the migration has run. Until then the surface
  degrades honestly rather than appearing.

---

## Amendment 1 (2026-08-10) — the check-in affordance needs THREE conditions, and "Coming up" is day-bounded

**Status:** Accepted. Amends **D3** and **D5**. Nothing in D1, D2, D4, D6 or D7
changes, and no write guard anywhere is relaxed.

D5 offered the check-in affordance on a single test — _"a live (non-cancelled)
`expected_loads` sibling already exists"_ — and D3 made the pinned "Coming up"
block deliberately unbounded in time. Each was defensible alone. Together they
produced an unbounded, unguarded route into a billing write, and it cost the
Woodland floor a morning eight days after this ADR shipped.

### What happened

All times Pacific. Every fact below was re-verified against `dr3_vision` on
CHAD-HQ on 2026-08-10 before this amendment was written.

| When                   | What                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-03 16:57       | `ipad_hauls` flipped to `live` for Woodland (D6 / OPEN-ITEMS O-6).                                                                                                                                                                                                                                                                             |
| 2026-08-03 **17:01**   | **Four minutes later**, an operator tapped the "Coming up" card for **H-134743** (Santa Rita Jail, appointment **2026-08-10 15:00**) and started it — **seven days early**. Nothing refused it: the block is unbounded (D3) and the sibling was live and uncancelled (D5).                                                                     |
| 2026-08-05 15:10–16:48 | The load was worked as though it were the truck on the dock, and `submitted` with **159 units** — against the wrong haul number.                                                                                                                                                                                                               |
| 2026-08-10 (morning)   | The **real** Santa Rita truck arrived. Every tap on its card routed into the Aug-3 load, because `startInboundLoad` is idempotent on `expected_load_id`. The load page rendered the `submitted` terminal branch — one paragraph, no controls, no navigation — and the held-by panel showed a disabled takeover under the label **"Counting"**. |
| 2026-08-10 15:42       | Floor unblocked by an audited manual DB detach, `audit_log.actor_label = 'system:santa-rita-detach'`, leaving load `2b60d7ba` orphaned with its 159 units.                                                                                                                                                                                     |

### The idempotency is NOT the bug

`startInboundLoad` returning the existing child (`src/lib/load-service.ts`) is
**correct and untouched**. It is what stops two operators tapping one truck from
minting two billing records, and ADR-0082 depends on it. Its consequence is that
a tap on a consumed slot cannot fail loudly — it succeeds, quietly, into somebody
else's finished work. So the refusal has to happen where the affordance is
**offered**, and it has to be able to say why. That is the same rule ADR-0082
applied to `takeable`: never show a control whose only outcome is a refusal.

### D5 amended — three conditions, not one

A row carries a check-in target only when **all three** hold:

1. a live (non-cancelled) `expected_loads` sibling exists — _unchanged_;
2. that sibling has **no `inbound_loads` child** — _new_;
3. its `expected_arrival_at` falls in the **current Pacific day** — _new, see
   below_.

A row failing any of them is **still listed**, carrying the reason: "already
worked — 159 units, submitted 5 Aug", "already started by another operator", or
the existing view-only treatment with the appointment date already on the body.
Dropping such rows was rejected outright — an operator standing next to a truck
that has vanished from their screen learns nothing, which is the exact silence
ADR-0065 Amendment 1 and ADR-0082 were both written to end.

Condition 2 is implemented once, in `src/lib/loads/consumed-slot.ts`, and read by
**both** check-in surfaces. They were independently blind to the same thing and
the code was not shared; fixing one would have left the other.

### D3 amended — "Coming up" is time-bounded FOR CHECK-IN ONLY

**Decision: yes, bound it.** The affordance is gated on the sibling's
`expected_arrival_at` falling inside `currentPacificDayWindow` — the same column,
the same window and the same helper `/operator/[site]/queue` already used. The
block itself stays unbounded: every scheduled haul is still **listed**, at any
horizon. Only the **button** is day-scoped.

Four reasons:

1. **Condition 2 alone does not close the incident.** It makes the second tap
   honest; it leaves the **first** one — 2026-08-03, seven days early — exactly
   as acceptable as it was on the day. The mis-attribution of 159 units is the
   money defect, and only the day bound prevents it recurring.
2. **It makes D5's own claim true.** D5 says the affordance "reuses the existing
   `QueueRow` / `startLoadAction` path — the same gated, audited code the queue
   uses". True of the code, false of the scope: the queue's day-scoping lives in
   its **query**, not in `QueueRow` and not in `startLoadAction`. This surface
   reused the components and silently dropped the bound.
3. **Starting a load is a WRITE.** ADR-0065 D5 and this ADR's own "not a
   re-litigation" section draw the line in one place: _looking_ is unrationed,
   _acting_ is current-day. `startInboundLoad` mints an `inbound_loads` row that
   feeds inventory and billing. It belongs on the acting side of that line. This
   ADR claimed to touch no write guard; it inadvertently created a route around
   one.
4. **Undated siblings fall on the refusing side.** 3,316 mirror rows carry no
   date (D3). A NULL appointment cannot be _proven_ to be today, and the queue —
   bounded on the same column — never offered them.

#### The alternative, and why it was rejected

**Leave "Coming up" unbounded and rely on condition 2 alone.** The argument is
real and was weighed seriously: trucks arrive early, MyMRC appointment data
drifts, and refusing check-in for a truck **physically on the dock** blocks the
floor — which is precisely the harm this amendment exists to undo. Rejected on
four grounds:

- **This restores the status quo ante, it does not add a restriction.** The queue
  has never offered a future-day check-in. The floor ran for months without one.
  ADR-0074 is a **read** ADR; it created this capability inadvertently, as a side
  effect of reusing `QueueRow`, not by a decision anyone made.
- **The two failure modes are not symmetric.** Over-permissive fails **silently
  and expensively**: 159 units booked to the wrong haul, undetected for seven
  days, resolved only by a hand-written `UPDATE` against production.
  Over-restrictive fails **loudly and immediately** — an operator says "it won't
  let me check this in" — and has an upstream fix (correct the appointment in
  MyMRC; the ADR-0059 bridge re-syncs).
- **An early truck is an appointment-data problem**, not a UI problem, and
  answering it by widening a write path is how the data stays wrong.
- **The row still renders**, with its appointment date. The operator learns
  _"this is due Wednesday"_, not _"this haul does not exist"_.

**Accepted residual:** a genuinely early truck cannot be checked in from the iPad
and needs its MyMRC appointment corrected first. Recorded as a watch item in
`docs/OPEN-ITEMS.md` §0.AV; if the floor hits it in practice, the answer is a
manager-scoped override, not re-widening the floor surface.

#### Deliberately NOT day-bounded: the server action

The bound is enforced in the **read/render** layer of both surfaces, not inside
`startLoadAction` / `startInboundLoad`. Two reasons, and one honest residual:

- The write path is shared with the **offline queue**. A load started at 23:58 PT
  and replayed after reconnect at 00:02 PT would be refused by a naive
  server-side day check — turning a captured, legitimate check-in into a lost
  one. ADR-0078's replay semantics would have to be settled first.
- `startInboundLoad` is explicitly out of scope here; it is correct, and ADR-0082
  depends on its current behaviour.

**Residual, stated plainly:** this is therefore a UI-layer guard. An authenticated
operator issuing a crafted server-action invocation with an arbitrary
`expected_load_id` for their own site could still start a future-dated load. No
surface offers it and no ordinary path reaches it, but ADR-0065 Amendment 1's
"defense in depth, not a replacement" principle argues the write should assert it
too. Recorded as an open decision for Bill in `docs/OPEN-ITEMS.md` §0.AV rather
than shipped unilaterally, because the offline-replay interaction above makes it
a behaviour change, not a hardening.

### Two more defects the incident exposed, both fixed here

- **`load-workflow.tsx` — the terminal branch was a dead end that promised a
  navigation.** It rendered `"Load {{status}}. Returning to the name picker…"` and
  then returned nowhere: no link, no button, no redirect, no timer, in three
  locales. It was justified as _"defensive — the submit/reject actions sign the
  operator out and redirect, so reaching here is rare."_ False in the way that
  mattered: it is reachable **without submitting anything**, which is exactly how
  the Santa Rita operator reached it on every tap. A dead end with reassuring
  copy is worse than a bare one — it tells the operator to **wait** rather than
  to act. Now renders a real link to the queue; the promise key
  `workflow.load_done_returning` is **deleted**, not merely unused.
- **`held-by-panel.tsx` — `STATUS_KEY` mislabelled every terminal status
  "Counting".** The map held the five open dock statuses and fell back to
  `queue.open_status_in_progress`. Because `takeable` is computed from
  `TAKEOVER_STATUSES`, which correctly **excludes** those statuses, the panel
  showed simultaneously: a holder's name, the word "Counting", and a disabled
  takeover. The only available reading was "a colleague is working this and I am
  locked out"; the truth was "this was finished five days ago". All eleven
  `LoadStatus` values now have distinct labels, and the fallback is
  `queue.open_status_unknown` — a confident wrong answer being the failure mode
  under repair.

### Consequences

- **The four remaining early-started loads are NOT touched by this change**, in
  code or in data. Two have appointments still ahead of them (H-136912,
  H-136583); both are recorded in OPEN-ITEMS §0.AV as watch items. A second
  manual detach is a decision for Bill, not a side effect of a bug fix.
- **New shared module** `src/lib/loads/consumed-slot.ts`, with a structural test
  asserting that **every** check-in surface selects the child and routes through
  it. Adding a third surface that skips it is how this defect returns.
- **Three new copy keys** in `floor.common` (en/es/ur, hard rule #4) plus seven
  new `queue.open_status_*` labels; one key removed.
- **No migration, no schema change, no new index.** `expected_loads.inbound_load`
  is an existing relation on an existing unique key.
- **Money safety improves in one direction only.** Nothing that was startable and
  correct became unstartable: a live, unconsumed sibling due today behaves
  exactly as before, and that case is pinned by an explicit control test in
  `portal-hauls.test.ts` ("an UNCONSUMED sibling whose appointment is today still
  gets the button") — a fix that removed every button would have replaced one
  outage with another.
