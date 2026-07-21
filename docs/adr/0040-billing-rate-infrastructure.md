# ADR-0040 — Billing rate infrastructure (transport tiers, account overrides, container rentals, fuel prices, scoped rate-write access)

**Status:** Accepted (2026-07-03, approved by Bill)
**Date:** 2026-07-03
**Relates to:** mission record §3/§3.1/§6-P2 + locked decision #6 (Rick maintains rate tables, manager-scoped); Addendum A §A3; **Addendum B §B2/§B3/§B5** (corrected transport model, fuel mechanics); ADR-0037 (state_program_rules, Source.canonical_mileage/is_trans_charge); survey build-inputs §C
**Series:** first of three P2 ADRs — **0040 rate infrastructure (this)**, 0041 invoice generation, 0042 COR generator

## Context

P2 renders invoices from data; this ADR puts every rate that isn't already in
`state_program_rules` into effective-dated tables so the invoice layer (0041) is
pure computation. It also carries a live money finding: freight has been billed on
Stockton-era mileage since the 06-09 diversion (**+34% → +1240% actual-distance
deltas** per `renegotiate_trans_rates.docx`), and the renegotiation exhibit should
fall out of this schema, not another hand-built docx.

## Decisions

### D1 — `transport_rate_tiers` (Addendum B §B2 — freight is a zone table, not $/mile)

```
transport_rate_tiers(id, jurisdiction enum(CA, OR), min_miles Int, max_miles Int,
                     rate_cents Int, effective_from, effective_to?, …audit)
```

Seeded from the workbook's live table (effective 2026-01-01, CA): 0–25→42500¢ ·
26–50→60000 · 51–100→92500 · 101–200→145000 · 201–300→200000 · 301–400→250000 ·
401–500→300000. Tiers are contiguous and non-overlapping — enforced by a named
validation function on write (no DB constraint can express it cleanly; the writer
validates the whole effective set). A renegotiation lands as new rows with a new
`effective_from`; history is never edited.

### D2 — `account_haul_rates` (per-account overrides, B2's `variables!H1:Q~86`)

```
account_haul_rates(id, source_id FK, rate_cents Int, effective_from,
                   effective_to?, note?, …audit)
```

Freight resolution order, ONE named resolver (`resolveFreightCents(source, date)`):
account override in force → else tier lookup on `Source.canonical_mileage` → else
**typed `FreightUnresolvableError`** (a transport-charged load from a source with
no mileage and no override can never silently bill $0 — the error carries
source_id + load context for the log line). Freight on transport-charged loads is
**computed, never typed** (B2); the ADR-0037 `freight_cents` column stores the
resolver's output with provenance (`freight_rate_ref` — which tier/override row
priced it) for the retro-audit.

### D3 — `container_rental_sites` (mission §3.1)

```
container_rental_sites(id, site_id, location_name, source_id? FK, trailer_count Int,
                       trailer_size?, monthly_rate_cents Int, active Boolean,
                       effective_from, effective_to?, …audit)
```

Monthly rental total = Σ active rows for the month — replaces the hand-kept block
(~40 CA sites, $300–$1,200, ~$10,500/mo; the **$10,800-vs-$10,500 June/July
discrepancy** (B8/B10-7) gets settled by Rick when he seeds real rows — the seed
ships EMPTY except a fixture example, because seeding contested numbers would
launder the discrepancy into "truth").

### D4 — `fuel_prices` + EIA auto-fetch (B3)

```
fuel_prices(id, week_of @db.Date UNIQUE, usd_per_gal Decimal(5,3),
            source enum(eia_api, manual), fetched_at, …audit)
```

Weekly cron (house daemon pattern — fixed Tuesday 06:00 PT tick, internal route
with middleware exemption + `public-paths.test.ts` case ON DAY ONE) fetches the
EIA West Coast ULSD weekly retail price (open API, key-free v2 route; series from
Rick's URL). Manual entry surface retained (source=manual wins over a later API
fetch for the same week only via explicit overwrite, audited). Surcharge
computation (0041 consumes): `applies iff price > trigger ($5.05, in
state_program_rules)`, `surcharge = (price / 6.5 mpg) × miles`, CA only —
`RuleStructurallyDisallowedError` already guards OR at the resolver. A missing
week's price at invoice time is a typed error, never a silent $0 (fetch failure
pages `dr3-vision-system` fingerprinted, cooldown per fleet policy).

### D5 — Scoped rate-table write access (mission locked decision #6)

New `users.can_manage_rates Boolean @default(false)` — grantable from
`/admin/users` (admin-only, audited, mirroring the ADR-0024 `all_sites` toggle
pattern). Write access to D1–D4 tables = `role === 'admin' || can_manage_rates`;
**admin POWERS stay admin-only** (hard rule #2 discipline: this flag grants
exactly rate-table writes, nothing else — never consulted anywhere but the four
rate-table write paths). Rick gets the flag at rollout. Every rate write emits an
audit row + a structured log line (who, table, before→after, effective range) —
rate changes are exactly what future-us will need to trace.

### D6 — Rate variance report (the negotiation exhibit)

Read-only report over `Source.canonical_mileage` vs the mileage each source was
LAST billed under (from workbook imports / invoice history): per-site old-tier vs
actual-tier, per-haul delta, monthly leakage total (e.g. GVCC $425→$925/haul).
Renders in the manager portal + CSV export. Replaces `renegotiate_trans_rates.docx`
as a living artifact; the human renegotiation itself is Bill's (interim MRC seat).

### D7 — Observability (operator directive 2026-07-03: diagnosability baked in)

Every resolver in this ADR logs its resolution path at debug and its FAILURE with
full context (`log.warn` + typed error: source_id, date, tier set consulted);
every write surface logs actor + delta; the EIA cron logs each fetch outcome and
writes a fetch ledger row (`fuel_prices.source/fetched_at` doubles as it); all
new internal routes carry the requestId pattern. No silent fallbacks anywhere in
rate resolution — money paths fail loud by construction.

## Out of scope

Invoice/Summary/offset-line rendering, mid-month cutoff, GP export (**ADR-0041**)
· COR (**ADR-0042**) · the commodity→billing-block mapping (B10-5, still pending
Kelsey/Janette) · TONU (trailer-order-not-used) handling Rick mentioned — parked
on the open register until P2 invoice work confirms where it bills.

## Consequences

- Four new tables + one user flag, all additive; the 0041 invoice layer becomes a
  pure read of rules + rates + operational data.
- The underbilling becomes quantified and self-updating (D6) instead of a one-off
  docx.
- Two deliberate empties: container rentals seed empty (Rick settles B10-7);
  account overrides seed empty (populated from the workbook's variables sheet only
  after Rick confirms which are current).

## Test plan (summary)

Tier-set validation (contiguity, overlap, gap, effective-date boundaries) ·
freight resolver matrix (override beats tier; tier boundary miles 25/26; missing
mileage → typed error; OR transport rows never consult fuel) · fuel trigger edge
($5.05 exactly = no surcharge; above = formula) · EIA fetch (fixture + failure
paging + manual-overwrite audit) · can_manage_rates gate (grant/revoke/deny
matrix incl. the flag NOT unlocking any admin surface) · variance report math on
a fixture set · migration clean-replay (CI).

## Implementation notes (post-acceptance, 2026-07-03)

Delivered as `20260706_billing_rate_infrastructure` + `src/lib/billing-rates/*`.
Deviations and specifics worth recording:

- **EIA v2 specifics.** The fetch (`eia.ts`) hits the v2 REST route
  `https://api.eia.gov/v2/petroleum/pri/gnd/data/` with facets
  `product=EPD2DXL0` (No 2 Diesel, Ultra Low Sulfur), `process=PTE` (retail /
  prices-to-end-users), `duoarea=R50` (PADD 5 / West Coast), `frequency=weekly`,
  `data[]=value`. This is the v2 equivalent of legacy series
  `PET.EMD_EPD2DXL0_PTE_R50_DPG.W`. **A key IS required** (the v2 route is not
  key-free — the ADR's "key-free v2 route" assumption was wrong): `EIA_API_KEY` is
  read from env, and the design is **fail-open** — an absent key returns a typed
  `no_api_key` result that the cron logs and skips (no page, no crash); the manual
  entry surface remains the fallback. Real fetch failures (http/network/payload)
  page `dr3-vision-system` fingerprint `fuel-fetch-failed` (6 h cooldown).
- **Week convention.** A load's fuel week is the **UTC Monday** of the ISO week it
  falls in (`mondayOfWeekUTC`). EIA stamps the weekly West-Coast price on the
  Monday, so `fuel_prices.week_of` stores that Monday and the manual-entry route
  normalizes any submitted date onto it.
- **DB-level FKs, not Prisma relations (deliberate).** To keep the ADR-0040 schema
  additions in one self-contained block (no back-relation fields on the
  sibling-owned `Source`/`Site` models — coordination with the audit/loads agents),
  `account_haul_rates.source_id`, `container_rental_sites.site_id/source_id` are
  plain scalar columns whose FOREIGN KEY constraints are created in the migration
  SQL. Consequence: `prisma migrate dev`/`db pull` would see the relation as
  "drift" (Prisma doesn't model it), but `migrate deploy` clean-replay (the
  ADR-0035 CI invariant) passes and referential integrity is enforced at the DB.
- **`can_manage_rates` is never in the session.** The write gate
  (`requireRateManager`) reads the flag fresh from the DB per request; it is
  consulted nowhere else. `requireAdmin` still checks `role === 'admin'` only, so
  the flag cannot unlock any admin surface — asserted by a test that drives the
  real `/api/admin/audit` and `/api/admin/users` routes with a flag-holding manager
  and expects 403.
- **Freight is COMPUTED, never typed.** `resolveFreightCents` returns `{cents, ref}`
  where `ref` is the provenance (`override`/`tier` row id) that the ADR-0037
  `freight_rate_ref` column stores for the retro-audit.
- **Variance report last-billed source (D6).** The workbook/invoice-history staging
  tables (ADR-0039 audit engine) are not on `main` at this build, so the report
  reads last-billed mileage + haul frequency through an injected
  `VarianceProvider`. The default provider reports `available:false` and the report
  renders tier-now only with an honest empty state + `TODO(ADR-0040 D6)` to wire a
  provider over the workbook staging once it lands.

## Amendment (2026-07-18) — MRC billing composition + transitional freight (rollup §8.2 + §3.3/§3.5/§3.6/§3.7)

This amendment extends the accepted ADR-0040 rate infrastructure with the MRC
tune-and-launch billing rules that ride on top of it. It is **purely additive** —
migration `20260726_adr0040_rate_infrastructure` adds ONE enum + ONE table; everything
else is resolver code over the tables ADR-0040 already stood up. It builds on the
ADR-0037 amendment (`Source.site_type`, `active_billing`, `bill_trans`/`bill_trailer`).

### A1 — Per-source OR service rates (§3.3): `source_service_rates`

The OR sources bill trans / trailer / per-mattress (and the MRC unit rate) at per-source
amounts that change over time (The Dalles's rates take effect **2026-06-01**; the rest
**2026-01-01**). Flat columns cannot carry effective dates, so — following the existing
`account_haul_rates` per-source effective-dated pattern rather than inventing a new shape
— these live in `source_service_rates(id, source_id FK, rate_kind, rate_cents,
effective_from, effective_to?, note, created_by, audit)` with
`SourceServiceRateKind {trans|trailer|per_mattress|mrc_unit}`.

Resolver `src/lib/billing-rates/service-rates.ts` (`resolveSourceServiceRateCents`)
mirrors `resolveFreightCents`: picks the latest in-force row for `(source, kind, date)`,
detects a same-`effective_from` tie (`ambiguous_rate`), and throws
`ServiceRateUnresolvableError` (`no_rate_in_force`) when nothing covers the date — an OR
billing component **must not silently bill $0** (D7). The `source_id` FK is a DB-level
constraint on a bare column (mirrors `account_haul_rates`, keeps the block self-contained).

**Deliberate empty:** no rows are seeded here. The §7 seed PR loads the OR source rate
rows after this merges — seeding source-specific rates before Rick confirms them would
launder unconfirmed numbers into "truth" (same discipline as the D2/D3 empties).

### A2 — Per-site-type billing composition (§3.2/§8.2)

`src/lib/billing-rates/site-type-billing.ts` (`resolveSiteTypeBilling`) is the pure map
from a source's `site_type` to the billing components it produces:

| site_type            | trans | trailer | per-mattress | MRC unit |
|----------------------|-------|---------|--------------|----------|
| `mrc_inbound`        | ✓     | ✓       | —            | ✓        |
| `cvp_retailer`       | ✓     | ✓       | —            | —        |
| `collection_site`    | ✓     | ✓       | ✓ ($2.25)    | ✓        |
| `third_party_inbound`| —     | —       | —            | ✓        |

The ADR-0037 per-source `bill_trans` / `bill_trailer` flags then override the site_type
default with **suppress-only** semantics: `effective = site_type_default AND
per_source_flag`. A flag can turn a defaulted component OFF, never ON. Two reasons: the
flags default to `true` (so a plain AND leaves an unset source at its pure default, and
critically cannot grant trans/trailer to `third_party_inbound`), and the only documented
override — **Cottage Grove** (`collection_site` with both flags `false`) — is a
suppression (trans+trailer off; per-mattress + MRC unit, which have no per-source flag,
still bill). `active_billing=false` (Roseburg) suppresses ALL components with no error; an
active source with a null `site_type` throws `SiteTypeUnclassifiedError` — an active
source with an unknown component set must not silently bill nothing.

**Judgment call flagged for Rick/Mary:** the suppress-only reading of the override flags
is the money-safe interpretation but is not spelled out verbatim in the rollup. If a
source ever needs a component ADDED beyond its site_type default, that must be a
`site_type` change (or a new flag), not a `bill_*` toggle.

### A3 — Transitional Woodland freight (§3.5)

For any Woodland (CA)-jurisdiction load, freight is **always** priced off the source's
**Primary** haul rate + **Primary** mileage, regardless of the load's actual site
Assignment (Primary / Secondary / Tertiary). This is a deliberate transitional
simplification until the multi-destination Assignment model lands; encoding it now pins
freight to Primary so a future Secondary/Tertiary assignment can never silently change
the billed rate.

In the current (Assignment-less) schema, "Primary rate" = the in-force `account_haul_rates`
override and "Primary mileage" = the source's single `canonical_mileage`. So the §3.5
decision tree is exactly the override → tier → typed-error order the audited
`resolveFreightCents` already implements for a CA source (its `tier` leg IS the CA Event
Mile Rate table, A4):

1. Primary defined (override in force) → Primary rate (ref: `override`).
2. No override, Primary mileage set → Event Mile Rate tier by mileage (ref: `tier`).
3. No override, no mileage → `FreightUnresolvableError`.

`src/lib/billing-rates/woodland-freight.ts` (`resolveWoodlandFreightCents`) therefore
**delegates** to `resolveFreightCents` (one audited money path, no drift) and adds only the
Woodland contract: it verifies the source is CA and rejects a non-CA (Oregon) source with
`WoodlandJurisdictionError` (a routing bug; OR freight is unseeded by design). **CA
non-Woodland loads do not come through here** — they use `resolveFreightCents` directly and
that path is unchanged.

### A4 — Event Mile Rate resolver (§3.7) — reuse, do NOT duplicate

The §3.5 fallback needs a mileage→flat-rate lookup called the "Event Mile Rate tier"
(rollup §3.7, workbook Variables!D6:F13): 0–25→$425, 26–50→$600, 51–100→$925,
101–200→$1,450, 201–300→$2,000, 301–400→$2,500, 401–500→$3,000.

**These are exactly the seven CA `transport_rate_tiers` bands ADR-0040 D1 already seeded**
(same cents, same effective 2026-01-01, already validated contiguous-from-0 /
non-overlapping on every write). Standing up a separate `event_mile_tier` table would fork
ONE set of rates into TWO independently-editable sources of truth for the SAME numbers — a
billing-correctness hazard (they drift; an invoice silently prices off the stale copy). So
this amendment adds **no table**: `src/lib/billing-rates/event-mile-rate.ts`
(`resolveEventMileRateCents`) is the named, fail-loud resolver OVER the existing CA tier
rows, reusing the same inclusive-band math (`tierForMiles`) the DB-filtered
`resolveFreightCents` uses, so the pure and DB paths agree by construction. Out-of-range
(> 500 mi, negative, non-integer) throws `EventMileRateOutOfRangeError` — never a silent $0.

### A5 — Container rentals never prorated (§3.6, closes C-10)

A container/trailer rental bills its **full monthly rate for any overlap** with a billing
month — never prorated by day. A rental starting on the 28th and spanning into the next
month bills the full rate in **both** months. This was already the behavior (`resolveRentals`
selected any month-overlap and `composeTransportation` summed `monthly_rate_cents`
verbatim); this amendment makes it an **explicit, tested policy** rather than an implicit
property of a Prisma `where` clause. `src/lib/billing-rates/rental-billing.ts` provides
`monthWindowUTC`, `rentalOverlapsMonth`, and `billedRentalCents` (deliberately trivial — it
returns the full rate, so any future "let's prorate" change must delete a named policy
function and its tests, not just tweak arithmetic). `resolveRentals` was refactored to share
these helpers so the query and the policy can't drift.

### A6 — OR fuel surcharge skipped (§6.5) — confirmed, no change

The fuel-surcharge formula is CA-only. This was **already** enforced structurally:
`computeFuelSurchargeCents` resolves the `fuel_surcharge` rule through `resolveProgramRule`,
which throws `RuleStructurallyDisallowedError` for any OR-jurisdiction fuel lookup **before
any price is read** (ADR-0037 D1), and `composeTransportation` independently refuses
`or_transportation_no_fuel`. An existing test (`fuel.test.ts`) already proves an OR site
throws before consulting a price even when an above-trigger price is on record. No code
change was needed; this amendment records the verification.

### Test coverage (this amendment)

New pure/DB-free unit suites: `event-mile-rate.test.ts` (band boundaries incl. exact
25/26/50/51/100/101 edges, out-of-range fail-loud), `woodland-freight.test.ts` (Primary
override vs Event-Mile fallback vs unresolvable, non-CA rejection),
`site-type-billing.test.ts` (each site_type, Cottage Grove suppress-only override,
active_billing full suppression, unclassified throw), `service-rates.test.ts` (in-force
selection, The Dalles 2026-06-01 effective boundary, latest-window-wins, tie, no-rate),
`rental-billing.test.ts` (28th-spanning rental billed full in BOTH months, overlap edges).

### Residual risk / open items

- **Assignment model is future work.** A3 is transitional-correct only while the schema has
  a single `canonical_mileage` per source. When multi-destination Assignment lands, the
  Woodland resolver must keep using ONLY the Primary — re-verify then.
- **Suppress-only override semantics (A2)** is a judgment call — see the flag above.
- **OR source rate rows + MRC unit rate home (A1).** `mrc_unit` is modeled in
  `source_service_rates` on the assumption the MRC unit rate is per-source; if it is instead
  MRC-contract-wide it may belong in `state_program_rules` — confirm with Rick at §7 seed
  time. The resolver and enum accommodate either without a schema change to the other kinds.

---

## Amendment (2026-07-21) — Rick/Mary/Kelsey rollup (rollup §14)

Confirmations from the 2026-07-20 rollup that touch the rate/GP-config surface.
Most items were ALREADY seeded correctly at ship time; this records the
confirmation and the one delta.

### Rates — all confirmed, none re-seeded

- **OR processing rate = $17.00/unit** (1700¢). Already live in
  `state_program_rules` (`processing_rate`, eugene, `effective_from` 2026, no
  `effective_to`) — the invoice generator resolves it for `or_processing_eom` via
  the existing `resolveRateCents` path. **Not re-seeded** (rollup DO-NOT: never
  duplicate a live rate). CA stays $16.50/unit (2026), $17.00 (2027).
- **Collection sites $2.25/mattress**, **unpaid drop-off reimbursement (CA)
  $3.00/unit** — unchanged, already seeded.
- **Container rentals** June actuals (CA $10,800/44 · OR $900/6, incl. The Dalles)
  are DATA in the rentals tables, not rate constants — no ADR-0040 change.

### `MILES 0` aggregation rule (rollup §9)

The GP Transportation invoice collapses **regular freight + event transportation
+ container rental into ONE `MILES 0` line**; only fuel keeps its own `FUEL`
line. This is realized as a **presentation-time rollup** in the ADR-0041 v2 export
(`src/lib/invoices/item-codes.ts` `MILES_0_MEMBER_CODES`,
`export-json.ts` `transportationGpLines`) — the composer still stores the three
`B16.*` leaves separately (full provenance). No rate-infrastructure change; noted
here because §14 filed the aggregation rule under ADR-0040.

### MRC billing address / Sales ID / Customer ID (GP config)

- **Bill-To (already seeded):** Mattress Recycling Council, Attn: Ryan Trainer,
  501 Wythe Street, Alexandria VA 22314 · **Sales ID `34`** (static) · Net 30.
  Verified present in `gp_billing_config` (singleton); no change needed.
- **DELTA — OR Customer ID (§8 Q1 / §13):** Eugene Customer ID is **`MRCL001`
  (same as CA)**, no longer null-pending-Mary. `gp_site_billing_config` seed
  updated (eugene `customer_id` null → `MRCL001`), and the `update` branch now
  re-applies the confirmed identifier columns so an idempotent re-seed corrects a
  row previously seeded with the null. (PO-suffix spacing correction is recorded
  in the ADR-0041 amendment.)
