# ADR-0079 — Terex daily throughput is CAPTURED, not derived

**Status:** Accepted, implemented (2026-08-07; Amendment 1 same day). Supersedes ADR-0044 D2.

**Supersedes:** ADR-0044 D2 ("throughput needs NO new capture — it is DERIVED from
the daily processed-units close"). Builds on ADR-0077 D4 ("not recorded" is not
zero) and ADR-0077 D1/Am.1 (the machine is resolved from the registry, by
evidence, never by a literal id).

---

## Context

Bill flagged that Terex units-processed tracking was wrong. The number _existed_,
which is what made it hard to see: ADR-0044 D2 computed the Terex's throughput as

```
units/day = stripped_program + stripped_non_program
```

from `processed_units_daily` — **the whole floor's output, attributed to one
machine.** ADR-0044's reasoning was that a second entry path would recreate the
two-artifact drift class, and that reasoning was sound about a _different_
problem. This was never two artifacts of one fact. It was a **different fact
wearing the machine's name.**

Production says how different. Woodland's derived "Terex" days, read from
`processed_units_daily` on 2026-08-07:

| Day        | program | non-program | derived "Terex" units |
| ---------- | ------- | ----------- | --------------------- |
| 2026-08-06 | 769     | 294         | **1,063**             |
| 2026-08-05 | 1,045   | 0           | **1,045**             |
| 2026-08-04 | 984     | 79          | **1,063**             |
| 2026-07-29 | 826     | 423         | **1,249**             |

That is every machine and every hand-stripper on the floor. The number cannot
distinguish the Terex from anything else, and no amount of care downstream can
recover an attribution the input never had.

Three specific defects followed:

1. **It cannot tell the machine from the floor.** Hand-stripping, a second
   machine, a good day at a different station — all of it lands in the Terex's
   column.
2. **It does not replace the sheet.** The paper sheet DR3-Vision exists to
   replace carried an _authoritative, manager-entered_ Terex number, daily.
   Bill's requirement, verbatim in intent: _"we have to have the manager able to
   enter the terex processing numbers daily to populate the data — remember we
   are replacing the sheet."_
3. **Units-per-run-hour was computed against a guess.** The denominator was
   `assumed_day_hours − hours_down`, where `assumed_day_hours` is a module
   constant equal to 8. Worse, per ADR-0077 D4, `hours_down` is `NULL` on **all
   67 non-voided production Terex events** — the column has never once been
   written — so `unitsPerRunHour` returned `null` on literally every real day.
   The rate was not merely assumed; it was absent.

---

## D1 — The manager enters units processed AND run hours, daily

A manager records two figures for the machine each day: `units_processed` (a
non-negative integer) and `run_hours` (Decimal(5,2), `> 0`, `<= 24`).

Capturing **run hours** is the decisive half, and the reason to capture rather
than merely re-attribute. Units-per-hour finally divides by hours the machine
actually ran instead of by `8 − (a column nobody fills in)`. ADR-0077 already
observed that the workbook's monthly tabs carry `Day Total Hrs Used` — hours the
machine **ran** — so the figure exists in the real world; it simply had nowhere
to live in Vision.

The machine is resolved from the equipment registry by **ADR-0077's identity
rule**, never by a literal id:

```ts
where: { site_id, category: 'terex', is_active: true, merged_into_id: null,
         links: { some: {} } }
```

`category` alone is not the test — the ADR-0062 seed uses `terex` as the category
for SHEAR MACHINES, and production carries five `terex`-category rows of which
exactly one (`7e35a4aa`, Woodland, 4 AP links) is the machine. Eugene resolves to
`null` honestly, and a Terex arriving at Eugene tomorrow is picked up with no code
change. The canonical id appears nowhere in the source.

## D2 — A DEDICATED table, not a sixth `equipment_events` kind

The handoff offered two homes and asked for the choice to be verified against live
code. **Option B — a dedicated `equipment_daily_throughput` table — wins on three
findings, each read out of the running code rather than assumed.**

**1. `equipment_events` is many-rows-per-day by design.** Several downtime, repair
and cost rows legitimately share one date. "One entry per machine per day"
therefore cannot be a table-level unique there; it could only be a partial index
carving one kind out of a table whose entire invariant is the opposite.

**2. Three read paths query `equipment_events` with NO kind filter** and would
have silently absorbed a daily row:

| Path                                                      | What a `daily_throughput` kind would have done                                                                                      |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/equipment/tile.ts` `findFirst` (event_date desc) | A row written every working day becomes **"the LAST equipment event" permanently**, burying the downtime the tile exists to surface |
| `src/lib/equipment/service.ts` `listEquipmentEvents`      | ~250 rows/yr **flooding the maintenance log** a manager actually reads                                                              |
| `src/lib/equipment/terex-ledger.ts`                       | Selects `hours_down` with **no kind filter** and sums it into `downtime.totalHours`                                                 |

That third one is the sharp edge. The tempting reuse — carrying run hours in the
existing `hours_down` column — would have reported **the hours the machine RAN as
the hours it was DOWN.** That is ADR-0077's defect class inverted and strictly
worse: ADR-0077 mis-_rendered_ a missing measurement, whereas this would
**manufacture** one. (`src/lib/ops/equipment-provider.ts` is safe — both its
queries already filter, by `kind IN (...)` and by `cost_cents >=`.)

**3. `equipment_events` has no equipment foreign key at all.** `equipment_code` is
a free-text string defaulting to `'terex'` (ADR-0044 D1: "a second machine is a
data value, never a migration"). The requirement is uniqueness per **equipment
row** — which a typed string cannot express, and which the ADR-0075 merge
machinery (`merged_into_id`) depends on to stop a merged-away duplicate quietly
accumulating a parallel day-history.

Option A would also have needed a new enum value, two new columns meaningless on
all five existing kinds, a widened `assertEquipmentShape`, and a kind filter
retrofitted to three query sites. It was not the smaller change.

Putting `run_hours` and `hours_down` in **different tables** additionally means no
future query can confuse them. They are near-opposites and one of them has already
been mis-rendered once in production.

### The uniqueness guarantee

```sql
CREATE UNIQUE INDEX equipment_daily_throughput_machine_day_key
  ON equipment_daily_throughput (equipment_id, throughput_date)
  WHERE voided_at IS NULL;
```

**Partial** on `voided_at IS NULL` so a mistaken entry can be soft-voided and the
day re-entered; an unconditional unique would let a voided row hold the slot
forever and make a reversal unrecoverable.

Note carefully **which** column is nullable. The KEY columns `equipment_id` and
`throughput_date` are both `NOT NULL`; only the **predicate** reads a nullable
column. That distinction is the whole ballgame — a unique index whose _key_
includes a nullable column constrains nothing, because `NULL` never equals `NULL`,
and every row slips past it. This index genuinely constrains, and it was **proved
by insertion against a real PG16**, not by reading the DDL:

```
--- 2. SECOND live row same machine+day: expect ERROR duplicate key
ERROR:  duplicate key value violates unique constraint
        "equipment_daily_throughput_machine_day_key"
--- 4. soft-void then re-enter the SAME day
UPDATE 1
INSERT 0 1
```

## D3 — Entered REPLACES derived; a missing day is "not recorded"

For the machine, `units/day` now reads the entered `units_processed` and
`units/run-hour` divides by the entered `run_hours`. The 8h assumption is off the
live path entirely: `run_hours` is `NOT NULL` and DB-checked `> 0`, so an entered
day always carries real hours.

**A day with no entry is `null` — never `0`, and never the derived floor number.**
This is ADR-0077 D4's discipline applied to units. The rolling 7/30-day means skip
unrecorded days rather than averaging in a zero (behaviour that already existed
and is preserved). Every display surface says "not recorded" in a neutral tone:
the equipment summary tiles, and both throughput cards on the ops overview — which
previously showed `—` and, before that, the floor's number.

Three failure modes were possible here and two of them look completely reasonable
on screen. Rendering `0` makes a working machine look broken. Falling back to the
derived total makes it look like a hero and makes the office believe a figure
nobody entered. Only the third — saying nothing, out loud — is honest.

**The guard was falsified rather than trusted.** The derived fallback was
deliberately wired back in and the suite re-run; the failures name the real wrong
value:

```
AssertionError: expected 1063 to be null
- Expected:  null
+ Received:  1063
```

Three tests went red, each naming `1063` — the actual Woodland floor total — not
an `undefined` that would have proved only that a field was missing. The fixtures
use production magnitudes precisely so that a regression is legible as _the floor
number came back_, not as an abstract type error.

## D4 — Same-day is free; a prior day is REFUSED, and the amendment workflow could not be reused

**Same-day:** the manager enters and edits today's figures freely. Every write is
audited with both `before` and `after`; there is no hard delete, only soft-void.
"Today" is the **Pacific** day (`appToday()`), consistent with ADR-0065.

**Prior-day:** refused with `409 requires_amendment`, carrying the target date,
today's date, what is on record, and what was proposed — so the refusal can say
what it is declining to change. Nothing is written: no row, and no audit row
claiming one.

The handoff asked for prior-day edits to route through "the existing bonus
amendment workflow". **They cannot, and the blocker is structural.** The
investigation is recorded as OPEN-ITEMS **F-2**; the decisive findings:

- **`resolveAmendmentApprover` throws `AmendmentWorkflowForbiddenError` for any
  requester who is not a bonus payroll signer**, because it sources the approver
  from `bonus_signature_chains` — the payroll PDF dual-signature roster. A
  Woodland equipment manager is not necessarily one. Routing equipment through it
  would hand _the exact audience this feature is for_ a 403 they could do nothing
  about.
- `bonus_amendment_requests` carries two `NOT NULL` FKs to bonus-specific tables
  (`bonus_pay_periods`, `bonus_employees`) with `ON DELETE RESTRICT`, and there is
  **no** polymorphic targeting — no `subject_type`, no generic `row_id`.
- `applyApprovalInTx` writes `tx.bonusDailyEntry` literally, with no dispatch
  point, no strategy and no writer interface.
- The handoff's premise that this pattern already had two consumers is **false**.
  There is exactly one. `shouldRequireAmendment` has a single non-test importer
  (`src/lib/bonus/daily-entry.ts`), and `processed_units_daily` — the presumed
  second — uses a _lock_, not a four-eyes gate ("That day is already closed and
  locked — ask Bill to run the amendment path"). The word "amendment" across ~40
  files is overwhelmingly ADR-revision naming ("ADR-0077 Amendment 1").

Forking a parallel four-eyes system for one field was explicitly out of scope, and
silently accepting backdated changes to a compliance-adjacent number was never an
option. So this **refuses, visibly**, and names the office as the route. The 409
body deliberately mirrors the bonus shape so the eventual generalization is a swap
rather than a rewrite.

## D5 — The derived number is RETAINED as a latent cross-check

The floor-wide total is still computed and carried on every day point as
`derivedFloorUnits`, and the superseded rate survives as the exported
`legacyDerivedUnitsPerRunHour`. Neither is rendered as throughput. The CSV export
carries the column named for what it actually is —
`derived_floor_units_all_sources` — because an export column called `units_day`
would re-tell the exact lie the tile used to tell.

**No divergence rules in v1.** A manager entering 40 units on a day the floor
stripped 400 is either a light Terex day or a data-entry error, and telling those
apart needs a rule that does not exist yet — that is reconciliation-layer work and
is blocked on Kelsey's method. The input is kept so the cross-check is _buildable_
the day the rule exists; the rule is not guessed at now.

## D6 — The entry control rides `equipment_entry`, not a new gate

The daily-entry control ships on the existing `equipment_entry` rollout surface,
which is already **live at Woodland** and pilot at Eugene (verified in production
2026-08-07).

ADR-0047's born-pilot default protects an audience from output it has not seen
before. This audience is _the identical one_ already entering equipment events on
_this exact screen_. A new gate would have hidden the replacement for the sheet
from precisely the managers being asked to stop using the sheet — ADR-0047's
mechanism used against ADR-0047's purpose. Born-pilot applies to a **new**
surface; this adds a control to a live one.

Eugene is unaffected either way: it has **zero** `equipment_events` and **zero**
`processed_units_daily` rows, so its chart was already empty and nothing there
changes.

---

## Amendment 1 (2026-08-07) — the cutover has a boundary, and history stays

**D3 was right about the future and wrong about the past.** "Entered replaces
derived" was applied to _all of history_, so the moment this shipped the Terex
page went blank. Measured against production the same day:

```
WINDOW 90d : entered=0/90 days | derived AVAILABLE=67/90 days
90d window: 67 days carry a derived figure that is currently RENDERED BLANK.
derived range in window: 415 .. 1249
```

989 close-days exist at Woodland going back to 2023-01-02. Bill's report:
_"that should have all stayed and just been added to."_ He is right. The original
ADR even **predicted** this behaviour and called it "the visible signature of the
fix" — but predicting a consequence is not the same as validating it, and nobody
checked whether a blank history was what was wanted. It was not.

No data was lost; `derivedFloorUnits` remained computed throughout (D5). This is
purely cutover-DISPLAY semantics.

### D7 — the boundary is a stored constant, never derived from the data

`TEREX_CAPTURE_CUTOVER_ISO = '2026-08-07'`. Days before it are the sheet era; days
from it on are the capture era.

Deriving the boundary from "the first entered day" was rejected: one manager
backfilling 2026-07-15 would flip every day from mid-July onward out of the legacy
era into "not recorded", **blanking a month of chart as a side effect of a single
entry**. The boundary is a fact about when the process changed, not about the
contents of the table. `cutover.boundary-is-constant-not-data` inserts an earlier
entered row and asserts every other day's source is byte-identical.

### D8 — per-day source honesty

`source: 'entered' | 'legacy_derived' | 'not_recorded'` travels on every point, so
provenance is carried rather than re-inferred (and re-inferred differently) at each
render site.

| Day       | Entry? | Source           | Displays                                                                 |
| --------- | ------ | ---------------- | ------------------------------------------------------------------------ |
| ≥ cutover | yes    | `entered`        | the manager's figure                                                     |
| ≥ cutover | no     | `not_recorded`   | **nothing** — `derivedFloorUnits` is NOT substituted; the gap stays loud |
| < cutover | no     | `legacy_derived` | `derivedFloorUnits`, **labeled** floor-wide                              |
| < cutover | yes    | `entered`        | the manager's figure — **entered always wins**                           |

Entered winning on _both_ sides of the boundary is Bill's "just be added to": a
backfill has replaced the floor's guess with the machine's real number, and must
beat the legacy figure rather than be ignored for being early.

### D9 — the label is STRUCTURAL, not tonal

A legacy bar is hollow: `fill="url(#legacyHatch)"` over a dashed outline. An
entered bar is solid `#8fbf3f`. **Solid always means entered.**

Tone was rejected as the carrier — a lighter green or a lower opacity does not
survive a projector, a screenshot, a colour-blind reader, or a print-out, and the
one thing this must never do is let the floor's number pass as the machine's.
Alongside the bars: an always-visible legend whenever any legacy bar renders (not
a tooltip — a reader who never touches the chart must still be told), and a
per-bar `<title>`: `2026-07-20: 1063 units — floor-wide total, not Terex-specific
(legacy)`.

The axis fix is the literal reported bug: `maxUnits` scaled off `unitsDay` alone,
so with zero entered days it collapsed to `1`. It now scales to what is **drawn**.

### D10 — means never blend across the era

`mean7`/`mean30` and the tile's `last7`/`last30` stay **entered-only, unchanged**.
`legacyMean7`/`legacyMean30` are separate fields over legacy days only, rendered
only _on_ legacy days so the dashed legacy line stops at the boundary.

The two eras measure different things — the whole floor (1,000–1,250 units/day)
versus one machine (a few hundred). A straddling window would average them into a
figure describing nothing, plotted on the machine's line. In the seven-day
straddle test the forbidden blend is **701.28**; it is asserted absent from every
mean field on every day.

The tile was deliberately NOT widened to include legacy days: a single averaged
number has nowhere to carry the label. "7-day units/day: 1,063" on a tile is a
bare claim about the machine, wrong by roughly 5×. The chart is where the legacy
era is shown, because that is where it can be shown honestly. The tiles instead
disclose coverage — "1 of 7 days recorded".

### D11 — a legacy day still gets no rate

`unitsPerRunHour` stays `null` for legacy days. Reviving the assumed-8h figure,
even labeled, would publish a number whose denominator was fabricated — the exact
defect D3 removed. `rate.legacy-has-no-rate` pins that `1063 / 8 = 132.875` never
appears.

### Rejected in this amendment

- **(c) Labeled backfill of derived figures into `equipment_daily_throughput`.**
  Putting the floor's number inside the machine's table is a permanent conflation
  risk — every future reader and query would have to remember the flag — and it
  would force `run_hours` to become nullable, weakening the NOT NULL constraint
  that makes units-per-hour trustworthy.
- **(b) A dual-series view** (entered and derived plotted together as peers).
  Filed as the future reconciliation view (OPEN-ITEMS F-3), not built: showing
  them as peers invites exactly the divergence comparison that still has no rule.

### The falsification

The bar renderer's source branch was deleted and the suite re-run. The red shows a
legacy bar wearing the entered fill:

```
AssertionError: expected '<rect data-testid="bar-2026-07-20" da…'
                to contain 'fill="url(#legacyHatch)"'
Received: "<rect data-testid="bar-2026-07-20" data-source="legacy_derived"
           x="64" y="8" width="192" height="170" fill="#8fbf3f"
           stroke="none" stroke-width="0" opacity="0.85">"
```

`data-source="legacy_derived"` with `fill="#8fbf3f"` — the unlabeled leak, named
concretely rather than as a missing field.

### Verified against production

67 legacy days restored to the chart; July days draw 1,158–1,249 with `unitsDay`
still `null` (not laundered) and `rate` still `null` (no fabricated denominator);
the one post-cutover day stays `not_recorded`; no day carries both means; no
`not_recorded` day carries a units figure.

## Alternatives considered

**Extend `equipment_events` with a `daily_throughput` kind (Option A).** Rejected
on the three findings in D2 — chiefly that three unfiltered read paths would have
absorbed the rows, and that carrying run hours in `hours_down` would report run
time as downtime. Reusing the column was the single most dangerous option
available and the most superficially attractive.

**Reuse `bonus_amendment_requests` for prior-day equipment edits.** Rejected: the
approver source 403s non-payroll-signers, and the table has two `NOT NULL`
bonus FKs with no polymorphic targeting. See D4 and OPEN-ITEMS F-2.

**Fork a parallel equipment amendment workflow.** Rejected as out of scope and as
the wrong shape — a second four-eyes system for one field, guaranteeing the two
drift apart. Refusing loudly and reporting the generalization gap is the smaller,
honest move.

**Keep deriving and merely relabel the tile ("floor throughput").** Rejected: it
does not replace the sheet, and it leaves units-per-hour computed against an
assumption. Bill asked for the machine's number, not a better caption.

**Backfill history from the derived series.** Rejected outright. Every backfilled
day would be a fabricated manager entry, indistinguishable from a real one, in a
table whose entire purpose is that the number is authoritative. Days before this
table existed have no manager entry and read "not recorded" — which is true.

**Unconditional unique on (equipment_id, throughput_date).** Rejected: a voided
row would hold the day forever, making a mistaken entry permanent.

---

## Consequences

- Woodland managers gain a daily two-field entry on `/dashboard/[site]/equipment`;
  the throughput chart, the summary tiles and the ops-overview cards all read it.
- Until a manager enters a day, that day reads **"not recorded"**. On the day this
  ships, _every_ day reads "not recorded" — the tile will show no number at all
  until the first entry. That is deliberate and is the visible signature of the
  fix: a blank day can never again be mistaken for a real low, and a floor-wide
  total can never again be mistaken for one machine's work.
- Units-per-run-hour becomes meaningful for the first time. It previously returned
  `null` on every production day.
- Prior-day corrections require the office until the amendment workflow is
  generalized (OPEN-ITEMS F-2). Managers see an explicit message, not a silent
  failure and not a silent acceptance.
- `ASSUMED_DAY_HOURS` remains exported and labeled but is off the live path. It is
  retained rather than deleted because the derived series it belongs to is
  retained (D5), and because removing a number the UI has been showing in the same
  change that moves the number it qualifies would make two changes look like one.
- The equipment registry gains a real dependent: `ON DELETE RESTRICT` means a
  machine with recorded days cannot be deleted (verified against PG16).
