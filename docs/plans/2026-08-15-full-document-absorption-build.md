# Full document absorption — build plan for ADR-0104

**Date:** 2026-08-15 (Pacific)
**Status:** Build plan. Every mapping below was read off the live bytes this session; nothing here is inferred from a filename.
**Decision record:** `docs/adr/0104-every-outbound-load-is-recorded-and-not-one-has-a-weight.md`
**Executor:** Aegis (production engineering). The design half is done; do not re-litigate §D1–§D10, but do falsify any figure you can.
**Out of scope, hard:** any variance threshold, tolerance, or mismatch verdict (AK-4c); any write to an operational table (AK-4b); any absorber for the four archive-only classes.

---

## 1. What you are building, in one paragraph

`mymrc_outbound_mirror` holds 4,673 outbound loads and `weight_lbs` is NULL on every one of them. "Woodland Outbound Auditing 2026.xlsx" holds that weight for ~1,085 Woodland loads (Jan–Jun 2026), joinable on a UNIQUE-indexed key. You are adding two absorbable document classes that land in version-scoped `doc_*` reference tables, four archive-only classes so the classifier stops asking, a read module that surfaces the join without grading it, and two defect fixes that would otherwise corrupt the work. You are not writing a single operational table.

## 2. Premises corrected on checking — read this before you start

Two claims in the handoff that commissioned ADR-0104 were re-measured and are **false at scale**. If you find yourself designing around either one, stop.

| Claim                                                                            | Measured                                                                               |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| "Notes carry hand-recorded linkage: ticket numbers that ARE BOL IDs, M-id lists" | **1 row of 369** carries an `M-######` id. 11 rows say "MyMRC" in prose. Not a join.   |
| "29 rows carry H-haul numbers in `commodity`"                                    | **6**, all in `WOODLAND 2026`; 0 in `WOODLAND 2025`, `STOCKTON 2025`, `STOCKTON 2026`. |

A third, from the classifier rather than the handoff: the proposal `commodity_audit_tracker @ 0.30` on the Outbound file is not a near-miss to be nudged. The model was reasoning inside a prompt bug (§6.1) — it wrote _"that kind is not in the allowed list"_ about a kind that **is** in the allowed list. Fix the prompt, do not tune the confidence.

## 3. Execution order

Front-loaded so the two defect fixes land before anything depends on them, and so the largest unknown (the outbound extractor) is proven before the smaller work.

| #   | Step                                                               | Why here                                                                                                            |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 1   | §6.1 classifier prompt derivation + §6.2 `KIND_OPTIONS` derivation | Everything downstream needs a class to be selectable and describable. Both are small and both are currently broken. |
| 2   | §5.1 `DOC_KINDS` + `DOC_KIND_DESCRIPTIONS` additions               | Type-level; makes step 1's `Record<DocKind, string>` fail loudly until every new class is described.                |
| 3   | §7 migrations (3 files)                                            | Schema before extractors so the tests can write.                                                                    |
| 4   | §8 `outbound-extract.ts` + tests                                   | The hard one. Prove the dedup and the sign trap against fixtures before wiring anything.                            |
| 5   | §9 `outbound-absorb.ts` + `absorb.ts` dispatch                     |                                                                                                                     |
| 6   | §10 `facility-expense-extract.ts` / `-absorb.ts` + dispatch        | Simpler; benefits from the shape settled in 4–5.                                                                    |
| 7   | §11 decide services + routes + review clients (both classes)       | Must exist before confirmation, or you ship P-46 twice.                                                             |
| 8   | §12 `outbound-reconcile.ts` read module + read-only admin page     |                                                                                                                     |
| 9   | §13 the single-instance guard test                                 | Protects §14 step 3 from a future session.                                                                          |
| 10  | §14 operator steps                                                 | Bill's confirmations. Do not run these yourself beyond the disable in step 3.                                       |

## 4. The 11 documents and their disposition

| #   | `doc_source` id | Document                                | Class                             | Absorb?                  | Target                                                   |
| --- | --------------- | --------------------------------------- | --------------------------------- | ------------------------ | -------------------------------------------------------- |
| 1   | `8a0246e7`      | TEREX.xlsx (Janette, live)              | `terex_maintenance_log`           | already                  | `doc_terex_maintenance_rows`                             |
| 2   | `82e6d34b`      | Woodland Trailer list.xlsx              | `trailer_list`                    | already                  | `doc_trailer_rows`                                       |
| 3   | `9f71ccb3`      | Woodland Data Auditing Tracker (1).xlsx | `commodity_audit_tracker`         | already                  | `doc_commodity_audit_rows`                               |
| 4   | `63da2155`      | Woodland Outbound Auditing 2026.xlsx    | **`outbound_weight_audit`** (new) | **yes, staged**          | `doc_outbound_load_rows` + `doc_outbound_commodity_rows` |
| 5   | `e0101cb5`      | Woodland Invoices tracking.xlsx         | **`facility_expense_log`** (new)  | **yes, staged**          | `doc_facility_expense_rows`                              |
| 6   | `4dc90aa9`      | DR3 Data Tracking.xlsx                  | **`analysis_workbook`** (new)     | no — archive             | —                                                        |
| 7   | `a3ebe67e`      | JOURNAL Woodland Facility.xlsx          | **`facility_journal`** (new)      | no — archive             | —                                                        |
| 8   | `5b298aeb`      | TEREX.xlsx (Kelsey copy)                | `terex_maintenance_log`           | **no — `enabled=false`** | —                                                        |
| 9   | `43352ea1`      | DR3 Task Lists for 2025.xlsx            | **`admin_task_tracker`** (new)    | no — archive             | —                                                        |
| 10  | `11f7f5fb`      | DR3 Meeting Notes Log 2026.xlsx         | **`meeting_notes_log`** (new)     | no — archive             | —                                                        |
| 11  | `d37c8104`      | DR3 Machine List (2).xlsx               | `equipment_inventory` (existing)  | no — archive             | —                                                        |

All 11 are site **DR3 Woodland** (`de9875a3-a09f-484f-aed1-2891ef544b87`) except #11, which is a multi-site register and takes site **NULL** — it is archive-only, so hard rule #2 never fires on it.

## 5. Class vocabulary

### 5.1 `src/lib/doc-ingest/classifier.ts`

Add to `DOC_KINDS` (order: keep absorbable kinds grouped, archive kinds after):

```
'outbound_weight_audit', 'facility_expense_log',
'facility_journal', 'meeting_notes_log', 'admin_task_tracker', 'analysis_workbook',
```

Add `export const DOC_KIND_DESCRIPTIONS: Record<DocKind, string>` covering **all** kinds — including the three currently undescribed (`trailer_list`, `terex_maintenance_log`, `commodity_audit_tracker`). Suggested text for the new ones:

- `outbound_weight_audit` — a MyMRC outbound report export listing shipped loads with per-commodity weights and dispositions.
- `facility_expense_log` — a hand-kept log of facility expenses and invoices already paid, with categories and amounts.
- `facility_journal` — a free-text operations journal of daily facility events.
- `meeting_notes_log` — a free-text log of meeting dates, attendees and notes.
- `admin_task_tracker` — a project/task tracker with titles, priorities and due dates.
- `analysis_workbook` — a derived analytics workbook of forecasts, ratios and pivots computed from other sources.

Local `RULES` entries (optional but cheap, and they keep the Claude fallback off the hot path). Take the structure signals from the **real** headers, per the file's own comment discipline:

- `outbound_weight_audit` — name: `/outbound/i`, `/auditing/i`; structure: `/materials:\s*materials id/i`, `/bol id/i`, `/total outbound weight/i`, `/disposition/i`.
- `facility_expense_log` — name: `/invoices?\s+tracking/i`; structure: `/present on daily log/i`, `/credit amt/i`, `/invoice\s*#/i`, `/machine id/i`.
- `facility_journal` — name: `/journal/i`; structure: `/facility journal/i`.
- `meeting_notes_log` — name: `/meeting notes/i`; structure: `/meeting date/i`, `/attendees/i`.
- `admin_task_tracker` — name: `/task list/i`; structure: `/project title/i`, `/%\s*complete/i`.
- `analysis_workbook` — name: `/data tracking/i`; structure: `/mass balance/i`, `/forecast/i`, `/recovery rate/i`.

### 5.2 `src/lib/doc-ingest/absorb.ts`

`ABSORBABLE_KINDS` gains exactly two: `'outbound_weight_audit'`, `'facility_expense_log'`. The four archive classes and `equipment_inventory` stay out.

## 6. The two defect fixes

### 6.1 The prompt disagrees with the enum

`classifier.ts` `userPrompt()` currently emits `kind must be exactly one of: ${DOC_KINDS.join(', ')}` (9 kinds) followed by a hand-written bullet list describing 6. Generate the bullet list from `DOC_KIND_DESCRIPTIONS`:

```ts
Object.entries(DOC_KIND_DESCRIPTIONS)
  .map(([k, d]) => `- ${k}: ${d}\n`)
  .join('');
```

Test: assert every member of `DOC_KINDS` appears in the rendered user prompt's bullet section. That test fails today.

### 6.2 The confirm dropdown cannot select an absorbable class

`src/app/admin/doc-ingest/SourcesClient.tsx:23` hardcodes a 5-entry `KIND_OPTIONS` missing all three absorbable classes; line 157's draft pre-fill silently drops any proposal not in it. Replace with a derivation mirroring the route's filter (`src/app/api/admin/doc-ingest/sources/route.ts:41`):

```ts
const KIND_OPTIONS = DOC_KINDS.filter((k) => k !== 'vendor_invoice' && k !== 'unknown');
const KIND_LABEL: Record<DocKind, string> = {
  /* every kind, exhaustively */
};
```

`Record<DocKind, string>` is the point — a new class must fail to compile until it is labelled. Verify the pre-fill at line 157 now accepts `commodity_audit_tracker`.

## 7. Migrations

Hand-written, idempotent, `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, all id and FK columns `TEXT`, must replay clean on an empty PG16 (ADR-0035). Next free ordinal is **20260847** (current tail is `20260846_adr0071_a2_min_misses_default_3`).

```
prisma/migrations/20260847_adr0104_outbound_weight_audit/migration.sql
prisma/migrations/20260848_adr0104_facility_expense_log/migration.sql
```

FK convention, matching the existing absorbed-row tables: `doc_source_id` and `doc_source_version_id` FKs are `ON DELETE CASCADE`; `site_id` is `ON DELETE SET NULL`. In Prisma, only `site` is a declared relation — the two doc ids are plain scalars.

### 7.1 `doc_outbound_load_rows`

```prisma
model DocOutboundLoadRow {
  id                    String  @id @default(uuid())
  doc_source_id         String
  doc_source_version_id String
  site_id               String?
  site                  Site?   @relation(fields: [site_id], references: [id])

  sheet_name String
  row_index  Int

  /// The join key. `Materials: Materials ID`, e.g. "M-160053". Matches
  /// `mymrc_outbound_mirror.external_materials_id`, which is UNIQUE-indexed.
  external_materials_id String
  bol_id                String?
  /// The sheet's `Account Name`. Absent on both April sheets, so it is NEVER the
  /// source of site — site comes from the doc_source. Stored to assert against.
  account_name_raw      String?
  materials_status      String?
  materials_record_type String?

  shipment_date     DateTime? @db.Date
  /// ALWAYS what the cell said. The same shipment appears as an Excel Date on
  /// one sheet and the serial 46055 on its duplicate.
  shipment_date_raw String?

  /// From `Total Outbound Weight` — the POSITIVE figure, which reconciles to the
  /// sum of the 13 commodity columns exactly (113 of 113 rows sampled).
  total_weight_lbs       Decimal? @db.Decimal(12, 2)
  /// From `Total Outbound Materials Weight`, which is its NEGATION. Stored only
  /// so the guardrail can assert the sign relationship and fail loudly if the
  /// workbook's convention changes. NEVER read as a weight.
  total_weight_check_lbs Decimal? @db.Decimal(12, 2)

  /// NULL when the sheet recorded nothing. Never 0 for a blank.
  program_units     Int?
  non_program_units Int?

  status         DocAbsorptionStatus @default(staged)
  confirmed_at   DateTime?
  confirmed_by   String?
  discarded_at   DateTime?
  discarded_by   String?
  discard_reason String?

  absorbed_at DateTime @default(now())

  @@unique([doc_source_version_id, external_materials_id])
  @@index([doc_source_id, status])
  @@index([site_id, shipment_date])
  @@index([external_materials_id])
  @@map("doc_outbound_load_rows")
}
```

The unique key is `(version, external_materials_id)` and **not** `(version, sheet, row_index)`. That is the whole dedup mechanism: the four identical sheet pairs collide on it by construction. Index names follow house convention — `doc_outbound_load_rows_version_matid_key`, `doc_outbound_load_rows_source_status_idx`, `doc_outbound_load_rows_site_ship_idx`, `doc_outbound_load_rows_matid_idx`.

### 7.2 `doc_outbound_commodity_rows`

```prisma
model DocOutboundCommodityRow {
  id                    String @id @default(uuid())
  doc_source_id         String
  doc_source_version_id String
  site_id               String?
  site                  Site?  @relation(fields: [site_id], references: [id])

  external_materials_id String
  /// VERBATIM column stem: "Foam", "Shoddy/Felt", "Whole Mattresses and
  /// Foundations". Not normalised — the commodity vocabulary is data, and
  /// putting it in the schema makes adding one a migration.
  commodity             String
  weight_lbs            Decimal? @db.Decimal(12, 2)
  /// Live vocabulary is exactly four values: Recycling, Landfill, Biomass,
  /// Renovation. Stored verbatim, NEVER mapped — mapping "Landfill" onto
  /// `landfilled_units` semantics is the operational write ADR-0104 D1 forbids.
  disposition           String?

  sheet_name String
  row_index  Int

  status      DocAbsorptionStatus @default(staged)
  absorbed_at DateTime            @default(now())

  @@unique([doc_source_version_id, external_materials_id, commodity])
  @@index([doc_source_id, status])
  @@index([site_id, commodity])
  @@map("doc_outbound_commodity_rows")
}
```

Write a row only where the commodity's `(lbs)` cell is non-null. Feb 2026 has 120 populated commodity cells across 113 loads — the grain is sparse and most loads are single-commodity.

Child `status` mirrors the parent's and is flipped by the same decide call in the same transaction.

### 7.3 `doc_facility_expense_rows`

```prisma
model DocFacilityExpenseRow {
  id                    String  @id @default(uuid())
  doc_source_id         String
  doc_source_version_id String
  site_id               String?
  site                  Site?   @relation(fields: [site_id], references: [id])

  sheet_name String
  /// The sheet's own banner year, from the sheet name ("WOODLAND 2026" -> 2026).
  sheet_year Int?
  row_index  Int

  present_on_daily_log String?
  receipt_raw          String?
  invoice_date         DateTime? @db.Date
  invoice_date_raw     String?

  /// NULL when the cell was blank. NEVER 0 — an expense with no recorded amount
  /// is not a free expense (the ADR-0069 Am.2 rule for `actual_repair_cost`).
  amount        Decimal? @db.Decimal(12, 2)
  credit_amount Decimal? @db.Decimal(12, 2)

  /// VERBATIM. The live sheets hold 16 and 18 distinct values including case
  /// variants of one category ("Transportation"/"transportation").
  category_raw  String?
  /// Trimmed + lower-cased, for grouping. A CONVENIENCE, not a taxonomy —
  /// nobody has agreed a taxonomy.
  category_norm String?

  invoice_number String?
  notes          String?
  machine_id_raw String?
  day_raw        String?

  /// VERBATIM. The column is overloaded: real commodities ("wood", "trash",
  /// "pocket coils") and 6 H-haul references.
  commodity_raw String?
  /// Set ONLY when `commodity_raw` matches ^H-?\d+. Null otherwise.
  haul_ref      String?
  /// Present only on the WOODLAND 2026 sheet.
  gallons       Decimal? @db.Decimal(10, 2)

  status         DocAbsorptionStatus @default(staged)
  confirmed_at   DateTime?
  confirmed_by   String?
  discarded_at   DateTime?
  discarded_by   String?
  discard_reason String?

  absorbed_at DateTime @default(now())

  @@unique([doc_source_version_id, sheet_name, row_index])
  @@index([doc_source_id, status])
  @@index([site_id, invoice_date])
  @@map("doc_facility_expense_rows")
}
```

## 8. `src/lib/doc-ingest/outbound-extract.ts`

Pure, no exceljs, `Cell[][]` in — the `Cell` type and `toCell` come from `trailer-absorb.ts` as the other two extractors do. **Never throws for a bad sheet**; refusals are returned.

Use the **workbook-level `terex-extract.ts` shape, not the per-sheet `commodity-extract.ts` shape.** The duplication is cross-sheet, so a per-sheet extractor structurally cannot see it.

```ts
export interface OutboundLoad {
  externalMaterialsId: string;
  bolId: string | null;
  accountNameRaw: string | null;
  materialsStatus: string | null;
  materialsRecordType: string | null;
  shipmentDateISO: string | null;
  shipmentDateRaw: string | null;
  totalWeightLbs: number | null;
  totalWeightCheckLbs: number | null;
  programUnits: number | null;
  nonProgramUnits: number | null;
  sheetName: string;
  rowIndex: number;
  commodities: Array<{ commodity: string; weightLbs: number; disposition: string | null }>;
}

export interface OutboundExtractResult {
  loads: OutboundLoad[];
  sheets: Array<{ sheetName: string; loadsFound: number; skipped: string | null }>;
  duplicatesRemoved: number;
  duplicateSources: string[]; // "M-160053 also on \"Feb2026 outbounds\""
  signCheckFailures: string[]; // matId where check != -total
  failure: { kind: string; message: string } | null;
}

export function extractOutboundRows(
  collected: Array<{ name: string; cells: Cell[][] }>,
): OutboundExtractResult;
```

### 8.1 Sheet candidacy

A sheet is a candidate iff a header row within the first 12 rows contains **both** `Shipment Date` and `Materials: Materials ID`. Anything else gets `skipped: '<reason>'` and is reported, not dropped silently.

Measured header rows vary — 1, 2, 4, and **10**. Detect; never count off. Measured outcome: 11 candidates of 16 sheets. The 5 skipped are `Foam_Topper`, `Wood`, `steel`, `trash`, `other` — pivot sheets carrying `$/ton`, `total cost`, `gross profit`. Refusing them is deliberate (ADR-0104 §D3), and a test should assert they are refused, not merely that they are absent.

### 8.2 Column resolution — by header name, never by offset

`Column1` / `Column2` filler columns appear and disappear between sheets, and `Whole Mattresses and Foundations` has **no** matching `Disposition` column on some sheets (measured: `d-1` on `Outbound Feb 2026`). Resolve every column by exact header text; a missing optional column yields null, a missing required one (`Materials: Materials ID`, `Shipment Date`) skips the sheet.

Commodity stems, exactly as they appear:

```
Cardboard, Cotton, Foam, Natural Fiber, Plastics, Quilt and Toppers, Shoddy/Felt,
Steel, Synthetic Fiber, Waste, Wood, Whole Mattresses and Foundations, Other
```

Weight column is `<stem> (lbs)`. Disposition column is `<stem> Disposition` **except** `Whole Mattresses and Foundations`, whose header is `Whole Mattresses/Foundations Disposition`. Handle that one explicitly; do not regex your way around it.

### 8.3 The sign trap

`totalWeightLbs` ← `Total Outbound Weight`. `totalWeightCheckLbs` ← `Total Outbound Materials Weight`.

Assert `check ≈ -total` (1 lb tolerance) per row. Failures go to `signCheckFailures` and are surfaced in the absorb note; they do not sink the sheet. Measured on `Outbound Feb 2026`: `sum(total) = +763,813`, `sum(check) = -763,813`, `sum(commodity parts) = +763,813`, 113 of 113 rows.

Also assert `sum(commodity parts) ≈ totalWeightLbs` per row and report drift the same way. That second assertion is what catches a missed commodity column after a workbook edit.

### 8.4 Dates

`Shipment Date` arrives three ways across sheets — a real `Date`, an Excel serial number (`46055`), and text (`1/12/2026`). Parse all three into `shipmentDateISO`; keep the cell's own text in `shipmentDateRaw` always. Excel serial epoch: day 1 = 1899-12-31, with the 1900 leap-year artefact — reuse whatever `toCell`/`trailer-extract.ts` already does rather than writing a fourth converter.

### 8.5 De-duplication

After collecting candidates in workbook order, fold on `externalMaterialsId`: first occurrence wins, later ones increment `duplicatesRemoved` and push `"<matId> also on \"<sheet>\""` into `duplicateSources`.

Expected on the live file: 11 candidate sheets, **~1,085 distinct loads**, `duplicatesRemoved` ≈ **556** (113 Feb + 135 Mar + 158 Apr + 139 May + 11 `xtraction (2)`). Assert the count in a test against a fixture built from the real header shapes — if it drifts, something changed and you want to know.

### 8.6 Refusals

| `failure.kind`        | Trigger                                                      |
| --------------------- | ------------------------------------------------------------ |
| `no_candidate_sheets` | zero sheets carry both required headers                      |
| `no_loads`            | candidates found, zero rows with a `Materials: Materials ID` |

## 9. `src/lib/doc-ingest/outbound-absorb.ts` + dispatch

```ts
export async function extractOutboundFromWorkbook(
  bytes: Uint8Array,
): Promise<{ sheetNames: string[]; result: OutboundExtractResult }>;

export async function stageOutboundRows(
  tx: PrismaClient | Prisma.TransactionClient,
  args: {
    sourceId: string;
    versionId: string;
    siteId: string;
    result: OutboundExtractResult;
    now: Date;
  },
): Promise<{ staged: number; commodityRows: number }>;

export function describeOutboundSheets(result: OutboundExtractResult): string;
```

`MAX_COLS` = **48** (widest measured monthly sheet is 39 columns; leave headroom).

Staging discipline, identical to `stageCommodityRows` — do not invent a variant:

1. `deleteMany({ where: { doc_source_version_id, status: 'staged' } })` on both tables (children first).
2. `findMany` rows already `confirmed`/`discarded` for this version → a `decided` key set → those keys are **skipped, never rewritten**.
3. In-memory `claimed` set for same-batch collisions → reported, never silent.
4. Single `createMany` per table.

The `$transaction` wrapper lives in the **caller** (`absorb.ts`), matching the existing three.

`absorb.ts` changes: add both kinds to `ABSORBABLE_KINDS`; add two `if` blocks to the dispatch at ~line 294 (there is no switch and no registry — do not add one); add two private `absorbXxx` functions on the existing 6-step template: try/catch extract → LOUD ZERO → `$transaction(stage)` → derive `datesCovered` → `writeAudit` → `resolveAnomaly` → `finishTerminal`.

`datesCovered` for outbound = distinct `shipmentDateISO`; for expenses = distinct `invoice_date`.

Nothing changes in `sweep.ts` (absorption is driven by `runAbsorptionPass` queue predicates, not per-kind wiring) or `guardrail.ts` (kind-agnostic by design — do not add a per-class hook; that is net-new architecture, not an extension point).

## 10. `src/lib/doc-ingest/facility-expense-extract.ts` + `-absorb.ts`

Per-sheet shape (`commodity-extract.ts`), because these sheets are genuinely independent.

- **Sheet gate.** Absorb `WOODLAND 2025`, `WOODLAND 2026`. Refuse `STOCKTON 2025`, `STOCKTON 2026` with `skipped: 'site_not_registered'` — Stockton is not in `sites` and hard rule #2 forbids a NULL-site row on a site-scoped surface. Refuse `Sheet1` (18 rows, weak header, no `Invoice Date`) with `no_header_row`. Match the site prefix on the sheet name, case-insensitively; do not hardcode the four names.
- **Header row.** Measured at row 3 on all four data sheets — still detect it by finding `Invoice Date`, do not hardcode 3.
- **Column mapping** (header text → field):

| Header                          | Field                            | Notes                                                                          |
| ------------------------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| `Present on Daily Log`          | `present_on_daily_log`           | verbatim                                                                       |
| `desk receipt` / `receipt date` | `receipt_raw`                    | header differs: `STOCKTON 2025` says `receipt date`, the others `desk receipt` |
| `Invoice Date`                  | `invoice_date` + `_raw`          |                                                                                |
| `Amt.`                          | `amount`                         | NULL when blank, never 0                                                       |
| `credit amt`                    | `credit_amount`                  | NULL when blank, never 0                                                       |
| `category`                      | `category_raw` + `category_norm` | skip the row if `category_raw === 'category'` (repeated header)                |
| `Invoice #`                     | `invoice_number`                 |                                                                                |
| `Notes`                         | `notes`                          | verbatim, unparsed                                                             |
| `Machine ID`                    | `machine_id_raw`                 |                                                                                |
| `day`                           | `day_raw`                        |                                                                                |
| `commodity`                     | `commodity_raw` + `haul_ref`     | `haul_ref` only when `^H-?\d+`                                                 |
| `gallons`                       | `gallons`                        | `WOODLAND 2026` only                                                           |

- **Expected volumes** (measured): `WOODLAND 2026` 144 data rows / $430,607; `WOODLAND 2025` 200 / $544,322. Stockton refused: 17 / $15,736 and 8 / $6,124. Assert the two absorbed row counts in a test.

## 11. Decide services, routes, review clients

One per staging class, on the `terex-decide.ts` contract exactly:

- The batch is a **version**, not a row.
- Totals are computed from staged rows **before** the `updateMany` and captured into the audit row as `totals_accepted` / `totals_rejected` — the evidence of what was on screen at the moment of acceptance.
- Actor is `{ userId } | { label }`, XOR. A named non-human run writes `actor_label` with `actor_user_id` NULL and never borrows a `users.id` (ADR-0077).
- Result union includes `{ ok: false, reason: 'nothing_staged' }`.

Files:

```
src/lib/doc-ingest/outbound-decide.ts           + src/app/api/admin/doc-ingest/outbound/route.ts
src/lib/doc-ingest/facility-expense-decide.ts   + src/app/api/admin/doc-ingest/expenses/route.ts
src/app/admin/doc-ingest/outbound/ (review client, confirm/discard)
src/app/admin/doc-ingest/expenses/ (review client, confirm/discard)
```

Routes keep their own `checkAdmin()` and a `z.discriminatedUnion('action', [...])` body, matching the terex route.

`outbound-decide.ts` flips parent **and** child rows in one transaction. Totals for the confirm audit: load count, summed `total_weight_lbs`, and commodity-row count.

**Do not skip this section.** `doc_commodity_audit_rows` has 252 rows that can never leave `staged` because this step was skipped once (P-46).

## 12. `src/lib/doc-ingest/outbound-reconcile.ts` + read-only page

Read module on the `commodity-ledger.ts` contract:

```ts
export type OutboundScope = 'confirmed' | 'staged';   // NEVER a union
async function latestVersion(siteId: string, scope: OutboundScope):
  Promise<{ versionId: string; absorbedAt: Date } | null>;
export async function computeOutboundCoverage(...): Promise<OutboundCoverage>;
```

**Pin the winning `doc_source_version_id` first, then aggregate only inside it.** This is ADR-0077 and it is not optional. `OutboundCoverage.versionId` is the one revision every figure came from, and the page renders it.

Per calendar month, for the pinned revision: mirror loads, loads with an absorbed weight, loads without, summed `total_weight_lbs`, and the commodity breakdown. Join `doc_outbound_load_rows.external_materials_id = mymrc_outbound_mirror.external_materials_id`.

**No threshold, no tolerance, no `ok`/`mismatch` verdict, no alert.** AK-4c. The page states the uncovered count plainly — expect it to be large (P-47: the workbook covers Woodland Jan–Jun 2026 only; ~3,590 of 4,673 loads stay weightless).

Page: `src/app/admin/doc-ingest/outbound-coverage/` — read-only, and say so in the header the way the commodity page does.

## 13. Guard test

`src/lib/doc-ingest/__tests__/single-instance-sources.test.ts`:

> For each absorbable `doc_class` that names a single physical document, at most one `doc_source` may be `enabled = true` per site.

This is what keeps Kelsey's TEREX copy (`5b298aeb`) from being re-enabled by a future session that no longer remembers why it is off (P-52). Prove it can fail: a fixture with two enabled `terex_maintenance_log` sources at one site must fail the assertion.

## 14. Post-build operator steps

Confirmations are executed under **Bill's user id** per his instruction; the audited precedent is ADR-0077 D1. Do steps 1–3 yourself only if Bill has directed it in-session; otherwise hand him the list.

1. **Confirm `63da2155`** → class `outbound_weight_audit`, site DR3 Woodland, period null. Sweep absorbs on the next `runAbsorptionPass`. Expect ~1,085 staged load rows and `duplicatesRemoved` ≈ 556 in the absorb note.
2. **Confirm `e0101cb5`** → class `facility_expense_log`, site DR3 Woodland, period null. Expect 344 staged rows across the two Woodland sheets and two sheets reported as `site_not_registered`.
3. **Confirm `5b298aeb`** → class `terex_maintenance_log`, site DR3 Woodland — **then immediately set `enabled = false`.** Do these as one operation. Between the confirm and the disable the source is absorbable, and a sweep landing in that window double-absorbs 173 maintenance rows. If the admin surface cannot do both atomically, disable **first** and confirm second; a disabled source is not queued by `runAbsorptionPass`.
4. **Confirm the four archive classes** — `4dc90aa9` → `analysis_workbook`, `a3ebe67e` → `facility_journal`, `43352ea1` → `admin_task_tracker`, `11f7f5fb` → `meeting_notes_log`. All site DR3 Woodland. None is in `ABSORBABLE_KINDS`, so each records `not_absorbable` and stops being re-proposed.
5. **Confirm `d37c8104`** → `equipment_inventory`, site **NULL**. It is a multi-site register; leave site unset rather than mislabelling it Woodland.
6. **Review and confirm the two staged batches** on the new review pages, after eyeballing the totals against the workbook.
7. **Verify**: `doc_sources` shows 11 registered / 0 unconfirmed; `runAbsorptionPass` reports `absorbed` for the two new sources and `not_absorbable` for the five archive ones; the coverage page renders with a pinned version id.

## 15. Verification gate before you claim done

- `node scripts/check-adr-citations.mjs` — any `ADR-0104` you write into `src/`, `scripts/`, `e2e/`, `tests/` must resolve. Markdown is not scanned, code is.
- `node scripts/extract-adr-promises.mjs --check`
- `npx vitest run src/__tests__/adr-record-integrity.test.ts`
- Full `vitest run` + typecheck + lint.
- Migrations replay clean on an empty PG16.
- **Adversarial**: for each of the three double-count traps, write the test that fails against the naive implementation first, and quote its failure output. A dedup test that passes without ever having failed proves nothing. Specifically: (a) a fixture with a duplicated sheet pair must produce N loads, not 2N; (b) an extractor reading `Total Outbound Materials Weight` must produce a negative total and the test must catch it; (c) two enabled `terex_maintenance_log` sources must fail §13.
- Do not report success from an exit code. Quote the observed end state — row counts from the absorb note, the pinned version id on the coverage page.
