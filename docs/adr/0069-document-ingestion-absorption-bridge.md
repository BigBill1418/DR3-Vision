# ADR-0069 — The document-ingestion absorption bridge

**Status:** Accepted
**Date:** 2026-07-30 (all times Pacific)
**Supersedes:** nothing. **Amends:** ADR-0067 (shared-file document ingestion).
**Depends on:** ADR-0049 (workbook-sync bridge), ADR-0039/0048 (workbook parser).
**Driven by:** `docs/2026-07-30-document-ingestion-absorption-audit.md`.

---

## 1. Context

The 2026-07-30 audit measured what ADR-0067's pipeline actually does with a shared
document. Verdict: **it captures, it does not absorb.** A document is discovered,
downloaded, hashed, archived to R2, summarised into a shape projection, proposed a
classification, and materialised as one `file_drops` row with `status = 'received'`.
That is where it stops. No parsed value reaches a queryable table, a report, or any
comparison against Vision's own numbers.

Bill's framing for the feature: _"make sure all of that data is not only visible but
being absorbed into the system as a reference point until vision is able to take this
over completely."_ And the architectural constraint, verbatim: _"build the absorption
bridge — workbook-sync owns `processed_units_daily`."_

Three audit findings shape the design:

1. **`parse_summary` holds shape, not data.** Sheet names, a header guess, row
   counts, per-header sums, and a text sample built from headers only. Measured on
   all three live documents: one has an empty `numericTotals`, one a single sum of
   identifiers, one 40 sheets of title strings. It is a change-detection artefact and
   extending it to carry data would break the one job it does well.
2. **`parse.ts` mis-detects the header row on 3 of 3 live workbooks** — it takes the
   first non-empty row, and every real workbook opens with a merged title row. Any
   extraction built on its `headers[]` would be built on sand.
3. **There is no reconciliation view anywhere in the repo.** Without one, "has Vision
   taken this over yet?" has no answer that is not a guess. The migration had no
   measuring device.

## 2. Decision

### D1 — One writer, enforced structurally

`src/lib/workbook-sync/` (ADR-0049) is the system of record for
`processed_units_daily`. Doc-ingest **never** writes that table.

Rejected, explicitly:

- _Doc-ingest upserts when workbook-sync has not._ A conditional second writer is a
  second writer. The condition would be evaluated at a moment, and the two pipelines
  would disagree at every other moment.
- _A `source` discriminator so both may write._ This makes the collision
  representable rather than impossible, and the collision would be discovered in
  payroll.

Instead doc-ingest writes `doc_reference_rows`: a different table with a different
meaning. Nothing computes payroll, billing, bonus, or inventory from it.

### D2 — Extract from the archived bytes, with the layout-aware parser

On an applied revision of a **confirmed** absorbable document, re-read the R2 object
and run `parseWorkbook` (`@/lib/audit/workbook/parser`, real layout resolver spanning
three-plus template generations) for provenance plus `parseDailyRows`
(`@/lib/workbook-sync/daily-adapter`) for the per-day rows. Never `parse_summary`,
and never `parse.ts`'s header guess — see Context 1 and 2.

`ABSORBABLE_KINDS` is a one-entry set (`daily_log_workbook`). A kind becomes
absorbable when a real, tested extractor exists for it, not when a condition is
loosened.

### D3 — Reference metrics are a closed vocabulary

`DocReferenceMetric` = `stripped_program | stripped_non_program | saved_units`.
Invariant: **every metric names a real `processed_units_daily` column.** A metric
with no counterpart column could be extracted but never compared — reference data
unable to answer the only question the table exists to answer.

`saved_units` is omitted when the workbook states none. An absent figure is not a
zero, and recording it as zero manufactures a disagreement with a Vision row that is
also absent.

### D4 — Failure is loud, in both directions

- **Zero usable rows raises `absorption_empty`.** It is never recorded as a
  successful absorption of nothing. The detail line names the template generation and
  the sheets the parser actually saw, and points at the row adapter as the likely
  cause. The entire defect history of this module is a zero or a null read as good
  news (a null ctag as "unchanged", a missing baseline as "no variance", a failed
  archive as "applied"); this is the line that refuses to add one.
- **A NULL `site_id` raises `absorption_refused` and writes nothing.** A NULL site is
  UNCLASSIFIED, never "both" and never a guess (hard rule #2). The refusal runs
  _before_ the download, so an unconfirmed document costs one row read per sweep, not
  an R2 GET and a parse.
- **A refusal deliberately does NOT latch `absorbed_at`.** Refusing is only correct if
  the operator action actually fixes it: confirming the site makes the next sweep
  absorb, with no re-trigger. Terminal outcomes (absorbed / empty / unreadable /
  not_absorbable) do latch, so a 60 KB workbook is not re-downloaded every 15 minutes
  forever. A new `ctag` cuts a new revision and earns a fresh attempt.

### D5 — Reconciliation is computed at read time, not stored

`reconcileReference()` reads both sides live. A persisted reconciliation would be a
third thing to keep in sync and would go stale the moment `processed_units_daily`
changed underneath it — which it does, from the MyMRC bridges and operator entry. A
stale agreement is worse than none: it is a green light with nothing behind it.

Two refinements that are load-bearing:

- **One voice per document.** Only the latest applied, absorbed revision contributes.
  Superseded revisions keep their rows as history; counting them would double a day.
- **Coverage is tracked per (site, METRIC), not per site.** `stripped_non_program`
  carries `@default(0)`, so a Vision row has a zero there whether anyone entered one
  or not. If a workbook states program units but never non-program units, a
  site-level window reports every covered day as "missing a non-program figure" —
  reintroducing, one level down, exactly the noise the window exists to remove. This
  was found by a test, not by review.

Comparison is **exact** at two decimal places. There is no tolerance band: a half
unit between the paper record and Vision is a real difference, and a tolerance is a
threshold nobody chose that quietly reclassifies findings as agreement.

### D6 — The absorption pass runs inside the existing sweep

No new cron container. The work is event-shaped — a revision just applied — and the
15-minute doc-ingest sweep already knows one did. A second cron is a second thing
that can silently stop. It runs after the ingest loop and is non-fatal: absorption
writes only reference data, so failing it must never mark a sweep that correctly
captured every document as failed.

Because the sweep catches absorption errors, `runAbsorptionPass` uses two flat
indexed reads rather than a relation-filtered join — a query this pass could not
actually run would otherwise be swallowed as a warning and look like "nothing to
absorb". It is tested directly, where nothing catches anything.

### D7 — The reconciliation screen is manager-reachable

`/admin/doc-ingest/reconciliation` is the one page in the doc-ingest subtree a site
manager can open. The rest are admin-only because they list sources with a NULL
`site_id`; that reason does not apply here, since every row comes from
`doc_reference_rows` whose `site_id` is NOT NULL by schema constraint. And the person
who can say whether the workbook or Vision is right for a given day is the manager who
was there, not Bill.

Site reach applies in full: admin and `all_sites` managers see both sites, a plain
manager sees their own, and a manager with no primary site sees **nothing** rather
than everything. The client sends a period, never a site id.

---

## 3. Schema

```
doc_reference_rows
  id                    TEXT PK
  doc_source_id         TEXT NOT NULL → doc_sources(id)         ON DELETE CASCADE
  doc_source_version_id TEXT NOT NULL → doc_source_versions(id) ON DELETE CASCADE
  site_id               TEXT NOT NULL → sites(id)               ON DELETE RESTRICT
  production_date       DATE NOT NULL
  metric                DocReferenceMetric NOT NULL
  value                 DECIMAL(12,2) NOT NULL
  source_sheet          TEXT
  source_row            INTEGER
  extracted_at          TIMESTAMP(3) NOT NULL DEFAULT now()
  created_at            TIMESTAMP(3) NOT NULL DEFAULT now()
  UNIQUE (doc_source_version_id, production_date, metric)
  INDEX  (site_id, production_date)
  INDEX  (doc_source_id)
```

`site_id` is NOT NULL, and that is hard rule #2 enforced at the storage layer rather
than in application code: a later code path cannot quietly change its mind and write
a guessed site. `value` is deliberately **wider** than the operational column's
`Decimal(7,1)` — reference data records what the spreadsheet said, including a figure
Vision would reject, which is exactly the discrepancy worth surfacing.

The absorption ledger on `doc_source_versions` (`absorbed_at`, `absorption_status`,
`absorption_rows`, `absorption_error`) makes "produced nothing" a number and a reason
on a screen rather than an absence nobody notices.

Migration `20260818_adr0069_doc_ingest_absorption_bridge` is purely additive and
replays clean on an empty PG16 (ADR-0035 invariant) — verified by replaying all 74
migrations in order into a scratch database on svdp-dev. All id/FK columns are `TEXT`,
never `uuid`.

---

## 4. Workbook-sync: assessed for enablement, and NOT enabled

The audit's G5 asked for an explicit decision on turning ADR-0049's sync on. It was
assessed and **deliberately left off.** It is not a wiring gap — the compose service,
the thin cron daemon, the loopback-guarded internal route, the business-hours gate and
the admin control all exist and are correct. The gates that remain are deliberate, and
three independent blockers make enabling it unsafe today.

**B1 — The daily-row adapter is still the fixture's, by its own declaration.**
`daily-adapter.ts` is ADR-0049's D12 seam and says so in a boxed note: it reads the
Addendum-B fixture `Daily` sheet, and the real
`{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm` layout is finalised only once Kelsey's file
is in hand. It matches a sheet named exactly `daily` and fixed columns A–G. Against a
real workbook there are two outcomes, and both are bad in the operational table: no
matching sheet yields zero rows and a green `ok` run, or a differently-shaped sheet
yields wrong numbers that overwrite production. Note that the engine already calls the
layout-aware `parseWorkbook` and **discards** everything but `templateGeneration`,
using the fixture reader for the rows it actually writes.

**B2 — The mock transport is the default and the engine does not gate on it.**
`selectFilesTransport()` returns a fixture-seeded `mockFilesTransport` whenever
`MSGRAPH_FILES_*` / `MSGRAPH_MAIL_*` are absent, serving synthetic bytes under the
name `JUNE 2026 DAILY LOG WOODLAND.xlsm`. `syncOneSource` never inspects
`transport.mode` before upserting; it only stamps it into the ledger. So an env
regression in the `app` service is sufficient to write **fixture data into
`processed_units_daily`**. Measured: `MSGRAPH_MAIL_*` are currently present in
`dr3-vision-app`, so the path is not armed right now — but it is unguarded, and
"currently configured correctly" is not a control.

**B3 — Every existing row would be classified a Vision-overwrite.** Measured on prod:
`processed_units_daily` holds 976 rows, **all** with `source = 'mymrc'` and
`closed_at` NULL. `upsert.ts` computes `wasVisionCaptured = existing.source !== 'import'`,
so every disagreement would take the workbook-wins update path. There _is_ an audit
row per overwrite — so the ADR-0049 audit-trail requirement is genuinely met, and
that is not the objection. The objection is B1 + B2: workbook-wins is only safe when
the workbook side is right, and today it is a fixture reader that has never been run
against a real file.

**Conditions for enabling**, in order:

1. A real daily-log workbook is shared and the column mapping in
   `daily-adapter.ts` is finalised against it (closes D12 and B1).
2. `syncOneSource` refuses to upsert when `transport.mode === 'mock'` — a mock run
   should be a ledger row and a warning, never a write (closes B2).
3. The ADR-0069 reconciliation shows the extracted figures matching the paper record
   for a full period. **This is the point of the bridge:** it lets the extractor be
   validated against production at zero operational cost, because reference rows
   cannot overwrite anything.
4. Then flip `is_syncing` and start the `workbook-sync` compose profile.

Absorption deliberately exercises the same unfinalised `parseDailyRows`. That is safe
here precisely because it is not safe there: the blast radius is a reference row and a
loud anomaly, and the reconciliation screen is how a wrong mapping gets **discovered**
before the operational writer is ever switched on.

---

## 5. Consequences

**Good.** Extracted figures are queryable, attributable to a document, a revision, a
sheet and a site. "Has Vision taken this over?" has an answer per site and period. The
row adapter can be validated against real files with no operational risk. The confirm
queue and every doc-ingest sub-page are reachable by clicking for the first time
(audit G4).

**Accepted costs.** Reference rows duplicate figures that also exist in
`processed_units_daily` — deliberately, since the comparison is the product. The
reconciliation costs two indexed reads per view. Absorption re-downloads an archived
object once per revision.

**Not done, deliberately.**

- `processed_units_daily` is not written, and no path was added that could.
- `parse_summary` was not extended to carry data (Context 1).
- The `parse.ts` header-row defect (audit G2) is **not** fixed here. It is real and
  still open, but this bridge routes around it entirely by using the layout-aware
  parser, so fixing it is now a classifier/guardrail concern rather than a blocker on
  absorption. It should not be bundled into this change.
- No new document kinds (`commodity_audit`, audit G8), no `unknown` terminal state,
  no `file_drops.detected_kind` backfill (G9). Separate concerns.
- No notification. Both new anomaly kinds fail ADR-0037's 5-minute-actionability
  gate: the fix for a refusal is "finish confirming in the queue", and the fix for an
  empty extraction is a code change to the row adapter. Both are dashboard cases.
  `absorption_empty` is graded `critical`/`default` — visible same-day, never silent,
  never a page.

---

## 6. Verification

- `npx tsc --noEmit` — 0 errors, whole repo.
- `npx eslint` on all changed files — clean.
- `npx vitest run` — full suite green; 21 new tests (13 absorption, 8 reconciliation).
- Migration replayed from empty on PG16.13 (svdp-dev scratch database), all 74
  migrations in order, exit 0; new table, enum, enum values, columns and partial index
  verified present.
- Every new guard was proven able to fail: the one-writer assertion, the loud-zero
  anomaly, the NULL-site refusal and its non-latching recovery, the per-metric
  coverage window, and one-voice-per-document were each broken deliberately,
  confirmed red, and restored.
