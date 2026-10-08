# ADR-0142 — The day's aggregate is the count; dock loads are tracking

**Status:** Accepted 2026-10-08 (Bill approved both fixes, 09:20 AM PDT). Extends ADR-0060 D5 to the per-load
direction and to the invoice exports.

## Decision (Bill, 2026-10-08)

> Dock (`b2b_haul`) loads are floor/haul tracking only. The per-day aggregate (MyMRC / paper / floor) is the
> inventory and billing source. Dock loads are never bulk-verified or voided.

## Context

Woodland has **374** `b2b_haul` iPad dock loads sitting at `submitted`, Pacific days 2026-07-28 → 2026-10-08
(read-only prod query, 2026-10-08). **372** carry an `external_mymrc_haul_id` that matches a row in
`mymrc_hauls_mirror`; **359** of those have `total_units` equal to MRC's own `unit_count_at_unload`; and **every one
of the 374** sits on a Pacific day that already holds a verified `mymrc_haul` aggregate row, whose total is the sum
of that day's delivered hauls. So the dock loads are the **same mattresses** the aggregate already counts. None has
ever been verified, and there is no UI to verify them.

Two paths treated them as additional volume:

1. **The verify gate.** ADR-0060 D5 says an aggregate row plus verified per-load rows for the same day
   double-count in `onHand`, which sums every verified inbound row whatever its source type. The rule was enforced
   in one direction only: `confirmFloorInboundDay` and the MyMRC bridge (`skippedPerLoad`) refuse to ADD an
   aggregate to a day holding verified per-load rows. The one other path that creates a verified per-load row,
   the EOD add-line (`src/lib/eod/inbound-line.ts`), already refuses an aggregate-covered day
   (`aggregate_covers_day`, inside the site lock). `verifyLoad` (`POST /api/manager/[site]/loads/[id]/verify`)
   checked state and site only, so verifying any of the 374 would have counted that truck twice. OPEN-ITEMS L-4
   recorded the first instance (2026-07-29: one `ipad_floor` aggregate plus two submitted dock rows).
2. **The invoice exports.** `GET /api/exports/mrc` (MRC Monthly Invoice, Article 10.4) and `GET /api/exports/svdp`
   (SVdP CFO file) filtered on `INVOICE_STATUSES` alone, and that set includes `submitted`. For Woodland September
   2026 the exports therefore carried **171 dock rows / 19,414 units on top of 25 aggregate rows / 21,804 units**
   (by Pacific month: 172 / 19,545; the 172nd, 131 units at 17:04 PDT on Sep 30, lands in October's UTC-month
   window).

## Decision detail

### D1 — `verifyLoad` refuses a per-load verify on an aggregate-owned day (typed 409)

New `VerifyGateError` reason `aggregate_day_exists` (409). A load whose provenance is per-load (not
`paper_bulk` / `mymrc_haul` / `ipad_floor`) and whose Pacific day at its site holds an aggregate row in
`VERIFIED_INBOUND_STATUSES` is refused. Nothing is written and no DR3 number is drawn. A load with no `arrived_at`
has no Pacific day and is invisible to `onHand`'s window, so it is not checked.

The predicate is the existing D5 one read from the other side: the same `VERIFIED_INBOUND_STATUSES`, the same
`AGGREGATE_SOURCE_TYPES`, the same Pacific-day window. It now lives in one place,
`pacificDaysWithVerifiedAggregate` in `src/lib/loads/floor-inbound.ts`, alongside the per-load check it mirrors.
The day key is `pacificDayISO(arrived_at)`. `arrived_at` is `timestamp without time zone` holding UTC, so this is
`(arrived_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Los_Angeles'`, never the UTC date. A 19:00 PDT dock load is
matched to its own Pacific day.

**Race safety.** `verifyLoad`'s transaction now takes `lockSiteAgainstPromotion` as its first statement (ADR-0120;
it writes `inbound_loads` and previously did not), and runs the aggregate check after it. Every aggregate writer
(the MyMRC bridge, `confirmFloorInboundDay`, the paper-bulk upsert) takes the same lock first. At READ COMMITTED
the check therefore sees any aggregate one of them committed, and none can commit one between the check and the
verify's write. One advisory lock per path, as ADR-0120 requires; the DR3 counter row lock is taken after it.

### D2 — Both invoice exports take each Pacific site-day from exactly one source

New `singleSourcePerDay(siteId, loads)` in `src/lib/exports.ts`, applied by both export routes after their fetch:
a day holding a verified aggregate row is exported from that row alone, and its per-load rows are dropped. A day
with no aggregate keeps its per-load rows. The aggregate lookup uses the same `pacificDaysWithVerifiedAggregate`,
keyed on each per-load row's Pacific day rather than on the export's month window, so the Sep 30 17:04 PDT load is
dropped from October's file too.

Woodland September 2026 MRC export (read-only prod computation, route window): **before** 196 rows /
41,218 units (25 aggregate / 21,804 + 171 dock / 19,414); **after** 25 rows / 21,804 units.

### D3 — Invoice generation is NOT changed (affected differently)

`resolveTransportationInputs` (`src/lib/invoices/generation-inputs.ts`) shares `INVOICE_STATUSES`, but it bills
**freight per truck**: one leg per `transport_charged` load, priced from that load's source mileage. Aggregate rows
carry no source or mileage, and none of their three writers sets `transport_charged`, so there is no unit
double-count to remove. (The EOD checkbox `setInboundTransportCharged` can flag any row, an aggregate included; a
flagged aggregate fails loud in the freight leg, `FreightInputError` for want of a source.) Applying the export predicate would delete every freight leg on an aggregate day. Today
`transport_charged` is `false` on every row, so the leg is empty either way (ADR-0125, OPEN-ITEMS §0.BO BO-4). Once
the classifier is populated, freight will bill from `submitted` dock rows, which this ADR calls tracking-only.
Whether a dock row is the freight record while the aggregate is the unit record is Bill's decision. It is reported,
not made here.

## Alternatives considered

- **Bulk-verify or void the 374 dock loads.** Rejected by Bill's decision: they are the floor's haul record and stay
  as they are. No data row was touched.
- **Drop `submitted` from `INVOICE_STATUSES`.** It would fix September at Woodland but also drop a genuine dock-only
  day (Eugene, or a day MyMRC never delivered), and it would move the freight leg's status contract with it.
  Precedence by day is the rule the inventory already uses.
- **A second, export-local predicate.** Rejected. Two definitions of "the day is aggregate-owned" are how D5 came to
  be enforced in one direction only.

## Consequences and residuals

- The verify queue for a Woodland dock load returns 409 `aggregate_day_exists` on every one of the 374 today.
  That is correct: those days are counted.
- **Residual, the MyMRC bridge's own D5 check is not under the lock.** `inbound-bridge.ts` preloads verified
  per-load days before its per-day transactions. A verify that commits between that preload and the bridge's upsert
  of a NEW aggregate for the same day would still double-count. D1 closes the reverse order. The window is one
  bridge run, and dock verifies have no UI. Recorded in OPEN-ITEMS; not fixed here.
- **Residual, export month window is UTC.** `monthRange` bounds both exports on UTC months. Aggregate rows sit at
  Pacific midnight and always land in the right month, but a dock-only day's evening loads can still land in the next
  month's file (pre-existing; noted in `generation-inputs.ts`).
- Three dock loads that do not match a delivered haul are listed for Bill in OPEN-ITEMS, not fixed: `fce4fbc5` and
  `2b60d7ba` (no haul ID) and `3b9e6968` (points at an MRC-Rejected haul). All three sit on aggregate days, so the
  new guard refuses their verify too.

## Evidence

- `src/lib/loads/verify-gate.aggregate-day.db.test.ts` (real Postgres): refusal for each aggregate type,
  Pacific-not-UTC bucketing, allowed on a day without one, a voided aggregate does not block, and a verify racing a
  lock-holding aggregate writer waits and is refused. The race case alone goes red when only the lock line is
  removed.
- `src/lib/exports.single-source.db.test.ts` (real Postgres, real route handlers): both exports emit 4 rows /
  600 units instead of 6 / 670.
- Both were run red against f32a067 first.
