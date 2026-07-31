# 2026-07-30 — Document ingestion: make it absorb, not just capture (ADR-0067 → true absorption)

**Session context (Bill × Claude, 2026-07-30):**

Bill asked to confirm document ingestion is live. It is **not** — the `2026-07-30-document-ingestion-absorption-audit.md` (run read-only against the live prod DB this morning) is unambiguous: **"The pipeline captures. It does not absorb."** A shared file is discovered, downloaded, hashed, archived to R2, and parked as one `file_drops` row with `status='received'` — then stops. No parsed value reaches any queryable table, report, dashboard, email, or comparison against Vision's numbers.

Bill's directive: **all three fixes — make it genuinely live tonight, absorb not just capture.**

**This handoff is grounded entirely in the audit's measured findings — not memory.** Every defect below carries the audit's evidence. Claude Code should re-read `docs/2026-07-30-document-ingestion-absorption-audit.md` in full before starting; it is the specification.

**Three live documents are sitting in the system right now**, shared since 2026-07-29 09:14 PDT, waiting on a confirm queue Bill cannot reach by clicking:

- `Woodland Trailer list.xlsx` (118 rows)
- `TEREX.xlsx` / TEREX maintenance log (40 sheets, 2,117 rows)
- `Woodland Data Auditing Tracker (1).xlsx` — commodity data cross-referenced against vendor invoices; **the highest reconciliation value of the three**

## §1 — Fix 1: the confirm queue must be reachable by clicking

**Audit §7 [M][D]:** the `/admin` dashboard has exactly one doc-ingest tile and it points at `/admin/doc-ingest/connect`, whose only outbound link is back to `/admin`. Nothing links to `/admin/doc-ingest` (sources + confirm queue), `/admin/doc-ingest/anomalies`, or `/admin/doc-ingest/health`. Three documents have waited for confirmation since 2026-07-29 09:14 PDT and two anomalies are open, on pages reachable only by typing the URL.

**Fix:**

- The `/admin` doc-ingest tile routes to `/admin/doc-ingest` (the sources + confirm queue), not `/admin/doc-ingest/connect`. Connection status belongs _inside_ that surface, not as the only destination.
- `/admin/doc-ingest` links onward to `/anomalies` and `/health`.
- The tile carries a **count badge** of sources awaiting confirmation — the number that tells Bill there's something to act on. Following the reimbursement-tile lesson (a tile only on a page Bill never lands on is invisible), verify this is reachable from where Bill actually lands (he is admin, `primary_site_id = NULL`, lands on the picker).
- Once reachable, the three waiting documents must be confirmable end to end.

## §2 — Fix 2: the header-row guess is wrong on 3 of 3 live documents

**Audit §5 [M]:** `parse.ts:237-245` takes the first non-empty row as the header. All three real workbooks open with a **merged title row**, so `headers[]` holds document titles — `["Woodland Trailer List 2025"]`, `["TEREX MACHINE MAINTENANCE LOG"]`, `["2026", "Commodity Audit (against Vendor Invoices)  WOODLAND"]` — not column names. Real columns are on row 2+ and are never recorded. This silently disables the structure half of the classifier and empties the guardrail's aggregate check.

**Fix — detect the real header row rather than assuming row 1:**

- A merged/title row is characteristically: a single populated cell (or a cell spanning columns), often with many empty cells beside it, followed by a row with multiple distinct populated cells that look like column names.
- Heuristic: scan the first N rows (say 10); the header row is the first row whose populated-cell count is ≥ some fraction of the sheet's max populated width **and** whose cells are mostly non-numeric short strings. A single-populated-cell first row followed by a wider row is the merged-title signature — skip to the wider row.
- Record which row index was chosen as the header, and expose it so a wrong guess is visible/correctable rather than silent.
- Do **not** hard-code "row 2" — some workbooks genuinely have the header on row 1, some on row 3. Detect, don't assume. The audit is explicit that the current failure is _assuming_, and the fix is not to assume a different fixed row.
- Where a title row is skipped, still record it (as sheet/document title metadata) — it is useful classifier signal, just not the header.

Verify the fix against the three live documents: after the change, `Woodland Data Auditing Tracker` should surface real commodity/vendor column names, not the title string.

## §3 — Fix 3: absorption — wire at least one document type through to queryable data

**Audit §1/§2 [M][D]:** `parse_summary` is a shape preview (`{format, sheets[], totalRows, textSample}`), and `textSample` for a workbook is built from **sheet names and headers only** — no cell value ever enters it. `listDocSources()` does not even select `parse_summary`; it reaches a screen through exactly one path (`listAnomalies()`, staged-only, and `staged=0` live), so it renders on **zero screens**. `applyVersion()` writes one `file_drops` row and stops — "that is the entire body of the function." Nothing downstream consumes any parsed value. Negative control confirmed: `grep` for `parse_summary` across all of `src` returns 9 files, all under `src/lib/doc-ingest/`.

**This is the real work. "Absorb" means: parsed values from at least one confirmed document type become queryable Vision data that a human or a report can use.**

Scope for tonight — **pick the highest-value, lowest-risk type and wire it end to end** rather than all types shallowly:

**Recommended first type: `equipment_inventory` / workbook → the equipment master**, OR the commodity-audit tracker → a queryable commodity/vendor reconciliation table. Rationale:

- The equipment path has a **destination that already exists** (`/admin/equipment`, ADR-0063) and a natural absorption: a confirmed equipment workbook's rows become equipment records (or a reconciliation showing what's in the sheet vs. what's in the master).
- The commodity-audit tracker is the **highest reconciliation value** (audit §4) — it cross-references commodity data against vendor invoices, which is exactly the kind of comparison against Vision's own numbers the audit says is currently absent.

**Absorption contract (whichever type is chosen):**

- On **confirmation** of a source's classification (the human action in §1), the parsed rows — using the corrected headers from §2 — are extracted into a **typed, queryable table** for that document kind (not a JSON blob; real columns).
- **Money-touching absorption stays preview-then-confirm.** Consistent with the whole system's discipline (workbook promotion, AP baselines): extracted values are **staged and shown** before they land anywhere load-bearing; a human confirms. Never auto-write to a production/billing table from an ingested document.
- **The single-writer rule holds.** If absorption would touch `processed_units_daily` or any table with a designated sole writer, it does **not** write there — it lands in its own table and, at most, produces a _comparison/reconciliation_ against the authoritative number. Absorption reads Vision's numbers to compare; it does not overwrite them.
- The absorbed data is **queryable and visible** — a report or admin surface shows it, closing the audit's core finding ("no parsed value reaches a queryable table, report, dashboard, or comparison").
- **Re-ingestion updates the absorbed data** when the source file changes (the whole point of live shared files vs. snapshots) — through the same anomaly guardrail (ADR-0067 Amendment 6): a normal change flows, an anomalous one stages and pages.

## §4 — What must NOT regress

The audit found ADR-0067 Amendments 4 and 6 fixed real silent-failure bugs. Do not reintroduce them:

- **Amendment 4:** classification must run **after** ingest (a version with parsed content must exist before it's classified). Do not reorder.
- **Amendment 6:** a delta page may **supply** a content marker, never **remove** one; a missing marker **recovers or alarms**, never silently returns `unchanged`. Absorption must not create a new path that reads stale/empty parsed data as success.
- The `[M]/[D]/[I]` claim-labelling discipline (Amendment 6 §D) — carry it into any new audit/verification notes.

## §5 — Actions for Claude Code

1. **Re-read the absorption audit in full.** It is the spec.
2. **Fix 1** — route the `/admin` tile to `/admin/doc-ingest`, link onward to anomalies/health, add the awaiting-confirmation count badge, verify reachable from Bill's landing. Confirm the three waiting docs are confirmable end to end.
3. **Fix 2** — real header-row detection (detect, don't assume a fixed row); record the chosen index; preserve title rows as metadata; verify against all three live documents.
4. **Fix 3** — choose the first absorption type (recommend equipment or commodity-audit), wire parsed rows → typed queryable table on confirmation, preview-then-confirm for anything money-touching, single-writer rule preserved, absorbed data visible in a report/surface, re-ingestion updates through the anomaly guardrail.
5. Tests: header detection on merged-title workbooks; tile reachability; absorption round-trip (confirm → queryable rows); re-ingest updates absorbed data; anomalous re-ingest stages not writes; single-writer rule not violated.
6. Do NOT regress Amendments 4 or 6.

## §6 — Success criteria

- Bill can **click** from `/admin` to the confirm queue and action the three waiting documents.
- After confirmation, at least one document type's real rows exist in a **queryable Vision table with real column names** (not a shape blob).
- That absorbed data is **visible** in a report or admin surface and, where applicable, **compared against Vision's own numbers**.
- Header detection records real column names on all three live workbooks.
- Editing a source file at its Microsoft location updates the absorbed data through the anomaly guardrail; an anomalous change stages and pages rather than flowing.
- No production/billing table gains a second writer; money-touching absorption is preview-then-confirm.
- Amendments 4 and 6 behaviors intact.

## §7 — For Bill

Once Fix 1 lands you'll have a clickable confirm queue with three real documents in it — the trailer list, the TEREX log, and the commodity audit tracker. Confirming their type is the human step that triggers absorption. The commodity audit tracker is the interesting one: it's the sheet that cross-checks commodity data against vendor invoices, which is the first real "Vision compares a shared sheet against its own numbers" capability. Everything you've shared to `docs-dr3@svdp.us` flows through this same path once it's wired.
