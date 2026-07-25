# ADR-0060 — iPad floor inventory-validation surfaces (confirm inbound / on-hand / processed)

**Status:** Accepted (2026-07-25)
**Date:** 2026-07-25
**Relates to:** ADR-0059 (MyMRC inbound bridge — this ADR builds the iPad floor-confirmation endpoint
whose CONTRACT that ADR specified but left unbuilt), ADR-0058 (processed bridge + floor-probe), ADR-0037
(running balance / `inbound_loads` / `paper_bulk` aggregate / physical-count reconcile), ADR-0047 (rollout
gate), ADR-0030 (operators single-site, never super-admin), `#166` (manager `paper_bulk` path).
**Build spec:** `docs/plans/2026-07-25-ipad-floor-surfaces-buildout.md`

## Context

The running balance (`src/lib/inventory/running-balance.ts`, `onHand`) computes inventory as
`anchor + Inbound + dropoffs − Stripped − wholeUnitsSold − landfilled`. ADR-0058/0059 wired the `Stripped`
and `Inbound` legs from the MyMRC mirrors, so on-hand now both rises and falls automatically — but every
bridged inbound row is **provisional** (`load_source_type='mymrc_haul'`). ADR-0059 D4 defined the
provisional→confirmed lifecycle and stated the iPad floor-confirmation endpoint's contract (retire the
`mymrc_haul` aggregate for a day, install the confirmed inbound, in one audited transaction — the same
delete-then-write shape `upsertBulkInboundDay` already implements), but **left that endpoint and its UI
unbuilt.**

The operator believed the iPad floor surfaces were complete. Ground truth (live prod DB on CHAD-HQ + `main`
at `ad93b61`, verified 2026-07-25): the iPad **shell + PIN auth + a per-load dock-capture workflow** are
built and polished (Eugene go-live), but there is **no floor surface and no floor endpoint** to confirm or
log the day's inbound haul counts, confirm on-hand inventory, or confirm processed counts. Prod proves it:
610 provisional `mymrc_haul` inbound rows, **0 `paper_bulk`, 0 per-load `b2b_haul`** — no confirmation of any
kind has ever occurred, and the per-load dock flow has never produced a row. `src/app/api/operator/**` does
not exist. Eugene has no physical anchor and no inbound provisional at all. The day-to-day inventory
validation layer Bill described ("when the iPads come online we verify that data for confirmation
day-to-day") is the missing piece.

## Decision

Build the floor role's **inventory-validation surfaces** on the existing operator iPad shell, completing the
ADR-0059 confirmation contract and extending it to on-hand and processed counts. Full route/component/API/DB
detail is in the build spec; the load-bearing decisions:

### D1 — Three floor surfaces + a hub, on the existing operator PIN shell
`/operator/[site]/today` (hub), `/operator/[site]/inbound` (confirm/correct/enter the day's inbound),
`/operator/[site]/count` (physical on-hand → new anchor), `/operator/[site]/processed` (confirm processed
count — P2). Green outdoor palette, i18n (en/es/ur), tap targets ≥44px, no desktop-only interactions. The
existing per-load dock-capture queue stays reachable and coexists (different grain — see D5).

### D2 — Floor auth via a new `requireOperatorForSite` helper
Mirror `requireManagerForSite`: session-derived, `role==='operator'`, `primary_site_id===site.id`; 401/403
typed `Response`s. Every write re-derives operator + site server-side (never client-trusted). Floor surfaces
respect the existing per-site `loads_inventory` rollout flag (ADR-0047) so sites flip independently.

### D3 — Inbound confirmation writes a dedicated `ipad_floor` tier, reusing the ADR-0059 delete-then-write contract
A new `src/lib/loads/floor-inbound.ts` `confirmFloorInboundDay` performs, in one audited transaction: the
per-load coexistence guard (D5), retire the day's `mymrc_haul` provisional (audited delete), then upsert one
aggregate row `load_source_type='ipad_floor'`, `status='verified'`, `count_mode='total'`, absolute SET of
the counts, keyed to Pacific-midnight of the delivery day (byte-identical to `bulk-inbound.ts` /
`inbound-bridge.ts` so `onHand`'s inbound window matches). Precedence becomes
**`ipad_floor > paper_bulk > mymrc_haul`** (honoring ADR-0059 D4). A day owned by an office `paper_bulk` row
is refused on the floor (409 — office amends via the manager surface); the bridge only ever touches
`mymrc_haul`. One additive migration (`20260812`) adds the `ipad_floor` enum value and widens the ADR-0059
partial unique index to `IN ('paper_bulk','mymrc_haul','ipad_floor')` so at most one aggregate row can exist
per (site, day) across all three provenances — the DB-level double-count guard, unchanged `onHand` money path.

### D4 — On-hand + processed reuse the existing money paths, actor = operator
On-hand count → `reconcilePhysicalCount` (writes a `physical` snapshot with the audited `reconciled_delta`,
`countedAt` at Pacific-midnight per `anchorFlowBounds`). Processed → `upsertProcessedUnits` (refuses closed
days 409, idempotent). No new money math; the floor is a new *caller* of proven services. **Close/lock stays
admin** — the floor confirms, never closes.

### D5 — Aggregate-vs-per-load double-count guard (money-safety)
`onHand` sums all verified inbound regardless of source type, so an aggregate row plus per-load `b2b_haul`
rows for the same day would double-count (the partial unique index only bars two *aggregate* rows).
`confirmFloorInboundDay` refuses (409) any day that already has verified per-load rows. Latent-safe today
(0 per-load rows) but made explicit before either grain goes live.

## Alternatives considered

- **Floor-confirmed provenance — (a) new `ipad_floor` tier [chosen], (b) reuse `paper_bulk`.** (b) is
  zero-migration and reuses `upsertBulkInboundDay` verbatim, but collapses ADR-0059 D4's three-tier
  precedence to two and loses source-type-level floor-vs-office distinction (still recoverable from
  `audit_log`). (a) honors the accepted ADR-0059 D4 precedence literally, gives clean report/audit labeling
  and a real "floor beats office" rule, and the migration is additive/reversible — a direct mirror of
  ADR-0059's own `20260810`. Flagged for Bill (spec §7-A1) with (b) as the documented fallback.
- **Grain — (a) per-day aggregate confirmation [chosen for this layer], (b) revive per-load dock capture as
  the daily flow.** Bill's directive is explicitly day-to-day ("verify that data for confirmation
  day-to-day"); the provisional data is a per-(site,day) aggregate. Per-load capture (b) exists, is
  high-fidelity, and stays available for truck-by-truck use, but it is not the validation layer Bill asked
  for and requires `ExpectedLoad` sync + per-truck staffing. Both coexist under the D5 guard.
- **Processed floor entry — (a) confirm-only, P2 [chosen], (b) full manager-parity entry on iPad, (c) omit.**
  Processed already has a MyMRC bridge + manager Option-B + separate bonus capture, so (b) is redundant
  surface and (c) leaves "counts" half-covered. (a) lets the floor confirm the core stripped counts while
  payroll-adjacent fields stay on the manager surface. Flagged (spec §7-A2).
- **Auth — (a) dedicated `requireOperatorForSite` + `loads_inventory` rollout gate [chosen], (b) inline
  per-route checks, (c) open to managers too.** (b) duplicates the `actions.ts` pattern across routes; (c)
  muddies the audit actor. (a) is one testable helper, operators-only, consistent with the rollout gate.

## Consequences

- The floor gains its day-to-day inventory-validation loop: confirm/correct inbound haul counts, establish
  and re-anchor on-hand, and (P2) confirm processed counts — all money-safe, audited, and reusing the
  ADR-0037/0058/0059 services. Provisional `mymrc_haul` inbound can finally be upgraded to floor-confirmed;
  ADR-0059 D6's provisional label auto-drops when a day becomes `ipad_floor`.
- Eugene, which has no physical anchor and no inbound provisional (C-21 pending), can establish its first
  anchor from the floor (`/count`) and enter inbound manually — value before C-21 lands.
- One additive, reversible migration (`20260812`); `onHand`'s money path is unchanged.
- **Money-safety finding surfaced (D5):** the ADR-0059 bridge shares the aggregate-vs-per-load latent
  double-count gap. This ADR closes it on the new floor write path; a follow-up guard in
  `inbound-bridge.ts` (skip days with verified per-load rows) is recommended and out of scope here.
- Acceptance is gated on the fleet iPad-viewport visual-verification standard: Playwright screenshots across
  iPad Mini / 10th / Pro 12.9 in both orientations, reviewed by eye, verified on the live URL, with the
  running container (not git HEAD) confirmed to carry the routes.
- Close/lock authority is unchanged (admin only); the floor never closes a day.

## Research sources

Verified this session against the live prod DB on CHAD-HQ (`docker exec dr3-vision-postgres psql`) and the
repo at `/home/bbarnard065/DR3-Vision` (`main`, `ad93b61`): `src/app/operator/**` (shell, PIN pages, queue,
per-load workflow, `actions.ts`), `src/lib/load-service.ts`, `src/lib/loads/bulk-inbound.ts` (the confirmation
contract), `src/lib/mymrc/inbound-bridge.ts`, `src/lib/inventory/running-balance.ts` (`onHand`,
`anchorFlowBounds`, `reconcilePhysicalCount`, `VERIFIED_INBOUND_STATUSES`), `src/lib/auth.ts` /
`auth.config.ts` / `auth-helpers.ts` (PIN provider + manager helpers), `src/app/api/manager/[site]/bulk-inbound`
+ `snapshots` + `processed-units` routes, `src/app/api/internal/inventory/floor-probe`, `prisma/schema.prisma`
(`InboundLoad`, `enum LoadSourceType`/`LoadStatus`, the partial unique index), and the DB probes recorded in
the build spec §0 (inbound-by-source, operators, anchors, expected-loads, Eugene emptiness). Sibling: ADR-0059
+ `docs/plans/2026-07-23-mymrc-inbound-inventory-bridge.md`.
