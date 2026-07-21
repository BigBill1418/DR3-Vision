# ADR-0056 — Event billing components + TONU line handling

**Status:** Accepted — schema foundation + pure compute layer (2026-07-21)
**Date:** 2026-07-21
**Relates to:** `docs/handoffs/2026-07-21-mrc-billing-addendum-rick-mary-kelsey-rollup-2026.md` §5.3/§14, ADR-0037 (loads/inventory + `state_program_rules`), ADR-0040 (rate infrastructure + `transport_rate_tiers`), ADR-0041 (invoice generation)
**Scope note:** this ADR lands (a) the **schema + rate-constant surface** for event billing and TONU (D1–D5) and (b) the **pure compute layer** that prices the six §5.3 components + TONU (D6–D8, `src/lib/event-billing/`). The invoice-generator wiring — composing these into the CA `EVENTO` / `MILES 0` lines per §9 — is a follow-up owned by the invoice feature work; nothing here changes generated invoices.

## Context

Rick's 2026-07-19 walkthrough (rollup §5.3) specified how DR3 bills collection **events** — six components — plus **TONU** (Trailer Order Not Used). The existing `collection_events` model (ADR-0041 D3) captured flat per-event figures but had no per-leg freight, no per-vehicle IRS mileage, and no TONU record. June production data validates the model against real numbers (Woodland `EVENTO` = $4,235.35, Event Trans = $925; OR = $0 — the zero case falls out naturally).

## Decisions

### D1 — Event components extend `collection_events`, not a new event model

Three scalar columns added to `collection_events` (reuse over duplication):

- `driver_onsite_hours` `Decimal(5,2)` — driver wages bill **on-site time only**; roundtrip drive time already lives in `labor_hours` (§5.3 items 3–4).
- `per_diem_days` `Int` — overnight days on event (§5.3 item 5; rare — Happy Camp is the example).
- `overnight` `Boolean` default false — flags the rare overnight stay.

Amounts stay stored-as-entered (the ADR-0041 D3 discipline); the generator derives cents.

### D2 — `event_legs` — per-leg Event-Mile-Rate tier freight (§5.3 items 1–2)

A drop + next-day pickup is **two legs**, each tier-priced separately; a same-day loaded event is one `same_day` leg on the standard mileage rate. `EventLegType { drop | pickup | same_day }`. `tier_lookup_miles` resolves against the **CA `transport_rate_tiers`** set — the same table ADR-0040 already uses for the Event Mile Rate; **no second table** (ADR-0040 D7 was explicit). `rate_cents` is the resolved per-leg amount (null until the generator resolves it). Bare-scalar FK `event_id → collection_events.id`, `ON DELETE CASCADE` (legs are children of their event).

### D3 — `event_vehicles` — per-vehicle IRS mileage (§5.3 item 6)

Per-vehicle facility→event→facility mileage at the **IRS-guideline** rate (not the SVDP rate). No vehicles master exists, so `vehicle_label` is free-text (documented). Bare-scalar FK `event_id → collection_events.id`, CASCADE.

### D4 — Rate constants reuse `state_program_rules` — only `irs_mileage_rate` is new

The labor / driver / per-diem event constants **reuse** the existing `StateProgramRuleKind` values `general_labor_hourly`, `driver_hourly`, `per_diem_nightly` — no duplicate kinds. Only `irs_mileage_rate` is added to the enum. **No rate rows are seeded:** the current-year IRS figure (and the labor/driver/per-diem amounts) are **not in the handoff**, and inventing a monetary value is forbidden (rollup §15 DO-NOTs). The named resolver fails loud when no row is in force (the ADR-0037 D1 pattern), so a missing rate can never silently bill $0. Rick/Bill supply the figures → a one-row seed, never a code change.

### D5 — `tonu_billing` — Trailer Order Not Used

Driver dispatched but could not drop the trailer. Rick: cancelled **before** dispatch → no bill (no row); cancelled **after** dispatch **or** diverted → billed at the haul rate (Woodland Primary rate, PR #128 §3.5). Table: nullable `event_id` FK (`ON DELETE SET NULL` — a money record is detached, never auto-deleted, if its event is removed), `site_id`, `dispatched_at`, `cancelled_at`, `diverted`, `haul_rate_cents`, `billed_cents`, `source`, `locked_at`. Amounts null until resolved (never invented).

### D6 — Pure compute layer prices the six components (`src/lib/event-billing/compute.ts`)

`computeEventBilling(input, rates) → EventBillingBreakdown` is a **pure** function (no DB, no clock, no I/O — the ADR-0041 `invoices/generate.ts` discipline), so the money math is exhaustively unit-testable. It takes a captured event projection (legs, hours, days, vehicles) + **resolved rate constants** and returns integer-cents lines. The DB-fetch layer (the future invoice-generator caller) resolves the constants from `state_program_rules` / `transport_rate_tiers` and calls this. The six §5.3 components map as:

1. **Same-day loaded freight** — a `same_day` leg, priced by mileage band.
2. **Drop + next-day pickup** — two legs (`drop`, `pickup`), **each tier-priced separately** via the existing `resolveEventMileRateCents` over the CA `transport_rate_tiers` set. Both leg kinds resolve against the **same** tier set today (ADR-0040 D7 — no second table); if a distinct "standard mileage" table ever materializes, the resolver takes a second tier set. Σ leg rate = `eventTransportationCents` → GP "Event Trans" → folds into `MILES 0` (§9).
3. **Labor** = `laborHours × general_labor_hourly` (roundtrip Woodland→event→Woodland travel counts as labor).
4. **Driver wages** = `driverOnsiteHours × driver_hourly`. The function reads `driverOnsiteHours` and **never** `laborHours`, so drive time cannot double-count (§5.3 item 4) — enforced structurally, not by subtraction.
5. **Per diem** = `perDiemDays × per_diem_nightly`, **billed only when `overnight` is true** (0 otherwise, even if a day count leaked into capture).
6. **IRS mileage** = `Σ vehicle miles × irs_mileage_rate` (cents/mile, IRS-guideline NOT SVDP).

### D7 — Fail-loud on any unseeded-but-billable rate (never guess, never silent $0)

A component is priced only if it has a **billable quantity**. A component with no quantity (no legs, zero hours, not overnight, no vehicle miles) contributes 0 and needs **no** rate — so an OR / zero-activity event totals $0 with every rate constant null (the §5.3 "OR June had $0 event activity" case falls out naturally). But when a component **is** billable and its rate constant is null/unseeded, the function throws `EventRateUnavailableError` (409) rather than bill a guessed rate or a silent $0 — the ADR-0037 D1 resolver discipline, extended to the constant-injection boundary. An out-of-range freight leg throws the reused `EventMileRateOutOfRangeError` (422). This is why **no rate rows are seeded** (D4): the current-year IRS / labor / driver / per-diem figures are not in the handoff; a billable event simply refuses until Rick/Bill provide a one-row seed.

### D8 — TONU billability is a pure verdict (`src/lib/event-billing/tonu.ts`)

`assessTonu(input) → TonuAssessment`. Rick's rule (§5.3): cancelled **before** dispatch → not billable; cancelled **after** dispatch **or** diverted → billed at the site Primary haul rate (Woodland per PR #128 §3.5). Diversion is an independent trigger and wins over cancel timing. A billable TONU with a null `haulRateCents` throws `TonuHaulRateUnavailableError` (409) — same never-invent discipline. The verdict is a discriminated union (`{billable:false, reason}` | `{billable:true, reason, billedCents}`) so the caller can persist the outcome onto a `tonu_billing` row without re-deriving it.

### Integration point (owned by the invoice feature work / integrator)

`src/lib/event-billing/index.ts` is the public surface. The CA Transportation + Processing generator (`src/lib/invoices/generate.ts` / `generation-inputs.ts`) is the intended consumer:

- `eventTransportationCents` → the `MILES 0` aggregate line, summed with regular freight + container rental (§9).
- `laborWagesCents + driverWagesCents + perDiemCents + irsMileageCents` → the `EVENTO` event-labor aggregate (CA only). **The exact EVENTO membership — in particular whether IRS mileage rides `EVENTO` or `MILES 0` — is the invoice generator's call against the real §10 reconciliation (Woodland June `EVENTO` = $4,235.35, Event Trans = $925);** this module deliberately keeps the six components separate rather than pre-baking the GP grouping.
- TONU is a separate captured record; its `billedCents` rides the Transportation invoice as its own term (mapping TBD by the invoice agent).

## Consequences

- Additive, ADR-0035-clean migration (`20260730_adr0037b_addendum_b_schema`); replays on an empty PG16 in CI. Bare-scalar FKs keep each block self-contained (the `collection_events` / `state_program_rules` convention).
- Zero billing behavior change until the generator is wired; pilot mode remains default.
- Open (soft): the labor/driver/per-diem/IRS rate values await Rick; `tonu_billing` and the legs/vehicles capture UI are feature-agent follow-ups.

## Test plan

- Migration `prisma migrate deploy` on a clean PG16 + `migrate diff` shows only the intended bare-FK pattern (no column/enum drift) — verified.
- `state_program_rules` resolver already fails loud on a missing kind (existing tests); the new `irs_mileage_rate` kind inherits that path.
- Compute layer covered by `src/lib/event-billing/compute.test.ts` (16 tests) + `tonu.test.ts` (7 tests), all pure: each §5.3 component priced with stub rates, per-leg independent tier pricing, the driver-vs-labor no-double-count invariant, per-diem-only-when-overnight, out-of-range freight refusal, `EventRateUnavailableError` on every unseeded-but-billable component, the zero-activity event totaling $0 with all-null rates, and TONU's four billability cases + haul-rate refusal. Run: `npx vitest run src/lib/event-billing`.
- Generator-side math (folding `eventTransportationCents` into `MILES 0`, the `EVENTO` aggregate, TONU line placement) is tested when the generator consumes this module.
