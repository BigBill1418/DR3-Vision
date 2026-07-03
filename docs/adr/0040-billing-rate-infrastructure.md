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
