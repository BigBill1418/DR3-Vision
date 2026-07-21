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
(B10-5, pending Kelsey/Janette) resolve here. **[SUPERSEDED by Amendment
2026-07-18 §A.1 — B10-5 commodity→invoice-block mapping is CLOSED / not required:
the invoice is single-line (program units × rate + trade discount).]**

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
Kelsey/Janette (B10-5) at acceptance **[CLOSED by Amendment 2026-07-18 §A.1 — not
required for billing; invoice math is single-line]**; TONU handling parked on the
open register.

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
  `users.can_view_billing_verify` and a BACKFILL copying each pre-existing
  B22.offset line into the new columns so pre-migration invoices show the GP
  three-line block too).
- **Hardening from the same-day review pass:** the mid-month offset reference
  now prefers an APPROVED mid-month invoice only (a draft's total was never
  invoiced and voids on regenerate — persisting its id would freeze provenance
  at a voided number; no approved invoice ⇒ the recompute fallback). A 0¢
  offset with no reference stores NULL trade-discount fields (no phantom
  "$0.00 Trade discount" for Mary to hunt in GP). `generateInvoiceDraft` gains
  a write-time tripwire asserting `trade_discount_cents` mirrors the stored
  offset line (ADR-0033 philosophy). Credit-memo transitions are an atomic
  compare-and-swap (`updateMany` on `{id, status: from}`) so concurrent or
  double-submitted requests get the typed 409 instead of double-running the
  reissue; the reissue path claims first, then supersedes, and COMPENSATES the
  claim back to `rejected` if draft generation fails (e.g. the invoice was
  voided out-of-band). `createCreditMemo` bounds the amount to the invoice
  total and refuses a second open memo per invoice.

**§D review items (open, from the rollup + review pass):** (1) whether the GP
adapter's export should carry the trade-discount fields as a v2 contract bump
or a side-channel (the frozen v1 was deliberately left untouched — the adapter
is still blocked on Mary's packet); (2) credit-memo admin UI shape (list +
transition buttons on the invoice detail vs a standalone queue); (3) whether a
credit memo should soft-link to the ADR-0039 finding that motivated it
(provenance chain finding → memo → superseding invoice); (4) a memo
cancel/withdrawn state — today a memo whose invoice was voided out-of-band can
only bounce between `rejected` and a failing reissue; (5) resolver provenance
telemetry for §8.2 (flag category tabs that only resolve via the name-fallback
tier, so unconfirmed row-2 label rules fail loudly when real files land).

---

## Amendment — 2026-07-18 (SIMPLIFIED invoice generation: pilot mode, program split, GP v2 export, B10-5 CLOSED)

Rollup §A.1/§A.7/§4.2/§8.3 (Mary/Rick, July) simplify the invoice and prepare it
for the real Great-Plains boundary and the launch pilot. Built additively on the
accepted engine above (nothing rebuilt — the D1 immutable-version discipline, the
D2 pure math, the D4 trust gate, and the credit-memo / void-and-reissue state
machines are unchanged and verified to still integrate). Migration
`20260727_adr0041_pilot_mode_gp_export` (purely additive, ADR-0035 clean-replay;
sorts after `20260726_adr0040_rate_infrastructure`).

### A.1 — B10-5 commodity→invoice-block mapping is CLOSED (not required for billing)

The invoice math is **single-line**: `amount = program_units_processed × rate +
trade_discount`. There is **no** commodity→invoice-block breakdown — the processing
charge is ONE line (total program units × rate), never split per commodity. The
B10-5 commodity→invoice-block mapping that D2 above listed as "pending
Kelsey/Janette" is therefore **not needed for billing** and is closed. (The engine
never actually built commodity-block invoice math — B6 was always a single
units×rate line — so this closes an open question rather than removing code.)
Compliance/stewardship commodity classification (CalRecycle recycling rate) is a
SEPARATE concern, owned by ADR-0043/ADR-0055 recycling data, and is not part of
the invoice generator.

### §3.4 — Pilot / production mode (the launch safety net)

`invoices.mode` enum `{ pilot, production }`, **DEFAULT `pilot`**. Until Rick
reconciles and signs off, every invoice is `pilot`: its preview routes to the
**pilot recipients (Bill + Rick)** and NOWHERE else. `production` is the only mode
whose delivery plan resolves to MRC.

- **Structural (not procedural) guarantee.** `planInvoiceDelivery(mode, pilot,
  mrc)` (`src/lib/invoices/delivery.ts`) is a TOTAL function on `mode`: the `pilot`
  branch has no path — none — that returns MRC recipients or `sendsToMrc: true`.
  No configuration, argument, or roster state can make a pilot plan reach MRC. Any
  future MRC sender obtains its recipients from this plan and calls
  `assertProductionForMrc` before addressing an envelope — so a pilot invoice is
  undeliverable to MRC even by a caller that skipped the plan.
- **Config.** `invoice_pilot_recipients` (Bill + Rick, seeded) is the pilot roster.
  `invoice_mode_config` (per site+kind; no row ⇒ pilot) is the admin flip —
  `POST /api/manager/[site]/invoices/mode` (authorized like approval: admin or
  manager-of-site; `can_manage_rates` never sufficient). Generation stamps
  `invoices.mode` from this config; a superseding reissue re-reads it.
- **No live MRC sender exists yet** — the boundary ships first so the sender is a
  consumer of a proven-safe plan, not a refactor (mirrors how the frozen
  `invoice_export` boundary shipped ahead of the GP adapter). The production
  MRC roster is intentionally empty (OR's MRC identity is pending Mary; the pilot
  policy forbids real MRC sends) — a future sender treats empty as refuse-and-page.

### §8.3 — Program vs non-program split on the invoice basis

`invoices.program_units_processed` (the BILLABLE basis, Σ `stripped_program`; it
EQUALS the B6/B20 processing-line quantity — MRC pays on program units only) and
`invoices.non_program_units_processed` (Σ `stripped_non_program`; tracked for
reconciliation, NEVER billed). Both persisted on processing kinds; null on
transportation / collection-site-count. The daily-close split already existed
(`processed_units_daily.stripped_program` / `stripped_non_program`, ADR-0037 D5);
this persists the window aggregates onto the invoice so the basis is explicit on
the artifact and drives the v2 export's billable line.

### §4.2 — Two-line GP export (v2 contract; v1 FROZEN)

`invoiceExportV2` ships ALONGSIDE the frozen v1 (`export-json.ts`; v1's key set is
unchanged — the GP adapter must not re-derive from line JSON, C-1). Exposed at
`GET …/export?format=json&v=2` (v1 stays the default). v2 carries:

- The GP header identifiers (Bill-To / Ship-To, Customer ID, Sales ID, PO number,
  Payment Terms) from `gp_billing_config` (company statics) + `gp_site_billing_config`
  (per-site), the `mode`, the program/non-program split, and the trade-discount
  fields.
- The GP presentation — the §4.2 processing shape: Line 1 header
  ("total units processed M/DD/YY", Each 0 · Ext 0), Line 2 billable
  ("MRC-Processed Units DR3 <SiteName>", UNITSMO, Each <rate> · Ext <units×rate>),
  then Subtotal / Misc / Tax / Freight / Trade Discount / Total. `gp.totals.total_cents`
  is asserted to reconcile to `invoice.total_cents` at build (ADR-0033 tripwire).
- The v1 leaf `lines` (full provenance) are ALSO carried — `gp` is a presentation
  over them, never a replacement. B7/B8 (if present) surface as `Misc` — never dropped.

### §4.2 — GP identifiers: confirmed seeded, unknowns left NULL (pending Mary)

Seeded (`gp_billing_config` / `gp_site_billing_config`):

| Identifier | Value | Source |
|---|---|---|
| Bill-To / Ship-To | Mattress Recycling Council, Attn: Ryan Trainer, 501 Wythe Street, Alexandria VA 22314 | confirmed |
| Sales ID | `34` | confirmed |
| Payment Terms | `Net 30` | confirmed |
| CA processing rate | `state_program_rules` $16.50/unit (reused, not re-seeded) | confirmed |
| CA (Woodland) Customer ID | `MRCL001` | confirmed |
| Woodland PO suffix | `DR3W` (PO = `M/DD/YY DR3W`) | confirmed |
| **OR (Eugene) Customer ID** | **NULL — pending Mary** (never invented) | unknown |
| **Eugene PO suffix** | **NULL — pending Mary** (likely DR3E/DR3O, not invented) | unknown |

A NULL renders as null in the export; `buildPoNumber` returns null (not a partial
`"7/31/26 "`) when the suffix is unknown. Confirmations are one-row edits.

### Residual concerns (honest — for Rick/Mary)

- **B7/B8 on the processing invoice.** The engine still composes B7 (collector
  incentives) + B8 (event misc) as ancillary processing lines; v2 surfaces them as
  GP `Misc`. §A.7's literal `amount = units × rate + trade_discount` is satisfied
  for a CLEAN Woodland processing invoice (no incentives/events → Misc $0, matching
  §4.2). **If Mary/Rick intend incentives + event-misc to be OFF the processing
  invoice entirely, that is a one-line change to stop composing B7/B8 — but it
  changes billed money and needs explicit sign-off. Not done unilaterally.**
- **PO / header date.** The PO number + Line-1 header use the invoice window-end
  (EOM, or the 15th mid-month). Confirm this matches the date Mary types into GP.
- **UNITSMO / Location cell.** The exact GP unit-of-measure code (`UNITSMO`) and
  the Line-1 "Location" cell semantics are modeled faithfully from §4.2 but should
  be confirmed against Mary's actual GP template before the adapter consumes v2.
- **`mrc_unit` rate source (ADR-0040 open).** Untouched here; unrelated to the
  single-line CA processing invoice, still open for the OR composition.

---

## Amendment (2026-07-21) — Rick/Mary/Kelsey rollup (rollup §5.1/§6/§9/§13/§14)

The real June-2026 invoice PDFs (§10) and Mary's answers (§8) LOCK the GP
presentation that the §4.2 amendment had modeled provisionally. This amendment
corrects the v2 export to the real PDFs and adds the combinations validator + the
commodity-breakdown attachment. **v1 stays frozen; every change here is v2-side or
new modules.**

### PO format templates WITH SPACES, kind-aware (§6/§9/§13)

The PR-#128 `DR3W` (no space) is corrected. PO format depends on invoice KIND:

| Kind | PO format |
|---|---|
| `ca_processing_mid_month`, `ca_processing_eom` | `M/DD/YY DR3 W` |
| `or_processing_eom` | `M/DD/YY DR3 OREGON` (spelled out, not DR3E/DR3O) |
| `ca_transportation_eom` | `M/DD/YY TRANS` |
| `or_transportation_eom` | `M/DD/YY TRANS OR` |
| `or_collection_site_count` | `M/YY OR COLLECTIONS` (no day — 2-digit year) |

New `buildPoNumberForKind` + `formatMYY` in `gp-identifiers.ts`; `buildGpContext`
gained an optional `kind` (threaded from `gp-config.ts`). Processing POs use the
confirmed per-site `po_site_suffix` (`DR3 W` / `DR3 OREGON`); TRANS / OR
COLLECTIONS suffixes are kind-fixed constants confirmed in §6. Seed corrected:
Woodland `DR3W`→`DR3 W`, Eugene null→`DR3 OREGON` + Customer ID `MRCL001` (§8 Q1).

### 7 LOCKED GP item codes (§9) — supersedes the empty-`item` assumption

Verbatim from the real PDFs (spaces significant): `LOCATION`, `UNITSMO`,
`REIMBO`, `EVENTO`, `MILES 0`, `FUEL`, `OREGON MATTRESS`. New
`src/lib/invoices/item-codes.ts` is the source of truth; v2 `gp.lines[].item`
now carries the real code (was `''` per the PR-#128 guess).

### v2 GP presentation corrected to the real invoice PDFs (§10)

- **Processing** now emits the §10 structure: `LOCATION` header + `UNITSMO`
  charge, then (when present) `LOCATION` spacer + `REIMBO` (B7 incentives) and
  `LOCATION` spacer + `EVENTO` (B8 event misc). **B7/B8 are FIRST-CLASS subtotal
  lines now**, not a summary `misc` bucket — that is how MRC's real invoice reads
  (§10 Woodland processing subtotal $286,829.35 includes the $15 REIMBO + $4,235.35
  EVENTO). This retires the prior "B7/B8 → GP Misc" residual concern in favor of
  the production-PDF structure. `misc_cents`/`freight_cents` are now always 0
  (their money lives in `gp.lines`); the reconciliation invariant
  (`gp.totals.total_cents === invoice.total_cents`) is unchanged and still guards.
- **Transportation** applies the **`MILES 0` aggregation** (freight + event
  transport + rental → one line) + `FUEL` (CA only). The three `B16.*` member
  leaves stay stored separately (provenance); the rollup is presentation-only.
- **Collections** emits one `OREGON MATTRESS` line per site (real count × $2.25).

All four June invoices reconcile in `export-v2-item-codes.test.ts` against the §10
numbers: Woodland processing $148,130.35, Woodland trans $72,480.51, Eugene trans
$13,800.00, Eugene collections $1,714.50.

### Invoice combinations validator (§6)

New `src/lib/invoices/combinations.ts` — `assertValidInvoiceCombination` REJECTS
(422, `InvoiceCombinationError`) the two structurally invalid combos:
1. **Eugene (OR) mid-month** — OR bills EOM only.
2. **Any mid-month invoice carrying a Trade discount** — the discount is the EOM
   subtraction of an already-billed mid-month; a mid-month can't carry one.
Wired into `service.generateInvoiceDraft` (after composition, before persist).

### `attachments[]` on EOM processing invoices ONLY (§5.1/§6)

New `src/lib/invoices/attachments.ts` — `invoiceAttachments(kind)` returns the
monthly commodity breakdown for `ca_processing_eom` / `or_processing_eom` and `[]`
for mid-month + every other kind. **Modeled as a COMPUTED descriptor, NOT a stored
column** (the `invoices` table has no attachments column and needs none — the
breakdown is fully derived from the window). Surfaced on `InvoiceExportV2.attachments`.

### Commodity-breakdown attachment renderer (§11) — landscape PDF

New `src/lib/commodity/` module:
- `breakdown.ts` — PURE model builder (`buildCommodityBreakdown`): per-transaction
  rows bucketed by commodity, per-block totals, facility header per block.
- `pdf.ts` — `renderCommodityBreakdownPdf`: multi-page **Letter LANDSCAPE** PDF
  via **pdf-lib** (deterministic, no headless Chromium → unit-testable, and no new
  internal print route / middleware allowlist). Rendering choice documented in-file.
- `fetch.ts` — reads `outbound_materials` + `unit_status_movements (to_status=landfilled)`
  for the invoice window and maps onto the pure model.

**Documented schema-reality divergences from §11's idealized 11-block taxonomy:**
1. The real `OutboundCommodity` enum is the **daily-log-9** (`metal`, not
   steel/xtraction_landfill/wte). The metal→**Steel / Xtraction Landfill / Covanta
   WTE** split is a vendor/destination split that is **OPEN pending Rick** (Covanta
   WTE %, Xtraction-Landfill classification — email 2026-07-20, §11/§17 soft
   blocker) and **Kelsey/Janette** (daily-log-9 → workbook-11 destination mapping).
   The renderer is **taxonomy-driven** (`BLOCK_TAXONOMY`) so that split lands as a
   data change, not a renderer rewrite. Recovery-% + recycled-lbs already render on
   the `metal`/`wood` blocks from ADR-0055's `recycling_percent_applied`/`recycled_lbs`.
2. `outbound_materials` has no `slip_number` (only `unit_status_movements` does), so
   §11's Landfill "Slip #" column renders from available fields (ticket/retrac).
3. The 11th block (Landfilled Units, whole-unit) reads `unit_status_movements`
   `landfilled_reason`; `water_logged` → "Wet" per §11.

### Deferred / integration wiring (for the integrator)

- The commodity-breakdown PDF is produced on demand by
  `buildInvoiceCommodityBreakdownPdf` (`commodity/fetch.ts`); a **download/delivery
  route** that serves it alongside the EOM invoice is NOT added here (would touch
  shared routing/middleware) — the renderer + descriptor are the buildable half.
- Pilot mode stays DEFAULT `pilot`; no live rate seeding, no mode flip (rollup DO-NOTs).
