# ADR-0041 — Invoice generation (data-driven invoices, immutable versions, minimal event capture, DR3# sequences)

**Status:** Accepted (2026-07-04, approved by Bill — D1–D6 walked through and approved individually)
**Date:** 2026-07-04
**Relates to:** mission record §3/§3.1/§4/§6-P2; **Addendum B** §B1 (commodity/source
model), §B2/B3 (freight/fuel — priced by ADR-0040), §B4/B5 (inventory + parameterized
constants), §B6/B10-6 (document-number sequences), §B8 (event cost formula); ADR-0037
(loads/inventory foundations, `state_program_rules`, verify gate); ADR-0039 (3-way
audit billing-trust gate `gateForWindow`); ADR-0040 (rate infrastructure — the tables
this layer reads)
**Series:** third of the P2 trio — 0040 rate infrastructure, **0041 invoice generation
(this)**, 0042 COR generator

## Context

P2 renders invoices from data. ADR-0040 put every rate into effective-dated tables;
this ADR makes invoice construction a pure read of `state_program_rules` + those rate
tables + operational data, produces immutable invoice versions with per-line
provenance, and puts Rick's approval behind the ADR-0039 billing-trust gate. It also
closes the last two capture gaps the invoice math needs but that no surface yet
records: **collection events** (satellite runs billed as freight + labor, §B8) and
the **DR3# document-number sequence** (§B6/B10-6).

The build is split across two parallel agents to avoid collision:

- **Capture half** — `collection_events`, Oregon collection-site counts, and DR3#
  document-sequence issuance (this half; see the post-acceptance notes below).
- **Engine half** — `invoices` / `invoice_lines` schema, the §3.1 generation math,
  the approval flow, and the rendered outputs.

## Decisions

### D1 — Immutable invoice versions with line provenance _(engine half)_

An invoice is generated as an immutable version; a regeneration is a new version, not
an edit. Every line carries provenance (which rule/rate row and which operational
records priced it) so the retro-audit can trace any number back to its inputs.

### D2 — §3.1 math is pure computation over data _(engine half)_

All inputs are now data (ADR-0037 operational records + ADR-0040 rates +
`state_program_rules`). The invoice engine computes; it never re-types a rate or a
total. Mid-month cutoff, offset lines, and the commodity→billing-block mapping
(B10-5, pending Kelsey/Janette) resolve here.

### D3 — Minimal capture: collection events, OR counts, DR3# sequences _(capture half)_

- **`collection_events`** — the daily-log Events tab (§B4/§B8). Per-event capture of
  freight, driver/labor hours + wages, mileage, per diem, and misc. Wage amounts are
  **stored as entered**; the B5 rules (`driver_hourly`, `general_labor_hourly`,
  `per_diem_nightly`) only **default** blank wages from hours × rate — deviation is
  derivable, never flagged. Money math lives in the engine half; this is capture only.
- **Oregon collection-site counts** — hand-entered monthly per-location unit counts
  (Eugene/OR only; the $2.25/unit rate stays in `state_program_rules`; no invoice
  math here).
- **DR3# document-number issuance** (§B6/B10-6) — a per-site atomic counter
  (`document_sequences`); Woodland-style (CA) loads get a Vision-assigned DR3# at the
  office verify step; Eugene (OR) does not. **Material # is MyMRC-owned and is never
  issued by Vision.**

### D4 — Rick's approval behind the billing-trust gate _(engine half)_

Invoice approval for a window is gated on the ADR-0039 3-way audit
(`gateForWindow`) — an invoice cannot be approved for a window the audit does not
trust.

### D5 — Rendered outputs _(engine half)_

Invoice/summary/offset-line renders + the GP export path.

### D6 — Parity acceptance

The generated July invoice must reproduce the parallel July workbook to the mission
§4 parity checklist during Kelsey's validation window.

## Out of scope

COR generation (**ADR-0042**); the commodity→billing-block mapping remains pending
Kelsey/Janette (B10-5) at acceptance; TONU handling parked on the open register.

## Consequences

- Invoice construction becomes a pure, auditable read.
- Three new capture tables + one nullable `inbound_loads.dr3_number` column, all
  additive.
- The DR3# counter must be aligned to the real current counter before go-live (see
  the operator doc).

---

## Post-acceptance implementation notes

### Capture half (2026-07-04)

Delivered as migration `20260706b_events_and_sequences` (sorts after ADR-0040's
`20260706_billing_rate_infrastructure`, before the engine half's `20260707…`) +
`src/lib/events/*`, the manager routes under `src/app/api/manager/[site]/events`
and `…/or-counts`, two new tabs on the loads/inventory surface, and the DR3#
wiring in the verify gate. Specifics worth recording:

- **Schema isolation via DB-level FKs (deliberate, mirrors ADR-0040).** All capture
  additions live in ONE contiguous end-block; `site_id` columns carry DB-level
  FOREIGN KEY constraints created in the migration rather than Prisma relations, so
  there are **no back-relation fields on the sibling-touched `Site` model**. The one
  exception is the scalar `inbound_loads.dr3_number` column (a column can't live in an
  end-block). Consequence: `prisma migrate dev`/`db pull` would see the FK as "drift",
  but `migrate deploy` clean-replay (ADR-0035) passes and referential integrity is
  enforced at the DB.

- **Mileage interpretation (flagged for review).** The workbook Events tab has a
  single "Mileage" column that the §3.1 **B8** formula
  (`driver wages + labor wages + mileage + per diem + misc`) treats as **dollars**.
  To lose nothing, `collection_events` stores **both** `mileage Int?` (informational
  miles) and `mileage_cents Int?` (the billed dollars). **`mileage_cents` is what
  bills**; `mileage` is reference only. Freight is a **distinct** B8 term (its own
  column), never folded into the event's misc total. `eventMiscCents(row)` sums
  exactly the five B8 ancillary terms (driver wages + labor wages + mileage_cents +
  per diem + misc), freight excluded.

- **Cross-agent seam.** The engine half codes against `EventCostRow` (exported from
  `src/lib/events/types.ts`) — the billing projection (`event_date`, `site_id`,
  `freight_cents`, and the wage/mileage/per-diem/misc cents). `listEventCostRows`
  (service) is a ready date-window read the engine can reuse. Do not rename either.

- **Wage defaults are best-effort, not money-owning.** Unlike `consumer_dropoffs`
  (where the incentive IS the system-computed billed number and a missing rule
  throws), event wages are entered data; a missing wage rule leaves the wage null
  and logs at debug rather than blocking capture.

- **DR3# issued at verify, atomically.** The office verify step is where a load
  becomes a confirmed record, so DR3# is issued there (not at operator load-start —
  that would burn numbers on rejectable loads), inside the verify transaction so a
  failed verify rolls the counter back. `issueDocumentNumber` uses a single
  `UPDATE … RETURNING` (row-lock serialized) — a 64-way concurrent-issue test against
  Postgres yields 64 unique contiguous numbers. Woodland's counter is seeded at a
  safe-high `5000` (> the observed June ceiling 4805); **operator must align it to the
  real counter before go-live** (runbook: `docs/operator/events-and-sequences.md`).
  Trigger is `jurisdiction == california` FOR NOW with a `TODO(ADR-0041 / B10-6)` to
  become a per-site config flag once Janette confirms per-site vs. company-wide.

### Engine half

The engine half merged in PR #58 (`e76aed6`, 2026-07-04) with these implementation
decisions: the **trust gate enforces at approval** (drafts always generate as
non-billable previews with the gate verdict shown read-only — D4's "non-draft"
reading); **only leaf lines are persisted** (B6/B7/B8/B20/`B22.offset`) with
B15/B22 derived at read so `total_cents == Σ lines` stays exact (the xlsx
re-inserts a B15 subtotal for parity); the **zero-guard fires on the processing
charge** (B6/B20), not the net — a fully-pre-billed CA-EOM legitimately nets 0;
**B7 keys on `dropoff_date`** in-window as the paid-in-window proxy; renders are
xlsx (Summary structure, commodity blocks excluded per D5) + the frozen
`invoice_export` JSON v1 (contract test). Integration wiring (post-merge):
`event-leg.ts` reads `collection_events` directly with generated types, and
`or_collection_site_count` invoices compose from STORED `or_collection_site_counts`
rows first, request lines appended. **Deliberate duplication note (audit
2026-07-04):** `EventCostRow`/`eventMiscCents` exist in BOTH `src/lib/events/types.ts`
(capture-side, nullable cents) and `src/lib/invoices/types.ts` (billing-side,
non-null cents + customer/retracId) — billing uses ONLY the invoices copy via
`event-leg.ts`; the events-side `listEventCostRows` seam is currently uncalled and
is retained as the capture module's public read API. If the B8 term set ever
changes, change `src/lib/invoices/types.ts` (the billed copy) first.

### Addendum — 2026-07-09 (Mary's survey: explicit Trade discount + correction paths)

Mary Scott's survey response (campaign `dr3-intel-2026-06`; 2026-07-09 rollup §1)
amended two engine-half decisions. Built the same day (rollup §8.1 items 3–4):

- **D5 amendment — the GP "Trade discount" is explicit data, not a rendering
  artifact (§1.3).** The B22.offset line already carried the honest negative,
  but the GP EOM invoice structure Mary types is three specific lines: gross
  month total → **Trade discount** (the mid-month bill) → balance due. New
  nullable columns `invoices.trade_discount_cents` +
  `trade_discount_reference_invoice_id` (self-FK to the referenced mid-month
  invoice) are populated on `ca_processing_eom` generation
  (`resolveMidMonthOffset` now returns the reference id; null when the offset
  was recomputed with no mid-month invoice on file). The stored offset line's
  description now speaks GP ("Trade discount — mid-month processing already
  invoiced"); the summary render frames CA-EOM as Gross month total →
  Trade discount → **Balance due**. Line codes, stored leaves, and the
  total==Σlines invariant are unchanged. The frozen `invoice_export` v1
  contract is deliberately NOT touched — the GP adapter consumes the new
  columns when it lands (still blocked on Mary's packet), as a reviewed
  version bump.
- **D1 amendment — TWO correction paths, not one (§1.4).** Under-billed →
  void-and-reissue: the existing supersede chain, unchanged. Over-billed → a
  **credit memo whose application REQUIRES MRC's acceptance** (unlike
  ADR-0028/0029 bonus amendments, never admin-unilateral): new `credit_memos`
  table + state machine `proposed → sent_to_mrc → accepted | rejected;
accepted → applied; rejected → void_and_reissue_triggered` (the reissue step
  generates the superseding draft via the supersede chain and records its id).
  Transitions are typed-409-enforced + audited
  (`src/lib/invoices/credit-memos.ts`; manager-surface routes under
  `/api/manager/[site]/credit-memos`). Admin UI for memos is a follow-up —
  the API + machine ship first so the correction ledger exists from day 1.
- Migration `20260717_trade_discount_credit_memos_verify` (additive,
  clean-replays on empty PG16 per ADR-0035; also carries the ADR-0039 note's
  `users.can_view_billing_verify`).

**§D review items (open, from the rollup):** (1) whether the GP adapter's
export should carry the trade-discount fields as a v2 contract bump or a
side-channel; (2) credit-memo admin UI shape (list + transition buttons on the
invoice detail vs a standalone queue); (3) whether a credit memo should
soft-link to the ADR-0039 finding that motivated it (provenance chain
finding → memo → superseding invoice).
