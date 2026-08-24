# ADR-0125 — The day is closed by a person

- **Status:** Accepted
- **Date:** 2026-08-24
- **Builds on:** the Phase 0 parity audit
  (`docs/2026-08-19-h276-phase0-woodland-workbook-parity-audit.md`) and the
  full-repo research audit (`docs/2026-08-19-h276-full-repo-research-audit.md`).
  Their findings F-1..F-6 and gaps G-1..G-15 are the inventory this ADR builds
  against and are not re-derived here.
- **Extends:** ADR-0037 (loads & inventory foundations), ADR-0110 (the
  banner-aware on-hand figure), ADR-0118 (a decision and its record commit
  together), ADR-0119 / ADR-0123 (the `processed_units_daily` author lattice),
  ADR-0106 (the reason on a backdated write), ADR-0047 (born pilot).
- **Does NOT supersede:** ADR-0049 D3 (workbook-wins), ADR-0058 D2, ADR-0060 D5.

## Context

`JULY_2026_DAILY_LOG_WOODLAND.xlsm` is the last major spreadsheet DR3 runs the
floor from. The standing objective is Vision as single source of truth. Bill:
_"we need an end-of-day UI flow for the manager to enter the data from the day;
all-inclusive yet not over-complicated… this is critically important."_

Phase 0 measured the workbook against the schema before anything was built, and
the measurement changed the design in six places. This ADR records the decisions
that came out of it, and the two it deliberately leaves open.

## Decisions

### D1 — The absence of a close row is what "not reviewed" means

`eod_day_close` holds ONE row per `(site_id, close_date)`, and the row exists
only because somebody closed that day at least once. There is no "open" row
created up front: an absent row already means exactly that, and a second
representation of one fact is a second thing to keep in sync.

The day is CLOSED when `closed_at IS NOT NULL`. After a reopen both `closed_at`
and `closed_by` are NULL and the reopen triple carries who/when/why. State is a
FACT on the row, never a comparison between two timestamps — a comparison makes
"is this day closed?" a computation, and two readers computing it slightly
differently is the ADR-0110 defect one level down.

`reopened_by/at/reason` are NOT cleared on a re-close. Clearing them would make a
day that was reopened, corrected and closed again indistinguishable from one
closed once and never touched, and that distinction is the entire reason the
reopen is audited. `reopen_count` carries the same fact across repeats.

Six CHECK constraints back the service: an `exception` close requires a note of
at least four characters, a `clean` close carries none, the reopen triple is
all-or-nothing with a reason, the close pair moves together, the row must be
either closed or reopened, and the count is non-negative.

### D2 — Closing records a review. It locks nothing.

Every amendment path keeps working on a closed day: `upsertProcessedUnits`,
`updateOutbound`, `updateDropoff`, the count-correction window, the ADR-0106
prior-day equipment write. This is the OPPOSITE of
`processed_units_daily.closed_at`, which does block writes — that column locks
ONE billing figure Bill has signed off; this row records that a manager reviewed
a DAY. Conflating them would make "I have looked at this" a destructive act.

### D3 — Two outcomes, and the second one is the point

`clean` says every section was captured. `exception` says gaps remain AND names
them. A close that could only be clean would be lied to on the first day
something was genuinely still out. The note field pre-fills with the sections
still flagged, because a free-text box next to a "close anyway" button gets "n/a"
typed into it and then the record of what was outstanding is gone.

### D4 — The gap flag has THREE states

`captured` / `missing` / `not_applicable`. `missing` means NOTHING WAS RECORDED —
never "the number is zero" (ADR-0077 D4, restated for a whole day). A day on
which a channel genuinely had no activity still flags, and the manager clears it
by closing with an exception naming it.

`not_applicable` is what stops this surface lying about Eugene: Eugene has no
Terex, so a two-state flag would put a permanent warning on a site that is
behaving correctly, and a flag that cannot tell "could not apply" from "is
missing" trains people to ignore it. The Terex machine is resolved from the
equipment registry, never hardcoded.

### D5 — The month rollup is a PURE FOLD over the day sections

`rollupFromDays(days: DaySectionTotals[])` takes the same objects the day
sections render and adds them up. There is deliberately no query inside it: the
moment it could reach the database it would become a second computation of
numbers the sections already computed, and the two would eventually disagree.
One row loader (`loadWindowRows`), one bucketer, one summarizer, one fold.

**The Phase-2 acceptance criterion is WITHDRAWN.** The handoff asked that the
rollup "reproduce the Summary / Trans Summary tabs". Phase 0 measured those tabs
and found they sum over DUPLICATED rows: `inb no trans charge` and the unpaid
drop-off block carry every row exactly twice in both July and August, and the
sheet's `Transportation Total` and `Fuel Surcharge` equal the doubled sums (July:
112,150 raw / 56,075 distinct — exactly 2.000×). Matching the sheet would
reproduce a defect.

Replaced with: **the rollup equals the sum of the sections it displays, computed
once, and divergence from the sheet is a REPORTED reconciliation line.** The
screen says so in as many words, including that a ~2× gap is the expected shape
and not an error in Vision's numbers.

### D6 — `transport_charged` gets two writers, and the freight leg stops being blind

The column had NONE. Repo-wide grep found only reads
(`generation-inputs.ts:272`, `leg-fetchers.ts:105`) plus the DDL, and it read
`false` on all 743 production rows. It is the ONLY thing separating the
workbook's two inbound tabs, and `resolveTransportationInputs` selects
`where transport_charged = true` — so the entire CA inbound freight +
fuel-surcharge invoice leg iterated an empty set and raised nothing. A billing
leg that is structurally empty and silent is worse than one that errors.

1. **The verify gate** stamps it from `sources.is_trans_charge`, the classifier
   that already means exactly this (ADR-0037 Addendum B7 — it "splits the two
   Inbound tabs"). Only when the load HAS a source: a sourceless load gets no
   flag rather than a defaulted `false` indistinguishable from a real "no
   freight", the same refuse-to-guess rule as `no_source_for_default`.
2. **The EOD inbound add-line** carries an editable checkbox, pre-filled from the
   chosen source, plus a per-row correction control for the rows already in
   production — all of which were written before the column had any writer.

### D7 — `/admin/sources`, because a seed-only classifier is not a classifier

`is_trans_charge`, `is_non_program` and `canonical_mileage` decide money and were
all seed-only: no `/admin/sources` route existed anywhere in the page tree, and
`canonical_mileage` had no create/update call in `src/` or `scripts/` at all —
DDL only. `canonical_mileage` is the `miles` input to
`computeFuelSurchargeCents`, so the fuel-surcharge leg was uncomputable from
birth. `is_non_program` decides which pool a load's units land in, which is the
pool MRC is billed on.

The surface is `requireAdmin` — an admin POWER, not site reach. `all_sites` never
unlocks it (hard rule #2).

### D8 — `sources.haul_assignment` (gap G-9), enum, nullable, never backfilled

The workbook's `variables!Mileage_Table.Assignment` column had NO home anywhere.
`src/lib/rates/woodland-freight.ts:11` says so in the source — "no Assignment
table exists yet" — and then pins every Woodland freight row to Primary as an
admitted transitional rule.

ENUM because the live 61-row table holds exactly three values and a free-text
column would let a typo select a different rate leg silently. NULLABLE and
unbackfilled because writing `primary` onto 61 rows would turn a documented
transitional assumption into 61 fabricated measurements indistinguishable from
real ones (ADR-0079's no-fabricated-history rule; the same reasoning ADR-0107
used for the meter columns).

### D9 — No `commodity` column on `inbound_loads`, and this is not a missing enum

Recorded here so a future reader does not re-open it. The workbook's `commodity`
cell on the inbound tabs is a CHANNEL label, not a material — its live values are
`inbound units`, `Illegal Drop off`, `Unpaid Consumer Drop off`,
`Incentive drop off`, `event units`. The routing:

| sheet cell                 | Vision home                              |
| -------------------------- | ---------------------------------------- |
| `inbound units`            | `inbound_loads`                          |
| `Unpaid Consumer Drop off` | `consumer_dropoffs.kind = 'unpaid'`      |
| `Incentive drop off`       | `consumer_dropoffs.kind = 'incentive'`   |
| `Illegal Drop off`         | `consumer_dropoffs.kind = 'illegal'`     |
| `event units`              | the Events channel — OUT OF SCOPE (G-12) |

So "no home" is the correct verdict for that cell. `commodity` remains an
outbound concept only.

### D10 — The EOD inbound line captures the identifiers MANUALLY, and issues nothing

Five identifying columns had a schema home and no human write path — measured
100% NULL across all 743 production rows: `bol_number`, `dr3_number`,
`external_mymrc_haul_id`, `retrac_id`, `slip_number`. The BOL arrives only from
the MyMRC scrape; the DR3 number only from the CA verify gate, which had never
fired. Nobody could enter or correct any of them.

The add-line captures BOL/Check #, DR3 #, Haul # and Slip # as typed fields.

**No automatic DR3 issuance, and the sequencing decision is Bill's and is OPEN.**
`document_sequences` still reads `next_value = 5000`, untouched since 2026-07-04,
while the sheet is at DR3 # 4,755 and climbing ~11/day — they collide around late
October. The research audit further found that the highest number ever issued is
4,925 (with an unconfirmed April outlier at 5,853), so the reseed floor is not
"above 4,755". Either reseed the counter above the true ceiling, or have Vision
take over numbering at a named cutover date. Until Bill decides, nothing on this
screen consumes a number.

### D11 — A per-load EOD line is refused on a day an aggregate already covers

`onHand` counts BOTH per-load rows and the one-per-day aggregate rows
(`paper_bulk` / `mymrc_haul` / `ipad_floor`). Adding a per-load line to a day an
aggregate already covers would count those units twice — in the floor and in the
billing basis. `confirmFloorInboundDay` already guards the same collision from
the other direction (`per_load_exists`); this is its mirror, it is a typed 409
naming the aggregate, and it sits INSIDE the promotion lock rather than in the
UI, because the UI is not the boundary.

### D12 — The inventory check is graded against the ANCHOR, not the running balance

Gap G-11 asked for the sheet's `inventory check (should be zero)` cell:
`total − (program + non_program)`, flagged when non-zero.

Implemented against the running balance that would be **a detector that can never
report a negative.** `computeRunningBalance` DEFINES `total = program +
nonProgram`, so the difference is identically zero by construction, and a green
light wired to a tautology is worse than no light.

The statement the sheet is actually making is that the counted floor and the
split entered against it agree. In Vision that is a property of the ANCHOR: a
`measured` physical count carries both pools and they are supposed to sum to the
counted physical total. `reconcilePhysicalCount` validates that at write time, so
a fresh anchor cannot fail — but legacy rows, imported anchors and anything
written before that guard existed can, and those are the rows the whole floor is
computed forward from. An unsplit anchor reports `not_applicable`, not zero: its
pools are an artifact (`resolveAnchorPair` attributes the whole count to the
program pool), so "the difference is 0" would be true and meaningless.

The `measured` determination comes from `resolveAnchorPair` itself, and the
anchor from `loadPriorAnchor` — the existing shared selector, extended additively
with `pool_attribution`. A third anchor selector is what the ADR-0078 D1 note
spends fifteen lines warning against.

### D13 — Sizing follows the measurement, not the handoff's volume table

Phase 0 found five of the handoff's seven volume figures wrong, two in the
direction that would have under-built a real daily channel.

| channel                | handoff | measured                    | treatment                                              |
| ---------------------- | ------- | --------------------------- | ------------------------------------------------------ |
| Inbound                | 93/mo   | ~144/mo (consolidated)      | heaviest affordance — confirmed                        |
| Outbound `Commodities` | 8/mo    | **~107/mo across 9 blocks** | a REAL add-line with a commodity selector, not a token |
| `NonProgram`           | 0/mo    | **12–18/mo — near-daily**   | flagged, NOT collapsed                                 |
| unpaid drop-off        | 1/mo    | **11–21 distinct/mo**       | flagged, NOT collapsed                                 |
| `Renovation`           | 1/mo    | 2–4/mo                      | collapsed add-line — confirmed                         |
| incentive              | 1/mo    | 0–1/mo                      | collapsed add-line — confirmed                         |

ONE outbound add-line with a commodity selector reproduces all nine of the
sheet's per-commodity tables; the sub-category selector covers the Renovation tab
as well. Nine panels would be nine chances to diverge.

### D14 — Reuse the write paths; build only the aggregation, the review and the close

The outbound, drop-off and processed add-lines POST to the EXISTING manager
endpoints. Nothing here re-plumbs capture — which is also the only way the EOD
screen and the loads/inventory tabs cannot end up writing the same tables through
two different sets of validation. The genuinely NEW writes are three: the close,
the reopen, and the inbound gap-fill line (which had no manual per-load path at
all).

**Consequence, stated rather than discovered later:** those three endpoints are
gated on the `loads_inventory` rollout surface while this screen is gated on
`eod_review`. An admin passes both. For a non-admin manager BOTH must be live at
the site, and the client surfaces that refusal explicitly instead of failing
silently.

### D15 — `eod_review` is its own rollout surface, born pilot

Not riding `loads_inventory`: that gate is the master switch for every manager
loads/inventory tab and every loads write, so ramping EOD on it would either
expose the new screen the moment the existing tabs go live, or force Bill to take
the working tabs down to pull EOD back. This screen is also the one place a
manager can CLOSE a business day — a new authority, and it must be rampable per
site on its own. `requireActivatedManagerSurface` is the named-surface analogue
of `requireActivatedManager`, and `surfaceCode` is REQUIRED with no default for
the same reason it is on the operator twin.

### D16 — Out of scope, by decision

- **Events (G-12)** — a distinct billing channel (collection events, driver and
  labour hours, per diem, stop charges by zone) that feeds the Summary's
  `Event Misc` and `Event Trans` lines. It is Bill's Phase-3 decision and is NOT
  bolted onto this screen. Until it lands the workbook cannot go fully dark.
- **Fuel and Container Rentals** — monthly/auto, with existing homes and existing
  admin surfaces. Neither belongs in a DAILY screen.
- **G-15, the 31-row reconciliation** — Vision holds 113 inbound rows for
  Aug 1–19 against the sheet's 144. Named here, out of scope, and the reason the
  rollup carries a reconciliation line rather than a claim of agreement.
- **G-14** — nothing on this screen renders the sheet's `Facility` column, which
  carries `DR3 Stockton` on 15 of 41 rows. Every render is site-filtered from
  Vision's own site row.

## Consequences

- A manager can review one day, see exactly what is missing, fill the holes, and
  close — clean or with a named exception, reopenable with an audited reason.
- The month is readable in Vision, and the sheet's Summary tabs stop being the
  place anyone looks.
- The CA freight leg has data to select on for the first time. It will still not
  compute a fuel surcharge until `fuel_prices` and `canonical_mileage` are
  LOADED — that is data loading (G-10), not building, and `/admin/sources` is
  half of what unblocks it.
- Two decisions stay open and are Bill's: the DR3 numbering takeover and its
  reseed floor (D10), and whether Events becomes Phase 3 (D16).

## Falsification

Each of these was written to fail first, and its red is recorded in the test file
next to the assertion:

- a missing inbound line raises `⚠`, asserted as the flag value and not as a
  silent pass — with a positive control on the same fixture so the suite cannot
  pass by always flagging;
- close-with-exception records the note, and a clean close carrying one is
  refused;
- reopen is audited with who, when and why, and a reopen with no reason is
  refused before anything is written;
- the rollup equals the sum of the sections, proven by a DIVERGENCE fixture —
  patching one day's section by +1 moves the rollup by exactly +1, which a rollup
  that queried independently would not do;
- a negative on-hand renders the ADR-0110 banner on THIS page and the bare figure
  is asserted ABSENT;
- a second close for one `(site, date)` is refused, and the refusal is a
  compare-and-swap, proven against a real Postgres;
- a non-manager gets no page;
- the freight checkbox round-trips to the row.
