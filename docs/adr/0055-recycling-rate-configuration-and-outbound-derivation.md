# ADR-0055 — Recycling-Rate Configuration + Outbound Stewardship Derivation

**Status:** Accepted (2026-07-18) — MRC billing amendment sequence; foundation
ADR-0037 merged; this answers the workbook `B10-5` / `%` column question.
**Date:** 2026-07-18
**Directive:** rollup §A.4 (Kelsey's answer) + §8.3 ("New ADR needed")
**Owner (function):** commodities (Daven Stetson, per ADR-0052); rate values
confirmed by Kelsey, remainder pending Morena.
**Relates to:** ADR-0037 (loads/inventory foundation — `outbound_materials`,
the effective-dated resolver pattern this mirrors), ADR-0041 (invoice generation —
removed commodity mapping from invoicing; these splits are NOT billed), ADR-0052
(commodity payment reconciliation — formalized the outbound buyer concept this
builds on), O-7 (CalRecycle stewardship-fee reporting — the CONSUMER of these
derived fields; a separate feature).

**Numbering note:** claimed at draft time against `docs/adr/`. 0054 was consumed
(internal-cron 503 blackout postmortem); 0055 was free.

## Context

Different steel recyclers count different fractions of an outbound steel load as
*recycled* versus *landfilled*:

- **Green Zone** counts the whole load as steel — **100%** recycled.
- **Xtraction** yields **81% steel / 19% landfill** — a 5,541 lb load resolves to
  roughly 4,488 lb steel + 1,053 lb trash (see the worked example + rounding note
  below).

The same holds for wood: **Biomass** counts the whole load as wood (**100%**);
other wood recyclers vary. This variation is precisely what the workbook's `%`
column (the `B10-5` question) encoded.

These recycled-vs-landfilled splits feed **CalRecycle stewardship reporting**
(O-7). They are **NOT part of the MRC invoice** — ADR-0041 removed commodity
mapping from invoicing entirely; the invoice is a single line of `units × rate`.
So this ADR is a *data-capture and derivation* feature, deliberately decoupled
from billing.

Two gaps in the current model:

1. **Outbound recyclers are not first-class.** `outbound_materials.buyer` is a
   free-text string (SA Recycling, Green Zone, …). A per-recycler rate needs a
   referenceable entity.
2. **No split is captured.** The operational row records only `weight_lbs`; the
   recycled/landfilled breakdown CalRecycle needs is nowhere.

## Decision

### D1 — Outbound-vendor master (`outbound_vendors`)

A **global** recycler master — `id`, unique `name`, `is_active`, `notes`. Global
(mirrors `transporters`), **not** site-scoped like `sources` (inbound collection
sites), because a recycler's recovery rate is a property of the *recycler*,
org-wide, not of the SVdP site that shipped the load.

`outbound_materials` gains a nullable `vendor_id` FK. The legacy free-text `buyer`
stays as the reconciliation/backfill field; `vendor_id` is the structured
reference the derivation resolves against. **Judgment call flagged:** outbound
vendors were not modeled before; formalizing them as a global master is the
cleanest fit and keeps the rate keyed to the recycler. Backfilling
`buyer → vendor_id` on historical rows is a separate data task (out of scope).

### D2 — Effective-dated rate table (`recycling_rates`)

| column | type | notes |
| --- | --- | --- |
| `vendor_id` | FK → `outbound_vendors` | the recycler |
| `commodity` | `OutboundCommodity` enum | **reused, not a parallel enum** |
| `recycling_percent` | `Decimal(5,4)` | fraction recycled, `[0,1]`; `0.8100` exact |
| `effective_from` | `Date` | inclusive |
| `effective_to` | `Date?` | inclusive; null = open-ended (current) |
| `notes` | `Text?` | provenance |

**Commodity taxonomy reuse.** The existing `OutboundCommodity` enum has no
`steel`/`biomass` members — **steel maps to `metal`**, and *Biomass* is a *vendor*
supplying commodity `wood`. So all three confirmed rates key on the existing
`metal` / `wood` members; no new enum was created.

**Decimal precision.** `Decimal(5,4)` represents `0.8100` exactly, holds `1.0000`,
and leaves headroom. A DB `CHECK` fences it to `[0,1]` (`recycling_percent >= 0 AND
<= 1`); the pure math re-validates the input. This follows the repo's existing
"Decimal at every rate edge, never float" convention (e.g. `Decimal(10,4)`
per-unit rates in ADR-0040).

**Resolution.** `resolveRecyclingRate(vendorId, commodity, onDate)` mirrors the
`state_program_rules` / `processor_bonus_rules` resolver (`src/lib/program-rules/
resolver.ts`): the row whose `effective_from <= onDate` and `effective_to` is null
or `>= onDate` wins. It returns `null` when no row covers the date (the no-rate
case, D4) and **throws `AmbiguousRecyclingRateError`** if more than one row covers
a date — a rate is never coin-flipped.

**Overlap guard — three layers** (so a bad seed can't silently double-resolve):

1. **DB partial-unique index** on `(vendor_id, commodity) WHERE effective_to IS
   NULL` — at most one open-ended ("current") rate per `(vendor, commodity)`.
2. **Transactional write guard** — `createRecyclingRate` takes a per-`(vendor,
   commodity)` `pg_advisory_xact_lock`, then `assertNoRecyclingRateOverlap`
   rejects any proposed window overlapping an existing one, then inserts. This is
   the only sanctioned insert path (the seed and any future admin endpoint use it).
3. **Resolver throw** — any date covered by `>1` row throws (belt-and-suspenders;
   structurally impossible under 1+2).

### D3 — Outbound derived fields

`outbound_materials` gains, all nullable/additive:

- `recycled_lbs`, `landfilled_lbs` (Int)
- `recycling_percent_applied` (`Decimal(5,4)` — durable snapshot of the fraction
  used; survives later edits/deletes of the rate row)
- `recycling_rate_id` (FK → `recycling_rates`, `ON DELETE SET NULL` — provenance)

Computed at **entry time** from `(vendor_id, commodity, ship_date)` and
re-computed on any edit that changes `vendor_id` or `weight_lbs` (`commodity` /
`ship_date` are immutable post-create). Reported **separately** for stewardship;
never touches the invoice.

**Derivation math + rounding rule:**

```
recycled_lbs   = round_half_up(weight_lbs × recycling_percent)
landfilled_lbs = weight_lbs − recycled_lbs        ← complement, never a 2nd round
```

Deriving `landfilled_lbs` as the **complement by subtraction** (not a second
independent round) guarantees `recycled_lbs + landfilled_lbs == weight_lbs`
**exactly**, for every rate and weight, with **no pound drift**. Two independent
round-half-up ops would drift: e.g. `5 lb @ 0.5` → `round(2.5)=3` recycled **and**
`round(2.5)=3` landfilled = 6 (a phantom pound). `weight_lbs` is already integer
pounds, so there is no sub-pound/penny edge. Both `recycled_lbs` and
`landfilled_lbs` are guaranteed non-negative and `≤ weight_lbs` because
`recycling_percent ∈ [0,1]`.

**Worked example (Xtraction, 5,541 lb @ 0.81):**

```
0.81 × 5,541 = 4,488.21  → round_half_up → 4,488 lb recycled (steel)
5,541 − 4,488            =                  1,053 lb landfilled (trash)
4,488 + 1,053            =                  5,541 lb  ✓ (exact)
```

> **Discrepancy flagged (honest record).** Kelsey's verbal example stated
> "5,541 lb → **1,054** lb trash + **4,487** lb steel". Those two numbers sum to
> 5,541 but do **not** correspond to the confirmed `0.81` rate at *any* rounding:
> `0.81 × 5,541 = 4,488.21`, so the config rate yields **4,488 / 1,053**. The
> `4,487 / 1,054` pair is an **80.98%** split — a hand-rounded (or real-ticket)
> figure, not the nominal `0.81` computation (to land on 4,487, the rate would
> have to be `~0.8098`). The system uses the **configured** rate and derives
> `4,488 / 1,053`. We seed `0.81` as confirmed and do **not** fudge a rate or the
> rounding to force Kelsey's figures. **If Xtraction's true recovery is `0.8098`
> (not `0.81`), update the seeded rate** — flagged for Kelsey/Morena confirmation.
> Test `recycling-rates.test.ts` asserts both facts explicitly so the delta is
> never silently "corrected".

### D4 — No-rate default policy

When no rate row covers `(vendor, commodity, ship_date)` — or no vendor is set —
the derived fields are **left null and the row is flagged** (the iPad preview shows
an amber "no rate configured; split not recorded" banner). A missing rate is
**never** silently treated as 100% recycled — that would over-report recycling to
CalRecycle. `deriveOutboundRecycling` returns a discriminated result
(`derived | no_vendor | no_rate`) the entry path and preview both consume.

### D5 — Seeds (confirmed only)

Three rates, open-ended from a 2020-01-01 baseline (covers all existing/future
ship dates), idempotent:

| vendor | commodity | `recycling_percent` |
| --- | --- | --- |
| Green Zone | `metal` | `1.0000` |
| Xtraction | `metal` | `0.8100` |
| Biomass | `wood` | `1.0000` |

Other wood-recycler rates are **PENDING Morena** — deliberately not seeded (never
invent a rate). Rates are admin-editable and will grow, so they are **not**
asserted in the seed's fixed count check.

### D6 — iPad entry preview

When the operator selects **recycler + commodity** (with a load weight), the
outbound panel shows a live **recycled vs landfilled** split before saving, wired
to `GET …/outbound/rate-preview` — the *same* resolver + derivation the save path
uses, so the preview and the persisted row can never disagree. A vendor picker
(`GET …/outbound/vendors`) and the two derived columns were added to the existing
`OutboundPanel` (the surface already existed).

### D7 — Compliance seam (not built here)

CalRecycle/stewardship reporting **consumes** `recycled_lbs` / `landfilled_lbs`.
This ADR *provides the data*; the reporting surface is a separate feature (O-7).
Documented as a seam; not built here.

## Alternatives considered

- **A Postgres `EXCLUDE` constraint (`btree_gist`) over a `daterange`** — the
  textbook DB-level temporal-overlap guard. **Rejected:** the fleet uses **no**
  Postgres extensions, `CREATE EXTENSION btree_gist` needs a privilege the migrate
  role may lack, and it risks the ADR-0035 clean-replay invariant. The
  partial-unique + transactional-guard + resolver-throw trio (D2) achieves the
  same guarantee within existing conventions.
- **Widen `outbound_materials` with the rate inline / no vendor master** — rejected;
  the rate is a reusable per-recycler property, not a per-load fact. A vendor master
  keeps one source of truth and matches `transporters`.
- **Assume 100% when no rate exists** — rejected (D4); silently over-reports
  recycling to a compliance system.
- **Store the rate as an integer percent (e.g. `81`)** — rejected; `Decimal(5,4)`
  matches the repo's rate convention and admits sub-percent precision (e.g. the
  0.8098 question above) without a schema change.

## Consequences

- **Additive migration only** (`20260726_adr0055_recycling_rates`): two new tables
  + nullable columns; safe on populated prod, replays clean on empty PG16.
- Outbound entry now optionally carries a recycler + a derived stewardship split.
  Legacy rows have null derived fields until a vendor is set (backfill is a
  separate task).
- A new global master (`outbound_vendors`) that other features (ADR-0052 payment
  reconciliation) can later reference in place of free-text `buyer`.
- O-7 stewardship reporting has its input data seam.
- **Residual risks:** (a) the Xtraction `0.81` vs `0.8098` question above; (b) most
  wood-recycler rates pending Morena; (c) `buyer → vendor_id` historical backfill
  not done; (d) the iPad preview is wired but not yet visually verified on-device.
