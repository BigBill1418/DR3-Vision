# ADR-0043 — P3 alerts: recycling/recovery rate monitoring + missing-record detection (thin, rides the audit engine)

**Status:** Accepted (2026-07-04, approved by Bill)
**Date:** 2026-07-04
**Relates to:** mission record §2.1 (2)/§6-P3; forward handoff §3.3 ("propose as a thin ADR — much of the plumbing exists in 0039"); ADR-0039 (findings/config/sweep machinery — REUSED, not duplicated); charter §1.5 (75%/70% contract rates, formulas); survey build-inputs §E (Morena's exceptions) + §B (explain-don't-flag)
**Series:** P3, first post-P2 ADR

## Context

The contract stakes: CA requires **75% recycling by weight** (termination
grounds), OR **70%** with the broader formula that credits renovation; missing
records feed the 10% Service-Level withhold. Kelsey watched these by feel; MRC
computes the official numbers from MyMRC on their own schedule — so Vision's job
is **early warning before MRC sees a breach**, not the official calculation.
This ADR is deliberately thin: rates and gaps become **new check codes in the
ADR-0039 audit engine** — same nightly sweep, same findings lifecycle, same
`audit_check_config` thresholds, same review surface. No new pipeline.

## Decisions

### D1 — Rate computations: pure, per-jurisdiction, honest about estimates

`src/lib/rates/` pure functions over a date window (rolling 9 months default —
the CA reconciliation window; window per-check config):

- **Recycling rate (weight):**
  `recycled_lbs ÷ (recycled_lbs + disposed_lbs)`.
  `recycled_lbs` = Σ `outbound_materials.weight_lbs` for non-`trash`
  commodities (all sub-categories) — pending the B10-5 destination mapping,
  `trash` is conservatively counted DISPOSED even where its vendor is WTE
  (under-counts the rate → alerts early, never late; flips per-row when B10-5
  lands, no schema change).
  `disposed_lbs` = `trash` weights + `landfilled_units.units ×
  unit_weight_estimate` (55 lb, `estimate_only:true` — every figure derived
  from it carries an `estimated: true` marker into the finding detail).
- **Recovery rate (units, OR formula shape):**
  `(processed + renovated_whole_units) ÷ (processed + renovated_whole_units +
  landfilled_units)` — the renovation channel counts per MRC rules (mission
  §2.1(2), Addendum-B renovation sub-category rows supply `whole_units`).
- Both return `{ rate, numerator, denominator, components, estimatedInputs }` —
  the *why* travels with the number (Morena Q4: show why, not just red/green).

### D2 — Four new check codes on the existing engine

Registered exactly like C1–C7 (comparator fn + `audit_check_config` row +
fingerprinted findings; nightly sweep + on-demand run pick them up with zero
scheduler changes):

| Code | Check | Default config (data, editable) |
|---|---|---|
| R1 | Recycling rate over the rolling window below `contract_floor + margin` | CA floor 75 / OR floor 70, margin **3pts** warn · 1pt high |
| R2 | Recovery rate below floor + margin (renovation-inclusive) | same pattern |
| M1 | Missing daily close: a business day (site calendar-aware via `site_holidays`) with inbound activity but no `processed_units_daily` row by EOD+1 | grace 1 business day |
| M2 | Missing physical snapshot: no `snapshot_kind=physical` row within N days (the reconcile cadence backing the COR + quarterly MRC counts) | N=35 days |

Findings carry `cause_category` as usual — a low rate from a data gap (M1 open
for the same window) is annotated as likely-data, not operational (the
explain-don't-flag principle: R-findings link any concurrent M-findings).

### D3 — Delivery: in-app first, one daily digest email, ntfy unchanged

- **In-app:** R/M findings land in the existing findings queue + two dashboard
  rate tiles (current rolling rate vs floor, trend arrow, `estimated` badge
  when the 55-lb estimate contributes) on the site dashboard.
- **Email digest:** one per site per day at 07:00 PT (piggybacks the existing
  daily-report cron tick — no new container), sent ONLY when open R/M findings
  exist (no "all OK" spam; ADR-0037-fleet digest discipline). Recipients from a
  small `alert_recipients(site_id, email, active)` config table — seeded
  Morena + Janette (Woodland), Rick (Eugene); admin-editable. Rides
  `sendSystemEmail` from `dr3-vision@svdp.us`.
- **ntfy: unchanged** — operational findings NEVER push (hard rule #5); the
  only pages remain sweep-failure system events, Bill-only.

### D4 — Observability (standing directive)

Rate computations log window/components at debug; every emitted finding logs
code/site/rate/threshold; digest send logs recipients + finding count; digest
send failure pages `dr3-vision-system` fingerprinted (system-level: the alert
channel itself failing IS a system event).

## Out of scope

Bethany's board-pack cadence + DR3 Updates digest (P5) · Terex/downtime (P4) ·
dispatch↔Outlook (open register) · processor bonus-standing view (parked quick
win — needs its own green-light) · any MRC-official rate reporting (MRC
computes their own; Vision is early warning) · dock SLA/compliance-dashboard
tiles already shipped in earlier phases.

## Consequences

- One new config table (`alert_recipients`) and one migration; everything else
  is check registrations + pure functions + two tiles + a digest hook.
- The 75%/70% early-warning gap Kelsey covered by intuition becomes a nightly
  computation with a 3-point head start and its causes attached.
- The 55-lb estimate is visible everywhere it touches a number — when Kelsey's
  `%`-column semantics and B10-5 land, precision improves without redesign.

## Test plan (summary)

Rate pure-function matrices (both jurisdictions, renovation credit, zero
denominators → typed no-data result not division blowup, estimate flagging) ·
R1/R2 threshold boundary at floor+margin exactly · M1 business-day/holiday
calendar cases + grace · M2 cadence · R↔M cross-annotation · digest: sends only
on open findings, recipient config respected, failure pages · config
edit-ability via audit_check_config rows · migration clean-replay (CI).

## Post-acceptance notes (built 2026-07-04)

Implemented as a thin build on the ADR-0039 engine. What landed, and where it
diverged from the plan:

- **Migration `20260709_alert_recipients`** (clean-replayed on a fresh PG16):
  four `AuditCheckCode` enum values + `alert_recipients` +
  `alert_digest_logs` (the `(site, digest_date)` idempotency ledger — D3 needs
  it and it rides this migration). Recipients seeded idempotently in
  `prisma/seed.mjs` (Morena + Janette → Woodland, Rick → Eugene). The new enum
  values are not referenced in the migration (config seeds live in code), so the
  Postgres "new enum value in the same transaction" rule never applies.
- **Rate functions** live in `src/lib/rates/` (pure) with the DB aggregation in
  `rates/aggregate.ts` (shared by the nightly check AND the dashboard tiles, so
  the tile number and the finding number can never drift). Thresholds resolve in
  `rates/thresholds.ts` (per-jurisdiction floor from `audit_check_config` params).
- **Checks** are `comparators/{r1-recycling,r2-recovery,m1-missing-close,m2-missing-snapshot}.ts`,
  wired into `leg-fetchers.buildRunChecksForWindow`. R1/R2 run over a rolling
  ~9-month window (config `rate_window_days`, default 273), DISTINCT from the
  sweep's trailing window; their fingerprint is window-normalized (`[siteId]`)
  so a persisting low rate updates one finding. Fingerprints include `siteId`
  (unlike C5/C6, which key on day only) to stay cross-site collision-safe.
- **Floors are data.** R1/R2 config params carry `ca_floor_pct: 75`,
  `or_floor_pct: 70`, `warn_margin_pts: 3`, `high_margin_pts: 1`; the resolver
  picks the floor by site jurisdiction. Editable per-site via an
  `audit_check_config` row (global default overlaid by a per-site row).
- **Digest** is `src/lib/audit/alert-digest.ts`, invoked by the internal
  daily-report route AFTER `runDailyReportFire`. It runs for ALL sites
  independent of the production-report skip gates (so a quiet/weekend day never
  suppresses an alert), sends only when open R/M findings exist, and is
  idempotent through `alert_digest_logs`.
- **DEVIATION — digest fires at the daily-report tick time (18:00 PT), not
  07:00 PT.** D3 assumed a 07:00 tick to piggyback; the only existing
  daily-report cron tick fires at each site's configured `send_time_pt` (18:00
  PT today). Honouring the binding "no new container / piggyback the existing
  tick" constraint, the digest inherits that tick. The `(site, digest_date)`
  dedup ledger keeps it to one email per site per day regardless of when the tick
  lands. To move it to 07:00, add a dedicated 07:00 daily-report config send
  time (or a small standalone tick) — no code change to the digest.

## Operator follow-ups (non-blocking)

1. **Digest send time (07:00 vs 18:00).** If Bill wants the digest at 07:00 PT
   rather than riding the 18:00 production-report tick, decide whether to shift
   the daily-report `send_time_pt` or add a second tick. Tracked as the deviation
   above.
2. **Recovery-rate floor.** R2 defaults to the same 75/70 jurisdiction floors as
   R1 ("same pattern" in the ADR). If MRC's recovery-rate contract floor differs
   from the recycling floor, set R2's `ca_floor_pct`/`or_floor_pct` via an
   `audit_check_config` row — no code change.

## Amendment 1 — bootstrap gating + digest under the rollout gate (2026-07-07)

M1/M2 inherit ADR-0039 Amendment 1's leg-liveness bootstrap gating. The daily
digest becomes a registered `notification_surface` under ADR-0047, seeded
**pilot** (the 2026-07-06 incident surface): output reroutes to admins with the
would-have-sent header until Bill flips it live per §8 Stage-4 criteria
(≥5 clean reviewed pilot digests + ≥1 true finding handled end-to-end).
