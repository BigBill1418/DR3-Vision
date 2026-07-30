# Document ingestion — visible vs. absorbed audit

**Date:** 2026-07-30 (all times Pacific)
**Scope:** ADR-0067 shared-file document ingestion, `src/lib/doc-ingest/**` (21 files), the
`doc_sources` / `doc_source_versions` / `file_drops` chain, and every downstream consumer.
**Method:** code trace + read-only queries against the live production database on svdp-dev
(`docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision`), sampled **2026-07-30 00:24–00:35 PDT**.
**Claim labelling:** every factual claim carries `[M]` measured, `[D]` documented, or `[I]` inferred,
per ADR-0067 Amendment 6 §D. An unlabelled factual claim in this document is a defect.

---

## 1. Verdict

**The pipeline captures. It does not absorb.**

A document shared with `docs-dr3@svdp.us` is discovered, downloaded, hashed, archived to R2,
summarised into a shape projection, proposed a classification, and materialised as one
`file_drops` row with `status = 'received'`. That is where it stops. **No parsed value from any
ingested document reaches a queryable Vision table, a report, a dashboard tile, an email, or any
comparison against Vision's own numbers.** [M][D]

Three findings make this worse than the "archived but not extracted" state Bill suspected:

1. **The stored artefact could not answer an operational question even if a consumer existed.**
   `parse_summary` is a shape preview — sheet names, a header guess, row counts, per-column numeric
   sums, and a bounded text sample. For the three documents actually in the system it contains
   **zero usable numbers**: one has an empty `numericTotals` object, one has a single meaningless
   sum, one has 40 sheets of title strings. [M] (§4)

2. **The header guess is wrong on 3 of 3 live documents.** `parse.ts` takes the first non-empty row
   as the header row. All three real workbooks open with a merged title row, so the recorded
   "headers" are document titles, not column names. This silently disables the structure half of the
   classifier and empties the guardrail's aggregate check. [M][D] (§5)

3. **The confirm queue Bill is supposed to act on is not reachable by clicking.** The `/admin`
   dashboard advertises exactly one document-ingestion tile and it points at `/admin/doc-ingest/connect`,
   whose only outbound link is back to `/admin`. Nothing in the app links to `/admin/doc-ingest`
   (the sources + confirm queue), `/admin/doc-ingest/anomalies`, or `/admin/doc-ingest/health`. [M][D]
   Three documents have been waiting for confirmation since **2026-07-29 09:14 PDT**, and two
   anomalies are open, on pages reachable only by typing the URL. [M] (§7)

**Can Bill rely on this data as a reference point today? No.** He can rely on it as an _archive_: the
bytes are in R2, hashed, versioned, and downloadable. Nothing beyond that is load-bearing.

---

## 2. The consumer trace — who reads what

### 2.1 `doc_sources` / `doc_source_versions`

| Reader                       | File                                                                                                                                 | What it does with it                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| The pipeline itself          | `src/lib/doc-ingest/{ingest,sweep,discovery,classification,classifier,health,anomalies,subscriptions}.ts`                            | Ingest, classify, guardrail, anomaly bookkeeping                     |
| Sources list + confirm queue | `src/lib/doc-ingest/health.ts` → `listDocSources()` → `/api/admin/doc-ingest/sources` → `src/app/admin/doc-ingest/SourcesClient.tsx` | Renders **metadata only**                                            |
| Anomaly list                 | `health.ts` → `listAnomalies()` → `/admin/doc-ingest/anomalies`                                                                      | Renders a one-line `parse_summary` digest, **staged revisions only** |
| Register-share route         | `src/app/api/admin/doc-ingest/register/route.ts`                                                                                     | Creates sources from an operator-pasted URL                          |

[D] Verified by reading each file.

**`listDocSources()` does not select `parse_summary`.** [D] Its return shape ends at
`sizeBytes` / `versionCount` (`health.ts`). So the sources screen shows _that_ a document has N
versions, never _what is in them_.

**`parse_summary` reaches a screen through exactly one path** — `listAnomalies()`, which includes
`doc_source_version: { select: { …, parse_summary: true } }` and only computes a before/after for
rows where `version.staged` is true. [D] `AnomaliesClient.tsx` renders it through a `summarize()`
helper that emits `"${totalRows} rows total — sheet (n), …"`. [D]

**Live: `staged` count = 0.** [M] Therefore `parse_summary` is currently rendered on **zero screens**.

**Negative control for "nothing else reads `parse_summary`":**
`grep -rn "parse_summary\|parseSummary\|summaryFromJson" src` — unfiltered by extension, over all of
`src`, matched lines printed. Result: 9 files, **all** under `src/lib/doc-ingest/`. [M] The method is
capable of finding a reader: it found the four `health.ts` occurrences and the two `sweep.ts`
occurrences that are genuine readers. A consumer anywhere else in `src` would have appeared.

### 2.2 `file_drops` rows created by this pipeline

`applyVersion()` (`src/lib/doc-ingest/ingest.ts:300-382`) creates one `file_drops` row per applied
revision with `status: 'received'`, `ingest_source: 'shared_file'`, `detected_kind: source.doc_class`,
and a fixed note. It then stamps `doc_source_versions.file_drop_id`, bumps
`doc_sources.last_ingested_at`, and writes one `audit_log` row. **That is the entire body of the
function.** [D]

Everything that reads `file_drops`:

| Reader                 | File                                                                                              | Absorbs data?                             |
| ---------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Manual upload (POST)   | `src/app/api/admin/file-drops/route.ts`                                                           | no — writer                               |
| Inbox list             | `src/lib/file-drop/list.ts` → `/admin/file-drop`                                                  | no — filename, size, status, kind, source |
| Byte download          | `src/app/api/admin/file-drops/[id]/download/route.ts`                                             | no — streams R2 bytes to the browser      |
| Status/note edit       | `src/app/api/admin/file-drops/[id]/route.ts`                                                      | no — operator annotation                  |
| **AP baseline import** | `src/app/admin/ap/baselines/import/page.tsx` + `/api/admin/ap/baselines/import/{preview,confirm}` | **yes — the one real absorption path**    |

[D] Verified by `grep -rn "fileDrop\.\|prisma\.fileDrop" src` (tests excluded), then reading each hit.

**The one genuine absorption path, and why it does not currently apply.** The AP baseline importer
lets an admin pick a `file_drops` row, parse it with `parseBaselinePdf()`, review rows, and write
`ap_vendor_baselines`. [D] It is a real spreadsheet-to-table bridge. But its picker filters to
PDFs — `.filter((d) => /pdf/i.test(d.content_type) || /\.pdf$/i.test(d.original_filename))`
(`page.tsx`) [D] — and all four `shared_file` drops are
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` [M]. So no shared-file drop is
selectable there today. [I] — falsified if someone shares an AP-history PDF, which would then be
importable through this path; the inference is about the current inventory, not the mechanism.

### 2.3 Negative control on the absorption boundary

Does anything in `src/lib/doc-ingest/` reach a known extractor?

```
grep -rn "parseWorkbook|upsertDailyProduction|parseDailyRows|processed_units_daily|
          processedUnitsDaily|ingestWorkbook|parseBaselinePdf|apHistory|equipment|
          rate_table|rateTable" src/lib/doc-ingest/
```

Seven matched lines, **all** in `classifier.ts`: five are the literal kind strings
`'equipment_inventory'` / `'rate_table'`, two are prose inside the Claude prompt. [M] Zero calls,
zero imports. The method demonstrably finds string occurrences inside this directory — it found the
prompt text — so a call would have appeared.

**The only import of `doc-ingest` from anywhere else in `src`** is
`src/lib/ap/morning-digest.ts:69: import { docIngestReauthWarning } from '@/lib/doc-ingest/reauth'`
[M][D] — an auth-health warning line in the AP digest. Not data. Method:
`grep -rn "doc-ingest" src` minus the doc-ingest subtrees; it surfaced the nav/test/public-path
references too, so it was not filtering out the file class in question.

---

## 3. Live inventory — `[M]`, all sampled 2026-07-30 00:24–00:35 PDT

### Sources: 3

| Document                                  | Shared by              | Size      | Proposed              | Conf. | Confirmed | Site | Versions | First seen (PDT) |
| ----------------------------------------- | ---------------------- | --------- | --------------------- | ----- | --------- | ---- | -------- | ---------------- |
| `TEREX.xlsx`                              | janette.tomas@svdp.us  | 490,676 B | `equipment_inventory` | 0.41  | **no**    | NULL | 2        | 2026-07-29 09:14 |
| `Woodland Trailer list.xlsx`              | kelsey.ruhland@svdp.us | 61,118 B  | `equipment_inventory` | 0.82  | **no**    | NULL | 1        | 2026-07-29 13:17 |
| `Woodland Data Auditing Tracker (1).xlsx` | kelsey.ruhland@svdp.us | 23,024 B  | `unknown`             | 0.50  | **no**    | NULL | 1        | 2026-07-29 17:21 |

All three: `state = active`, `enabled = true`, `read_blocked_at` NULL, `ctag` present,
`doc_class`/`classified_at`/`period`/`site_id` all NULL, `proposed_source = 'claude'`,
`classification_error` empty, `shared_by_count = 1`, `depth = 0`, `kind = file`.

### Counts

| Metric                                                         | Value |
| -------------------------------------------------------------- | ----- |
| `doc_sources`                                                  | 3     |
| confirmed (`doc_class` non-null)                               | **0** |
| awaiting confirmation (`proposed_class` set, `doc_class` NULL) | **3** |
| `doc_source_versions`                                          | 4     |
| applied                                                        | 4     |
| staged                                                         | **0** |
| discarded                                                      | 0     |
| versions with `parse_summary`                                  | 4     |
| versions with `parse_error`                                    | 0     |
| `file_drops` with `ingest_source = 'shared_file'`              | 4     |
| `file_drops` total                                             | 9     |

### The four `shared_file` drops

All four: `status = 'received'`, `detected_kind = NULL`, `uploaded_by = 'system:doc-ingest'`,
note `"Ingested automatically from a shared document (ADR-0067)."`, real (non-placeholder) R2 key,
`doc_source_id` set. Created 2026-07-29 09:14, 13:02, 13:18 PDT and 2026-07-29 17:21 PDT.

`detected_kind` is NULL because `applyVersion` copies `source.doc_class`, which is NULL until Bill
confirms. [D] **`confirmClassification()` does not backfill `file_drops.detected_kind`** — its
transaction touches `doc_sources` and writes one audit row, nothing else (`classification.ts:194-252`)
[D]. So these four inbox rows will show a blank kind **permanently**, even after confirmation. [I] —
falsified by any code path that updates `file_drops.detected_kind` from a `doc_source`; the
`prisma.fileDrop` grep in §2.2 found no such writer.

### Open anomalies: 2 (of 6 rows; 4 resolved)

| Kind                        | Severity | Status   | Occ. | Subject                        | Substance                                                                                                                                                                |
| --------------------------- | -------- | -------- | ---- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unclassified`              | info     | **open** | 1    | Woodland Data Auditing Tracker | Claude: a "Commodity Audit (against Vendor Invoices)" workbook that "does not cleanly fit any of the defined categories… so 'unknown' is the most honest classification" |
| `subscription_renew_failed` | warning  | **open** | 10   | drive `b!bcdH…`                | `POST /subscriptions` denied — structural Graph limit, item-level shares have no legal subscription target                                                               |
| `subscription_renew_failed` | warning  | **open** | 6    | drive `b!4Czv…`                | same                                                                                                                                                                     |

Resolved: one `unclassified` on TEREX, closed **2026-07-29 10:25 PDT** with the note
_"FALSE ANOMALY. Raised from a null parse summary because classification ran before ingest
(ADR-0067 Amendment 4A). The document is not empty: 40 sheets, 2117 rows."_; and three
`sweep_failed` (one Graph abort at 10:01 PDT, two HTTP 503 on `sharedWithMe` at 11:28/11:43 PDT),
all auto-resolved by a subsequent successful sweep.

### Pipeline health

| Metric         | Value                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------- |
| Sweep runs     | 69 total — **66 `ok`, 3 `failed`** (all three failures on 2026-07-29 morning, all resolved) |
| Last sweep     | 2026-07-30 00:27 PDT, `ok`, 15-minute cadence                                               |
| Last 4 sweeps  | `sources_discovered 0`, `sources_updated 1`, `versions_created 0`                           |
| Connection     | `docs-dr3@svdp.us`, `state = connected`, refreshed 2026-07-29 23:12 PDT, no reauth latch    |
| Granted scopes | `Files.Read.All`, `Sites.Read.All`, `User.Read`, `email openid profile`                     |
| Drive delta    | **both** drives have a live `delta_link`, `delta_synced_at = 2026-07-30 00:27 PDT`          |

**Change detection is genuinely working** — worth stating because it is the one part of the
transitional promise that holds. Push subscriptions are permanently unavailable (item-level shares
have no subscribable target), but `/drives/{id}/root/delta` succeeds on both drives despite that, so
a colleague's edit is picked up within one 15-minute sweep. [M] `sources_updated = 1` reflects
`sharedWithMe` returning one root; the ingest loop reads all active sources from Postgres
(`sweep.ts:139-149`) [D], so all three are reconciled every run regardless.

---

## 4. What `parse_summary` actually contains

`ParseSummary` (`parse.ts:55-62`) is `{ format, sheets[], totalRows, textSample }`; each sheet is
`{ name, rowCount, headers[], populatedColumns[], numericTotals }`. `textSample` is capped at 8,000
chars, and for a workbook it is built from **sheet names and headers only** —
`textParts.push(\`[sheet: ${worksheet.name}] ${headers.filter(Boolean).join(' | ')}\`)`
(`parse.ts:266`) [D]. **No cell value from any row ever enters the stored summary as text.**

It is a shape preview, not an extraction. Here is the complete stored artefact for
`Woodland Trailer list.xlsx` — 339 bytes of JSON for a 61 KB, 118-row workbook: [M]

```json
{
  "format": "xlsx",
  "sheets": [
    {
      "name": "Trailer List Woodland 2025",
      "headers": ["Woodland Trailer List 2025"],
      "rowCount": 118,
      "numericTotals": { "Woodland Trailer List 2025": 23062327 },
      "populatedColumns": ["Woodland Trailer List 2025"]
    }
  ],
  "totalRows": 118,
  "textSample": "[sheet: Trailer List Woodland 2025] Woodland Trailer List 2025"
}
```

That single "aggregate" of 23,062,327 across 118 trailers is a sum of identifiers, not a quantity. [I]
— inferred from magnitude and from the column being the sheet's title rather than a data column;
falsified by opening the workbook and finding a real 23-million-unit column.

And the complete artefact for `Woodland Data Auditing Tracker (1).xlsx` — the document that
cross-references commodity data against vendor invoices, i.e. the highest reconciliation value of
the three: [M]

```json
{
  "format": "xlsx",
  "sheets": [
    {
      "name": "Commodity Audit 2026",
      "headers": ["2026", "Commodity Audit (against Vendor Invoices)  WOODLAND"],
      "rowCount": 57,
      "numericTotals": {},
      "populatedColumns": ["Commodity Audit (against Vendor Invoices)  WOODLAND"]
    },
    {
      "name": "Commodity Audit 2025",
      "headers": ["2025", "Commodity Audit (against Vendor Invoices)  WOODLAND"],
      "rowCount": 43,
      "numericTotals": {},
      "populatedColumns": ["Commodity Audit (against Vendor Invoices)  WOODLAND"]
    }
  ],
  "totalRows": 100,
  "textSample": "[sheet: Commodity Audit 2026] 2026 | Commodity Audit (against Vendor Invoices)  WOODLAND\n[sheet: Commodity Audit 2025] 2025 | Commodity Audit (against Vendor Invoices)  WOODLAND"
}
```

**`numericTotals` is `{}` — empty. Not one number from a commodity-audit workbook was retained.** [M]

`TEREX.xlsx`: 40 sheets, 2,117 rows, 12,954 bytes of summary JSON, 2,609-char `textSample`. First
sheet: `"Maintenance Log 2025"`, `rowCount 91`, `headers: ["TEREX MACHINE MAINTENANCE LOG"]`. [M]

**Answer to the central question:** even the stored artefact cannot answer an operational question.
Nothing could absorb it as-is. Any real absorption must re-read the R2 bytes; the summary is a
guardrail input, not a data layer. [I] — falsified only by a use case satisfiable from row counts
and column sums alone.

---

## 5. The header-row defect, and the two mechanisms it silently disables

`parse.ts:237-245` takes the first non-empty row as the header row, with this justification: [D]

> First non-empty row is the header. Fragile in theory; **correct for every workbook this pipeline
> has seen**, and a wrong guess degrades to "the guardrail compares odd-looking column names
> consistently" rather than to a wrong number.

**That claim is falsified by the live data, 3 of 3.** [M] Every real workbook opens with a merged
title row, so `headers[]` holds `["Woodland Trailer List 2025"]`,
`["TEREX MACHINE MAINTENANCE LOG"]`, `["2026", "Commodity Audit (against Vendor Invoices)  WOODLAND"]`.
Real column names are on row 2+ and are never recorded.

The stated degradation is also understated. Two mechanisms are disabled, not merely made "odd-looking":

**(a) The structure half of the classifier is dead.** `classifier.ts` rules match on sheet names and
column headers — `equipment_inventory` looks for `/\bserial\b/`, `/\bmake\b/`, `/\bmodel\b/`,
`/\basset[\s_]*(id|tag)\b/`; `daily_log_workbook` looks for `/\binbound\b/`, `/\boutbound\b/`,
`/\bunits\b/`, `/\beod\b/` [D]. None of those can ever match, because real headers never reach
`headers[]` and `textSample` is built from `headers[]`. Classification is therefore **filename-only**
in practice. [I] — falsified by any live source whose `headers[]` contains a genuine column name;
none of the three does. This is consistent with the observed confidences: 0.41 and 0.50, and the
0.82 on the trailer list is carried by the filename.

**(b) The D7 aggregate-variance guardrail has zero monitored columns.**
`guardrail.ts:63` gates condition 1 on
`/(amount|total|cost|price|charge|rate|fee|revenue|paid|due|balance|units?|count|qty|quantity|weight|lbs?|pounds|tons?)/i`
[D]. None of the three recorded header strings matches. [I] So of the guardrail's four conditions,
only `row_count_drop` (default threshold 0.1, `pipeline-config.ts:61`) [D] has real signal today;
`aggregate_variance` and `column_nulled` are operating on title strings.

**Consequence for trust.** All four versions were auto-applied with a clean guardrail verdict [M].
That verdict is not evidence the changes were safe — it is evidence there was nothing to compare.
`evaluateGuardrail` auto-applies when there is no prior applied summary, by design
(`guardrail.ts` docstring) [D], and the one revision that _did_ have a baseline (TEREX v2 vs v1)
was compared on non-aggregate columns.

---

## 6. Per-kind: what Vision does with a confirmed document today

`DOC_KINDS` = `daily_log_workbook`, `ap_history_report`, `equipment_inventory`, `rate_table`,
`mrc_invoice`, `vendor_invoice`, `unknown` (`classifier.ts:43-51`) [D]. `vendor_invoice` and
`unknown` are excluded from `CONFIRMABLE_KINDS` (`sources/route.ts`) [D].

| Kind                  | What confirmation does                                                                                                      | What Vision does with the data                                                                                                                        | Target table that exists but is not fed                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `daily_log_workbook`  | sets `doc_class`/`site_id`/`period`, resolves the `unclassified` anomaly, arms guardrail condition 4                        | **Nothing.** One `file_drops` row per revision.                                                                                                       | `processed_units_daily` — 976 rows [M], fed by ADR-0039 workbook import and MyMRC bridges, **not** by doc-ingest                  |
| `ap_history_report`   | same                                                                                                                        | **Nothing automatic.** An admin _could_ import it via `/admin/ap/baselines/import` — but the picker is PDF-only and every shared-file drop is `.xlsx` | `ap_vendor_baselines` — 9 rows [M]                                                                                                |
| `equipment_inventory` | same                                                                                                                        | **Nothing.** Both TEREX and the trailer list land here.                                                                                               | `equipment` (554 rows), `equipment_events` (68), `yard_trailers` (**0 rows**) [M]                                                 |
| `rate_table`          | same                                                                                                                        | **Nothing.**                                                                                                                                          | `recycling_rates` (**0**), `site_billing_rates` (**0**), `account_haul_rates`, `source_service_rates`, `transport_rate_tiers` [M] |
| `mrc_invoice`         | same                                                                                                                        | **Nothing.** MyMRC has its own scraper/mirror path.                                                                                                   | MyMRC mirror tables                                                                                                               |
| `vendor_invoice`      | not confirmable — recognised so it can be **refused** and redirected to `ap@svdp.us` (`VENDOR_INVOICE_CORRECT_ADDRESS`) [D] | correctly nothing — this is the designed behaviour                                                                                                    | —                                                                                                                                 |
| `unknown`             | not confirmable — leaves the `unclassified` anomaly open                                                                    | **Nothing.** Currently the state of the commodity-audit tracker.                                                                                      | —                                                                                                                                 |

**For five of seven kinds the honest answer is: it is filed and never read again.** [M][D]
`yard_trailers`, `recycling_rates`, and `site_billing_rates` are empty tables whose exact subject
matter is sitting in R2 as an archived spreadsheet. [M]

---

## 7. Visibility — what Bill can actually see

What holds:

- **The bytes.** All four drops have real R2 keys; `/api/admin/file-drops/[id]/download` streams
  them; `listFileDrops()` marks them `downloadable`. [M][D]
- **The source list.** `/admin/doc-ingest` shows name, owner, size, state, version count, proposed
  class + confidence + Claude's reasoning, and a confirm control. [D]
- **The anomalies and health pages** exist and are populated. [M][D]

What does not:

- **`parse_summary` is on zero screens right now.** Only `listAnomalies()` exposes it, only for
  `staged` versions, and `staged = 0`. [M][D]
- **`file_drops.detected_kind` is NULL on all four rows and will stay NULL.** The `/admin/file-drop`
  inbox therefore shows four unlabelled spreadsheets. [M][D] (§3)
- **The confirm queue is not reachable by clicking.** `src/app/admin/page.tsx:91` is the only
  doc-ingest tile and targets `/admin/doc-ingest/connect`; that page's only `href` is `/admin`
  (`connect/page.tsx:63`). [M][D]
  _Negative control:_ `grep -rn 'href="/admin/doc-ingest"' src --include=*.tsx` → 2 hits, both inside
  the doc-ingest subtree (`anomalies/page.tsx:28`, `health/page.tsx:52`). The method finds
  intra-subtree links, so an inbound link from `/admin` or a dashboard tile would have appeared. [M]
- **No dashboard tile, no digest line, no email** carries a "documents awaiting confirmation" count.
  The only cross-surface signal from doc-ingest is `docIngestReauthWarning` in the AP morning digest,
  which fires on broken auth — not on a full queue. [M][D]

Net effect: three documents have been sitting unconfirmed for **~15 hours** [M], and because
confirmation is the gate on `doc_class`, the guardrail's condition 4 and every future routing
decision are gated behind a page nobody is led to.

---

## 8. The bridge — is there a migration path?

### 8.1 The "document elimination backlog" does not exist in the ADR

Bill's framing cites ADR-0067 §3.6 as mentioning a document elimination backlog.

**It is not there.** `grep -rniE "elimination|eliminate the (document|spreadsheet)|retire the
(workbook|spreadsheet)|system of record|takes? (this )?over"` over
`docs/adr/0067-shared-file-document-ingestion.md` → **zero matches**. `grep -rniE "document
elimination|spreadsheet elimination" docs/` → **zero matches anywhere in `docs/`**. [M] The ADR's
`§3.x` references point at a Phase 3 directive that is not in this repo (`§3.5` is cited as
superseded, `§3.3` as the four-table schema) [D], so §3.6 plausibly lives in that external
directive. [I] — falsified by producing the directive text.

**Assessment: aspiration, not plan.** There is no phased backlog, no per-document retirement
criterion, and no acceptance test for "Vision has taken this over" anywhere in the repo. [M]

### 8.2 There is already a working absorption pipeline for the highest-value kind — and it has never run

`src/lib/workbook-sync/` (ADR-0049) is exactly the bridge Bill is describing, already built: [D]

> discover the current month's file (D5 rollover) → delta-detect by cTag (D2) → download → parse via
> the SHARED ADR-0048/0039 `parseWorkbook` + the daily adapter → upsert into `processed_units_daily`
> under the workbook-wins rule with an audit row per Vision-overwrite (D3) → … → a
> `workbook_sync_runs` ledger row ALWAYS. Post-cutover (surface flipped `live`, D7) the sync is a NO-OP.
> — `engine.ts:1-11`

It reads a real workbook, extracts real rows, and writes a queryable Vision table. It even has the
cutover concept — the workbook feeds Vision until Vision becomes the source of record, then the sync
turns itself off. That is "absorbed as a reference point until Vision takes over," implemented.

Live state: [M]

| Fact                    | Value                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `workbook_sources` rows | **1** — site Woodland, drive `kelsey_ruhland@svdp.us`, pattern `{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm` |
| `is_syncing`            | **false**                                                                                               |
| `last_polled_at`        | **NULL**                                                                                                |
| `workbook_sync_runs`    | **0**                                                                                                   |

**It has never executed once.** It is configured and dormant.

Two pipelines now watch Microsoft files with no connection between them: [I]

- `workbook-sync` — narrow, absorbs into `processed_units_daily`, app-only `Files.Read.All` via
  `msgraph-files`, keyed on a filename pattern, **off**.
- `doc-ingest` — broad discovery, delegated auth as `docs-dr3@svdp.us`, archives + classifies +
  guards, **running every 15 minutes**, terminates at `file_drops`.

Falsified by any import edge between them; §2.3's negative control found none.

**And no daily log workbook has been shared with `docs-dr3@svdp.us` at all.** The pattern
`{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm` matches none of TEREX / trailer list / auditing tracker. [M]
So the highest-value kind is not merely unabsorbed — it is not yet in the pipeline's field of view.

### 8.3 What "absorbed as a reference point" should concretely mean

For `daily_log_workbook`, the shape Bill is describing already has a precedent in this repo — ADR-0032
reporting-only adjustments and the three-way audit (ADR-0039). Concretely:

1. **Extract, don't summarise.** On apply, dispatch by confirmed `doc_class` to a real extractor:
   `daily_log_workbook` → `parseWorkbook` + `parseDailyRows` + `upsertDailyProduction`
   (all three already exist and are already tested) [D].
2. **Land it in a shadow table, not the operational one.** `doc_reference_rows` keyed by
   `(doc_source_version_id, site_id, period, metric, value)`. Reference data must never silently
   overwrite Vision's own numbers — the ADR-0032 lesson.
3. **Build the reconciliation view.** Per site, per day: spreadsheet value vs. Vision value vs. delta,
   with a variance flag. That view _is_ the migration instrument: when the delta column is
   persistently zero for a site, that site's spreadsheet is retirable. When it is not, the
   discrepancy is the operational finding — which is what the colleagues' workbooks are actually for.
4. **Make the queue visible.** A dashboard tile carrying pending-confirmation count + open-anomaly
   count + last-sweep age.

**Nothing resembling step 3 exists.** Negative control: `grep -rn "reconcil" src --include=*.ts
--include=*.tsx` finds MyMRC reconciliation (`src/lib/mymrc/reconcile-detect.ts`), ADR-0033
payroll/payout guards, and ADR-0052 commodity-payment reconciliation — none of which reads
`doc_sources`, `doc_source_versions`, or a `shared_file` `file_drops` row (per §2.1/§2.2). [M]

**Effort estimate for the daily-log path** [I] — the extractor, the adapter, the upsert, and the
guardrail all exist, so the new code is a dispatch table keyed on `doc_class`, one shadow table + its
migration, and one comparison view. The genuinely unsolved part is not code: it is the header-row
defect in §5, because a reference row extracted from a mis-headered sheet is worse than no reference
row at all.

---

## 9. Gaps ranked by operational value

### Blocking — "Bill cannot rely on this yet"

**G1. No extraction step exists.** No parsed value reaches any queryable table. The pipeline's
terminal write is a `file_drops` inbox row. **This is the whole of Bill's question and the answer is
no.** Fix: a `doc_class` → extractor dispatch at apply time, landing in a reference table separate
from operational tables.

**G2. The header row is mis-detected on 3 of 3 live workbooks.** Everything downstream inherits it:
the classifier's structure rules cannot match, the aggregate guardrail has no columns, and
`numericTotals` is either garbage or empty. **Fix this before G1** — extraction built on top of it
would produce confidently wrong reference numbers. Fix: score candidate rows for header-likeness
(distinct non-empty short strings, low numeric fraction, followed by rows that type-agree) rather
than taking row 1; and record which row was chosen so the choice is auditable.

**G3. `parse_summary` reaches no screen in the normal (unstaged) case.** The one artefact that does
exist is invisible unless a guardrail trips. Fix: add sheets/rows/columns to `listDocSources()` and
render a per-version panel.

**G4. The confirm queue is unreachable by clicking, and nothing counts down.** Three documents
waiting ~15 h, two anomalies open, zero notifications. Fix: point the admin tile at
`/admin/doc-ingest`, add the three sub-nav links to the connect page, and add pending-confirmation +
open-anomaly counts to a dashboard tile. Under ADR-0037 this is a **tile, not a page** — it fails the
5-minute-actionability gate as a notification but is exactly what a dashboard is for.

### High — the bridge is not being built

**G5. `workbook-sync` (ADR-0049) has never run.** The one true absorption pipeline is configured
(1 `workbook_sources` row, Woodland) with `is_syncing = false` and 0 runs. Decide explicitly:
turn it on, or fold its extractor into doc-ingest and retire the second pipeline. Two dormant
Microsoft-file pipelines with no shared code path is how the fleet's silent-staleness class is born.

**G6. No reconciliation view.** Without spreadsheet-vs-Vision-per-period, there is no instrument that
can ever say "Vision has taken this over." The migration Bill is describing has no measuring device.

**G7. No daily log workbook has been shared with `docs-dr3@svdp.us`.** The highest-value kind is not
in the pipeline's field of view. Operator action, not code: ask Kelsey to share
`{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm`.

### Medium — correctness and hygiene

**G8. The taxonomy is already too narrow.** Live proof: the Woodland Data Auditing Tracker is a
commodity-audit-against-vendor-invoices workbook, Claude correctly declined to force-fit it, and
`unknown` is not confirmable — so it is permanently stuck with an open anomaly and no path forward.
A `commodity_audit` kind is warranted, and more generally `unknown` needs a confirmable
"acknowledged, archive-only" terminal state so a document can be triaged rather than left ringing.

**G9. `file_drops.detected_kind` is never backfilled on confirmation.** The four inbox rows show a
blank kind forever. One-line fix inside `confirmClassification`'s transaction.

**G10. The guardrail's clean verdicts are not evidence.** All four auto-applies passed with 0–1
monitored columns. Until G2 lands, a clean verdict should be recorded as "not assessed", not "clean".

### Low — accepted or already correct

**G11.** Push subscriptions are permanently unavailable (structural Graph limit on item-level shares).
Two `subscription_renew_failed` anomalies, 16 combined occurrences, will never clear. Correctness is
unaffected — delta on both drives is live and synced 2026-07-30 00:27 PDT. Consider a terminal
`structurally_unavailable` state so these stop accruing occurrences forever.

**G12.** `sharedWithMe` returned HTTP 503 twice and aborted once on 2026-07-29 morning; all three
self-resolved. Amendment 3 already flags the capability as being removed; the operator `/shares`
registration route is the mitigation and is working — two of three sources came in that way.

---

## 10. One-line summary for the record

Document ingestion is a **working, well-instrumented archive** with a **broken header parser**, a
**preview-only stored artefact**, **no extraction step**, **no reconciliation view**, a **dormant
sibling pipeline that already does the absorption**, and a **confirm queue nobody is led to**.
The bytes are safe. The data is not yet a reference point.
