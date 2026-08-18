# ADR-0107 — Start and End hours, and run hours stop being typed

**Status:** Accepted, implemented (2026-08-18). Amends ADR-0079 D1, which made
`run_hours` a manager-entered figure. Stacked on ADR-0106.

**Builds on:** ADR-0079 (the daily capture), ADR-0081 (the workbook import and
the `source` discriminator), ADR-0077 D4 ("not recorded" is not zero).

---

## Context

ADR-0079 D1 had the manager enter two figures a day: `units_processed` and
`run_hours`. Capturing run hours was the decisive half of that ADR — it replaced
a denominator that was `8 − (a column nobody fills in)` with a measurement.

But the sheet it replaces does not record a duration. It records **two meter
readings**, and computes the duration from them. Vision captured the answer and
threw away the question, which means:

1. **Nothing could check the subtraction.** A typed `6.5` is unfalsifiable. If
   the operator read the meter as 2,798.5 → 2,805 and keyed `8.5`, no layer in
   the system could tell.
2. **Vision did not hold what the sheet holds**, so the sheet could not be
   retired. `Start Hours` and `End Hours` are two of its nine columns.
3. **The carry-forward was invisible.** Each day's Start is the prior day's End
   — the machine's own continuity — and that relationship had no representation.

## D1 — The RESOLVED question: these are hour METERS, not clock times

The handoff required this be settled before building, because both readings are
plausible: "Start 7.5, End 15.5" could be a shift, and "Start 2,462.75" could
not. The answer is **cumulative hour-meter readings**, and it is settled from two
independent directions.

**Measured against the live workbook (2026-08-18):**

| Tab     | Start    | End      | Shape                                         |
| ------- | -------- | -------- | --------------------------------------------- |
| `Jul26` | 2,462.75 | 2,608.05 | climbs monotonically across the month         |
| `Aug26` | 2,685    | 2,804.8  | continues from where the prior month left off |

Daily deltas land at ~6–12 h. A clock time cannot read 2,462.75, and a month's
worth of clock times does not accumulate. Each day's Start is not typed at all:
it is a **formula** pointing at the row above (`=F<prev>`), and at the month
boundary it reaches into the previous tab (`='Jul26'!F33`).

**Corroborated by this repo's own extractor**, written before this ADR and
against the real workbook. `src/lib/doc-ingest/terex-monthly-extract.ts` types
the fields as _"Hour-meter readings, carried for the report only"_ — and, more
usefully, records that the OTHER shape also exists in the workbook's history:

> `Nov24` and `Dec24` are two more shapes again, one of them carrying
> `Start Time`/`End Time` **clock times rather than hour-meter readings**.

So the honest resolution is not "the sheet uses meters" but **"the sheet has used
both, and the tabs this product mirrors (2025–2026 monthly) are meters."** The
2024 tabs are already out of scope for the extractor for exactly this kind of
schema divergence. Anyone reviving them must not assume this ADR's model.

That same file also refuses to derive hours from `End − Start` when reading the
sheet, on the grounds that re-deriving would "quietly manufacture hours on the
rows where the operator left the formula un-filled". That refusal is about
_reading history_. This ADR is about _new capture_, where both readings are
required, so the difference is never manufactured — it is the only thing there is.

## D2 — Two columns, additive, and NOT backfilled

`start_hours` and `end_hours`, `Decimal(8,2)`, both **nullable**.

**Nullable, and never backfilled.** Every existing row keeps its `run_hours` with
NULL meters. `run_hours` is a DIFFERENCE, and a difference does not determine the
pair it came from: writing `0 → 6.5` would put two fabricated meter readings into
the table, indistinguishable from real ones, and the next day's carry-forward
would then propagate the fiction. ADR-0079 already rejected exactly this move
("Backfill history from the derived series. Rejected outright"). A NULL meter is
true: nobody wrote the reading down.

Nullability is also what keeps the ADR-0081 importer working — it projects sheet
rows whose meter cells are legitimately blank, and `NOT NULL` would convert an
honest gap into a failed import. **Requiredness for MANAGER entry is enforced in
the service**, which is where the distinction between a person and a projection
lives.

**`Decimal(8,2)`, wider than `run_hours`'s `(5,2)`.** `run_hours` is bounded by
24; a meter is cumulative and only climbs. The machine reads ~2,805 h and accrues
~1,400 h/yr, so a `(6,2)` ceiling of 9,999.99 arrives inside this asset's service
life. A column that overflows in five years is a defect with a delivery date.

## D3 — `run_hours` is DERIVED, and the hand-entry path is REMOVED

`run_hours = end_hours − start_hours`, computed in `assertDailyThroughputShape`,
stored, and no longer accepted as an input anywhere.

Removed rather than ignored, at all three layers:

- **The service** throws if `'runHours' in args`. TypeScript drops it from the
  argument type, but a JS caller can still send it, and silently discarding it
  would let that caller believe it had set the hours while the derivation
  overrode them.
- **The route's** zod schema is `.strict()`, so a client still posting `runHours`
  gets a `422` instead of a silently ignored field.
- **The UI** no longer has the input. It shows the figure as a read-out —
  "Run hours (calculated)" — rather than hiding it, so the change reads as _we
  compute this for you_ and not as _we removed it_.

Leaving the box on screen while the server derived the value would reintroduce
ADR-0079's own defect class: two artifacts of one fact, disagreeing.

### The bounds

- **`end > start`.** The machine does not run overnight, so an End at or below
  the Start is a keying error — a transposed pair, or yesterday's End typed into
  both boxes — never a short day.
- **`0 < run_hours <= 24`**, ADR-0079 D1's bound, now applied to a derived value.
  It catches a mis-keyed METER (`2,830` for `2,803`) instead of a mis-keyed
  duration.

Both readings are **rounded to the stored scale before being compared**. Comparing
raw floats and rounding afterwards would admit a pair that is ordered at full
precision but equal once stored — the row would then violate the `end > start`
CHECK it had just been told it satisfied. `2800.001 → 2800.002` is refused for
this reason, and the test says so.

## D4 — Start PRE-FILLS from the previous day's End

Entering a day fetches `previousEndHours(site, day)` — the nearest EARLIER
recorded day that has a meter — and fills Start with it. Editable, still required.

This is the sheet's own model expressed as a query rather than a formula. Two
details are load-bearing:

- **Nearest earlier DAY, not highest reading.** A machine serviced or replaced
  mid-month can read lower than an older row, so ordering by the reading would
  carry a stale meter forward.
- **Legacy days prefill NOTHING.** Rows with NULL meters are excluded rather than
  read as zero, so a pre-ADR-0107 day seeds nothing instead of seeding a
  fabricated `0` — the no-backfill rule (D2) applied to the UI.

The rule is computed **server-side** and returned by `GET ?forDate=`, not
re-derived in the browser from the fetched rows. One rule, one implementation; a
second copy in the client is how the prefill and the stored history begin to
disagree.

## D5 — Four CHECKs, proved by insertion against a real PG16

The service is not the only writer, so the invariants are in the table too
(ADR-0079 D2's reasoning: "the CHECK guards the table against a write path
nobody has written yet"):

| Constraint                    | Rule                                       |
| ----------------------------- | ------------------------------------------ |
| `meter_pair_complete`         | `(start IS NULL) = (end IS NULL)`          |
| `meter_end_after_start`       | `start IS NULL OR end > start`             |
| `meter_non_negative`          | `start IS NULL OR start >= 0`              |
| `run_hours_is_the_difference` | `start IS NULL OR run_hours = end - start` |

The last one is what stops the two representations from ever disagreeing in the
database. Verified by INSERT against a clean PostgreSQL 16 after
`prisma migrate deploy` — **including the positive controls**, because a
constraint test whose valid cases never landed proves only that something failed:

```
--- 1. VALID meter pair: 2798.50 -> 2805.00, run_hours 6.50 (expect INSERT 0 1)
INSERT 0 1
--- 2. End == Start
ERROR:  ... violates check constraint "equipment_daily_throughput_meter_end_after_start"
--- 3. End < Start, transposed pair
ERROR:  ... violates check constraint "equipment_daily_throughput_meter_end_after_start"
--- 4. run_hours DISAGREES with the difference
ERROR:  ... violates check constraint "equipment_daily_throughput_run_hours_is_the_difference"
--- 5. HALF a pair: end with no start
ERROR:  ... violates check constraint "equipment_daily_throughput_meter_pair_complete"
--- 6. derived difference > 24h
ERROR:  ... violates check constraint "equipment_daily_throughput_run_hours_sane"
--- 7. LEGACY row: run_hours with NULL meters (expect INSERT 0 1)
INSERT 0 1
--- 8. negative meter
ERROR:  ... violates check constraint "equipment_daily_throughput_meter_non_negative"
--- 9. what actually landed
 id | run_hours | start_hours | end_hours
----+-----------+-------------+-----------
 r1 |      6.50 |     2798.50 |   2805.00
 r7 |      5.00 |             |
```

`r7` is the point: the legacy shape is still writable, with its meters honestly
empty.

## D6 — The workbook importer is NOT wired to these columns yet

The ADR-0081 extractor already parses `startHours` / `endHours` and carries them
in `MonthlyDayRow`, and the importer already writes this table — so persisting
them looks like a two-line change. It is deliberately **not** made here.

`run_hours_is_the_difference` (D5) would refuse any sheet row whose own
`Day Total Hrs Used` does not equal `End − Start` to the cent. The extractor's
header comment states plainly that such rows exist — it refuses to derive hours
from the meter difference precisely because operators leave the day-total formula
un-filled on some rows, and the `Aug25(1)` draft tab even carries end-hour
readings written into the day-hours column. Wiring the importer without first
measuring that disagreement would either break the import on historical data or
force the CHECK to be weakened for every row, including the manager's.

Reconciling the sheet's stated day-total against its own meter difference is a
DATA question with a real answer to go and measure, not a code change to guess
at. Filed as a residual; the columns are ready for it.

## Alternatives considered

**Keep `run_hours` typed and add the meters as extra fields.** Rejected — this is
the two-artifacts-of-one-fact shape ADR-0079 D2 spent three findings avoiding.
Three numbers where two determine the third, with nothing forcing agreement.

**Derive `run_hours` but do not store it.** Rejected. Every read path
(`enteredThroughputByDay`, the tile, the series, the CSV, the gap watchdog)
consumes `run_hours`, and `run_hours` is `NOT NULL` — the column that makes
units-per-hour trustworthy (ADR-0079 D3). Dropping it to a computed expression
would rewrite six consumers to buy nothing, and would strand every legacy row,
which has hours but no pair to derive them from.

**Backfill `start=0, end=run_hours` on existing rows** so the columns are
`NOT NULL`. Rejected outright — see D2. It fabricates two readings per row and
the carry-forward would then propagate them.

**`Decimal(6,2)`.** Rejected on arithmetic: 9,999.99 is reached inside the
asset's service life at the observed ~1,400 h/yr.

**Enforce `end > start` only in the service.** Rejected. The importer and any
future writer reach this table without passing through
`assertDailyThroughputShape`, which is the same argument ADR-0079 made for its
own CHECKs.

**Compute the prefill in the browser from the already-fetched rows** (no extra
request). Rejected: it forks the "nearest earlier day with a meter" rule into two
implementations, and the client's copy sees only the fetched window.

---

## Consequences

- Vision now holds the sheet's `Start Hours`, `End Hours` and `Day Total Hrs
Used` — the last of these derived rather than copied. Those three columns can
  be retired from the workbook.
- A manager enters two meter readings; the run hours follow. Start arrives
  pre-filled from yesterday's End, which is what the sheet already does with a
  formula, so the entry is one field shorter in practice than it looks.
- A transposed or mis-keyed pair is refused with a message that names the two
  readings, instead of being stored as a plausible duration.
- Existing rows are unchanged and keep working: NULL meters, real `run_hours`,
  and the UI draws `—` rather than `0` for the readings that were never taken.
- `run_hours` can no longer be set by hand from anywhere — service, route or UI.
  A caller that tries gets a `422` that says why.
- The workbook importer still writes NULL meters (D6). Until that is wired, the
  sheet-era history in Vision carries durations without their readings — which
  is the true state, not a gap introduced here.
