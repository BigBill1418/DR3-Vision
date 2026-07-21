# ADR-0056 — Event billing components + TONU line handling (schema foundation)

**Status:** Accepted — schema foundation only (2026-07-21)
**Date:** 2026-07-21
**Relates to:** `docs/handoffs/2026-07-21-mrc-billing-addendum-rick-mary-kelsey-rollup-2026.md` §5.3/§14, ADR-0037 (loads/inventory + `state_program_rules`), ADR-0040 (rate infrastructure + `transport_rate_tiers`), ADR-0041 (invoice generation)
**Scope note:** this ADR lands the **schema + rate-constant surface** for event billing and TONU. The invoice-generator wiring (compose these into the CA `EVENTO` / `MILES 0` lines per §9) is a follow-up owned by the invoice feature work; nothing here changes generated invoices.

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

## Consequences

- Additive, ADR-0035-clean migration (`20260730_adr0037b_addendum_b_schema`); replays on an empty PG16 in CI. Bare-scalar FKs keep each block self-contained (the `collection_events` / `state_program_rules` convention).
- Zero billing behavior change until the generator is wired; pilot mode remains default.
- Open (soft): the labor/driver/per-diem/IRS rate values await Rick; `tonu_billing` and the legs/vehicles capture UI are feature-agent follow-ups.

## Test plan

- Migration `prisma migrate deploy` on a clean PG16 + `migrate diff` shows only the intended bare-FK pattern (no column/enum drift) — verified.
- `state_program_rules` resolver already fails loud on a missing kind (existing tests); the new `irs_mileage_rate` kind inherits that path.
- Generator-side math (per-leg tier pricing, `MILES 0` aggregation of freight + event trans + rental) is tested when the generator consumes these tables.
