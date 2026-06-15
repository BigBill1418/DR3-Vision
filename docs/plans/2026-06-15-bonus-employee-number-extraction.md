# Plan: Extract employee numbers from `bonus_employees.full_name` into a dedicated `employee_number` column

**Date:** 2026-06-15
**Author:** Terry (research/architecture)
**Implementer:** Aegis
**Status:** Ready to build
**Related ADR:** ADR-0026 (stub content in §10 of this doc — write it as part of the same change)
**Charter cross-ref:** PROJECT-CHARTER.md Bonus Management (ADR-0019 family); display-name behavior ADR-0019 §9b

---

## 0. TL;DR for the implementer

The Woodland bonus roster has employee numbers jammed onto the end of the display
name as `Firstname Lastname 6317`. This plan adds a nullable `employee_number`
column to `bonus_employees`, backfills it from the trailing 4-digit token, strips
that token out of `full_name` (recording the pre-strip value in `previous_names`
for provenance), and leaves a clean display name behind. It is a single idempotent
Prisma migration (`20260615_bonus_employee_number`) whose `migration.sql` does
**both** the DDL and the data backfill, applied by the existing
`scripts/migrate-with-ntfy.mjs` deploy wrapper. No application code paths change
behavior in this migration — `employee_number` is additive and unused by the app
until a later ticket surfaces it. **Per-site uniqueness is enforced at the
application layer, NOT with a database unique constraint** (see §4.3 for the
reasoning — soft-deleted rows + future multi-site collisions make a global DB
unique constraint wrong).

This spec is self-contained: every value below was read from the live production
database on 2026-06-15. You do **not** need to query the DB to implement it. A
DB-access recipe is included (§1.1) so you _can_ re-verify if you choose, and a
verification query (§7) you **must** run after applying.

---

## 1. Live data ground-truth (verified 2026-06-15 against production)

All figures below were taken directly from the live `dr3_vision` database on
svdp-dev, not inferred.

### 1.1 DB-access recipe (for optional re-verification)

```bash
ssh -i ~/.ssh/id_ed25519 bbarnard065@10.99.0.2
# then on svdp-dev:
docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision
# or one-shot:
docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision -c "SELECT ..."
```

- WireGuard peer `10.99.0.2` = svdp-dev (also `10.0.2.205/24`). Auth as user
  `bbarnard065` via `id_ed25519`; `deploy`/`root` do **not** work.
- The `dr3-vision-postgres` container runs **directly on svdp-dev**. There is no
  separate CHAD-HQ Postgres hop in practice (the charter names CHAD-HQ as the
  fleet host, but the live DB is here).
- DB name `dr3_vision`, user `dr3`.

### 1.2 The finding

| Metric                                                               | Value                                                                                                           |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Total `bonus_employees` rows                                         | **107**                                                                                                         |
| Rows whose `full_name` ends in ` ` + exactly 4 digits (` [0-9]{4}$`) | **21**                                                                                                          |
| Rows whose `full_name` ends in _any_ trailing digits (`[0-9]+$`)     | **21** (identical set — no 3- or 5-digit variance)                                                              |
| Distinct sites containing numbered rows                              | **1** (`DR3 Woodland`)                                                                                          |
| Distinct extracted numbers among the 21                              | **21** (zero duplicates)                                                                                        |
| Numbers with a leading zero                                          | **0**                                                                                                           |
| Soft-deleted / inactive numbered rows                                | **1** (one row is `is_active=false`, `deleted_at` set) — **must still be backfilled**                           |
| Numbered rows that already have `previous_names` populated           | **21** (all of them — `previous_names` is already non-null JSON; the backfill must **append**, never overwrite) |
| `users.name` rows containing any digit                               | **0** (the operator/staff `users` table is clean — do NOT touch it)                                             |
| `bonus_employees.full_name` column type                              | `text NOT NULL`                                                                                                 |
| `bonus_employees.employee_number` column exists today                | **No** (0 rows in `information_schema.columns`)                                                                 |

**Key implications baked into this design:**

- The pattern is uniform: a single space then exactly four ASCII digits at the
  very end. No 3/5-digit width variance, no embedded numbers, no leading-zero
  numbers, no numbers anywhere but the trailing position.
- One of the 21 is **soft-deleted and inactive**. The backfill must not filter on
  `is_active` or `deleted_at` — extract for all matching rows.
- `previous_names` is **already populated** on all 21 rows (prior name-history
  from ADR-0019 §9b retroactive display). The provenance step must **append** a
  new entry to the existing JSON array, not replace it.
- All 21 live in `DR3 Woodland`. Eugene rows (enabled per ADR-0019.2) are not
  numbered. This matches the legacy-roster origin of the numbers.

### 1.3 Regex pattern (canonical)

- **Match / detect a numbered row:** ` [0-9]{4}$` (POSIX, as used in Postgres
  `~`). In JS this is `/ \d{4}$/`.
- **Capture the number:** ` ([0-9]{4})$` → group 1 is the 4-digit string.
- **Strip the number to get the clean name:** replace ` [0-9]{4}$` with `''`,
  then `btrim()` defensively.

The migration uses the SQL forms (`substring(... from ...)`,
`regexp_replace(...)`, `btrim(...)`) — see §5.

### 1.4 Masked sample of all 21 rows (first initial + last 4)

These are the real rows, masked. `namelen` = current `length(full_name)`.
`active` = `is_active`. `sdel` = soft-deleted.

```
site          masked        namelen  active  sdel
DR3 Woodland  A*** 6317     18       t       f
DR3 Woodland  A*** 9081     19       t       f
DR3 Woodland  C*** 8992     23       t       f
DR3 Woodland  D*** 7113     19       t       f
DR3 Woodland  F*** 6048     19       t       f
DR3 Woodland  F*** 5680     17       t       f
DR3 Woodland  F*** 7083     20       t       f
DR3 Woodland  J*** 9071     18       f       t     <-- soft-deleted, MUST still backfill
DR3 Woodland  J*** 9001     18       t       f
DR3 Woodland  J*** 7826     15       t       f
DR3 Woodland  J*** 9020     19       t       f
DR3 Woodland  M*** 6962     17       t       f
DR3 Woodland  M*** 6344     25       t       f
DR3 Woodland  M*** 9010     20       t       f
DR3 Woodland  N*** 9032     15       t       f
DR3 Woodland  N*** 7483     20       t       f
DR3 Woodland  N*** 5420     20       t       f
DR3 Woodland  O*** 8542     19       t       f
DR3 Woodland  S*** 8533     24       t       f
DR3 Woodland  T*** 6961     17       t       f
DR3 Woodland  T*** 7866     18       t       f
```

(Numbers shown are the real 4-digit values — they are employee numbers, not PII
in the sensitive sense; names are masked to first initial.)

---

## 2. Goal / definition of done

1. `bonus_employees` has a new nullable column `employee_number TEXT` (Prisma
   `employee_number String?`).
2. A non-unique index `(site_id, employee_number)` exists.
3. Exactly **21** rows have `employee_number` populated with the correct 4-digit
   string; the other 86 remain `NULL`.
4. Those 21 rows' `full_name` no longer carries a trailing ` ####` token (clean
   display names), with no leading/trailing whitespace.
5. Each of the 21 rows' `previous_names` JSON array has **one new appended entry**
   recording the pre-strip `full_name` and the reason, without losing any
   existing entries.
6. The migration is idempotent — re-running it (or applying it to a DB where it
   already partially ran) changes nothing and errors nowhere.
7. App-level per-site uniqueness validation is added (see §4.3) for future writes;
   **no DB unique constraint** is added.
8. Docs deltas landed in the same commit: ADR-0026, CHANGELOG entry, QUESTIONS.md
   entry (§10).
9. Verification query (§7) returns `extracted = 21`, `name_still_numbered = 0`.

**Non-goals (explicitly out of scope for this change):**

- Surfacing `employee_number` in any UI, PDF, export, or API response.
- Backfilling Eugene or any future site (none are numbered today).
- Adding a DB-level unique constraint.
- Generating numbers for the 86 unnumbered rows.

---

## 3. Chosen mechanism

**One idempotent Prisma migration that performs DDL + data backfill in the same
`migration.sql`, deployed by the existing `scripts/migrate-with-ntfy.mjs`
wrapper.**

- **Migration directory:** `prisma/migrations/20260615_bonus_employee_number/`
  (matches the repo's date-prefixed, no-time naming used since
  `20260606_bi_weekly_pay_periods` / `20260608_historical_data_import` /
  `20260609_all_sites_manager`).
- **Why a migration and not a one-off script:** the column add is schema, and the
  backfill is a small, deterministic, one-time data correction tightly coupled to
  the column add. Keeping them in one migration guarantees ordering (column exists
  before backfill writes to it) and that any environment reaching this migration
  gets both. This mirrors how `20260608_historical_data_import` co-locates DDL and
  notes (though that one moved data via seed CSVs; here the data is already
  present, so the backfill is pure in-place `UPDATE`).
- **Why ride `migrate-with-ntfy.mjs`:** it is already the deploy entrypoint
  (replaces the bare `prisma migrate deploy` in `docker-compose.yml`'s `migrate`
  service). It snapshots `_prisma_migrations` before/after and publishes one
  `default`-priority ntfy event per newly-applied migration to topic
  `dr3-vision-system` (ADR-0036/0037). No change to the wrapper is needed — the
  new migration is picked up automatically and will emit
  `[DR3-Vision] Migration applied 20260615_bonus_employee_number`. The publish is
  fail-soft and never affects the migrate exit code.
- **Idempotency strategy:** every DDL statement uses `IF NOT EXISTS`; the backfill
  `UPDATE` is guarded so it only touches rows that still match the trailing-number
  pattern AND do not yet have `employee_number` set, so a re-run is a no-op. See
  §5 for the exact SQL and §5.3 for the idempotency argument.

---

## 4. Exact schema change (`prisma/schema.prisma`)

### 4.1 Model edit

In `model BonusEmployee` (currently lines 661–686), add `employee_number` and the
new index. The edited model:

```prisma
model BonusEmployee {
  id      String @id @default(uuid())
  site_id String
  site    Site   @relation(fields: [site_id], references: [id])

  // Display name — see ADR-0019 §9b for retroactive display behavior
  full_name      String
  previous_names Json? // [{ name: "...", changed_at: "..." }, ...]

  // Legacy roster employee number extracted from full_name (ADR-0026).
  // Nullable: only the 21 imported DR3 Woodland legacy rows carry one;
  // production-created processors have none. Uniqueness is enforced
  // per-site at the application layer, NOT in the DB — see ADR-0026.
  employee_number String?

  is_active Boolean @default(true)

  // Optional link to a system user — most processors are NOT system users
  user_id String?
  user    User?   @relation("BonusEmployeeUser", fields: [user_id], references: [id])

  notes      String?
  created_at DateTime  @default(now())
  updated_at DateTime  @updatedAt
  deleted_at DateTime? // soft delete; rehire reactivates per ADR-0019 §9a

  daily_entries BonusDailyEntry[]
  aliases       BonusEmployeeAlias[]

  @@index([site_id, is_active])
  @@index([site_id, employee_number])
  @@map("bonus_employees")
}
```

Only two lines are added inside the model body (the `employee_number` field + its
comment) plus one `@@index` line. Do not reorder existing fields.

### 4.2 Index choice

`@@index([site_id, employee_number])` — a plain non-unique btree index. Supports
the future lookup pattern "find the processor with number N at site S" and
"list numbered processors at site S". It is **not** unique (see §4.3). Rows with
`employee_number IS NULL` are still indexed but don't interfere.

### 4.3 Why per-site uniqueness is app-level, NOT a DB unique constraint

A DB `@@unique([site_id, employee_number])` would be wrong for three concrete
reasons grounded in the live data and the model's own semantics:

1. **Soft deletes break global uniqueness.** `BonusEmployee` is soft-deleted
   (`deleted_at`), and ADR-0019 §9a allows rehire to reactivate. One of the 21 is
   already soft-deleted. If a soft-deleted row holds number `9071` and the person
   is rehired into a fresh row (rather than reactivated) with the same number, a
   DB unique constraint on `(site_id, employee_number)` would reject the rehire
   even though the old row is logically gone. App-level validation can scope the
   check to non-deleted rows; a partial unique index could too, but see point 3.
2. **NULLs are the common case (86 of 107).** A unique constraint permits multiple
   NULLs in Postgres, so it wouldn't break the unnumbered rows — but it offers no
   value for them either, and it advertises a guarantee the domain doesn't
   actually want enforced rigidly at the storage layer.
3. **The numbers are externally-owned legacy identifiers, not ours to police.**
   These came off a legacy Woodland roster. We do not control their allocation,
   we don't yet know if a future site could legitimately reuse a number, and we
   have no requirement to reject a collision at write time with a hard DB error
   (which would surface as an opaque 500). App-level validation lets us return a
   friendly, scoped error and lets an admin override if the legacy data demands
   it. This matches how the codebase already treats `BonusEmployeeAlias`
   (uniqueness scoped via `@@unique([variant_name, canonical_employee_id])` is a
   relational guard, not an identity guard).

**App-level rule to implement** (lightweight, additive — not behavior-changing for
existing flows since no current flow writes `employee_number`): when a create/edit
path eventually sets `employee_number`, reject if another **non-deleted** row in
the same `site_id` already has that `employee_number`. Today no such write path
exists, so this is a validation helper + a TODO marker, not a wired-in check. See
§6 blast-radius for where this would attach when a write path is added.

---

## 5. Exact backfill SQL (`prisma/migrations/20260615_bonus_employee_number/migration.sql`)

Create the directory and write this file verbatim:

```sql
-- DR3-Vision — Extract legacy employee numbers from bonus_employees.full_name (ADR-0026)
-- Migration: 20260615_bonus_employee_number
--
-- Context (verified against production 2026-06-15):
--   * 107 bonus_employees rows total.
--   * Exactly 21 rows (all site "DR3 Woodland") have a legacy employee number
--     appended to the display name as "<name> <4 digits>", e.g. "Jane Doe 9071".
--   * The pattern is uniform: a single space then exactly four ASCII digits at
--     the END of full_name. No 3/5-digit variance, no leading zeros, no embedded
--     numbers. All 21 extracted numbers are distinct.
--   * 1 of the 21 is soft-deleted/inactive and MUST still be backfilled.
--   * All 21 already have previous_names populated -> we APPEND, never overwrite.
--   * users.name is clean (0 digit-bearing rows) and is NOT touched here.
--
-- This migration is pure additive DDL + a one-time in-place backfill. It is fully
-- idempotent (IF NOT EXISTS DDL; pattern-and-null-guarded UPDATE). See ADR-0026.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Add the column (nullable; production rows have no number).
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE "bonus_employees"
  ADD COLUMN IF NOT EXISTS "employee_number" TEXT;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Non-unique lookup index. Per-site uniqueness is enforced at the
--    application layer, NOT here (soft-delete + rehire + external legacy
--    ownership of the numbers -- see ADR-0026).
-- ─────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "bonus_employees_site_id_employee_number_idx"
  ON "bonus_employees" ("site_id", "employee_number");

-- ─────────────────────────────────────────────────────────────────────
-- 3. Provenance: append a "name_normalized" entry to previous_names for
--    every row we are about to modify, recording the pre-strip full_name.
--    Runs BEFORE the strip so the recorded value still contains the number.
--    Guarded by employee_number IS NULL so a re-run does not append twice
--    (step 4 sets employee_number, so on re-run this WHERE is empty).
--    COALESCE handles the (non-occurring today) case of a NULL previous_names.
-- ─────────────────────────────────────────────────────────────────────
UPDATE "bonus_employees"
SET "previous_names" = COALESCE("previous_names", '[]'::jsonb)
    || jsonb_build_array(
         jsonb_build_object(
           'name', "full_name",
           'changed_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'reason', 'employee_number_extracted',
           'migration', '20260615_bonus_employee_number'
         )
       )
WHERE "full_name" ~ ' [0-9]{4}$'
  AND "employee_number" IS NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 4. Extract the number into employee_number, then strip it (and any
--    surrounding whitespace) out of full_name. Non-matching rows and rows
--    already backfilled (employee_number IS NOT NULL) are skipped.
-- ─────────────────────────────────────────────────────────────────────
UPDATE "bonus_employees"
SET "employee_number" = substring("full_name" from ' ([0-9]{4})$'),
    "full_name"       = btrim(regexp_replace("full_name", ' [0-9]{4}$', ''))
WHERE "full_name" ~ ' [0-9]{4}$'
  AND "employee_number" IS NULL;
```

> NOTE on JSONB cast: `previous_names` is declared `Json?` in Prisma. In Postgres
> Prisma maps `Json` to `jsonb`. The `COALESCE(..., '[]'::jsonb)` and `||`
> concatenation operate on `jsonb`. If for any reason the live column is `json`
> (not `jsonb`), the `||` operator does not exist for `json` — re-verify the
> column type with the recipe in §1.1 (`SELECT data_type FROM
information_schema.columns WHERE table_name='bonus_employees' AND
column_name='previous_names';`) before applying. Expected: `jsonb`. If it is
> `json`, change the two casts to `::jsonb` on the column read as well:
> `COALESCE("previous_names"::jsonb, '[]'::jsonb)`.

### 5.1 Ordering rationale (why step 3 before step 4)

The provenance `UPDATE` (step 3) must run **before** the strip (step 4) because it
records the pre-strip `full_name` (the value _with_ the number). Both steps share
the same `WHERE full_name ~ ' [0-9]{4}$' AND employee_number IS NULL` guard, so on
a first run they touch the identical 21 rows in the right order. After step 4 sets
`employee_number`, the guard is empty for both steps on any subsequent run.

### 5.2 Why `btrim` after `regexp_replace`

The regex ` [0-9]{4}$` already consumes the single separating space, so
`regexp_replace` alone yields the clean name. `btrim()` is a defensive belt-and-
suspenders against any double-space or trailing-space anomaly in legacy data
(none observed in the 21, but cheap insurance). It does not alter correct rows.

### 5.3 Idempotency argument

- **DDL (steps 1–2):** `ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`
  are no-ops on re-run.
- **Backfill (steps 3–4):** both are guarded by `employee_number IS NULL`. After a
  successful first run, all 21 target rows have a non-null `employee_number`, so
  the `WHERE` matches zero rows on any re-run. The strip is also self-guarding —
  once stripped, `full_name` no longer matches ` [0-9]{4}$`. Either guard alone
  would suffice; together they are robust to a half-applied state (e.g. if step 3
  ran but step 4 didn't, the `employee_number IS NULL` guard still lets step 4
  complete and step 3 won't double-append because... — careful: see edge note).

**Edge note for the half-applied case:** if step 3 committed but step 4 did not
(e.g. process killed between statements — note Prisma wraps a single
`migration.sql` in one transaction by default, so this is unlikely), a manual
re-run of step 3 alone would double-append because `employee_number` is still
NULL. Because Prisma runs the whole `migration.sql` in a transaction, steps 3 and
4 commit atomically — partial application is not a real risk here. Do not split
this migration into multiple files.

---

## 6. Provenance approach + optional formal-audit variant

### 6.1 Chosen approach (in the migration above)

Append to the existing `previous_names` JSON array a structured entry:

```json
{
  "name": "Jane Doe 9071",
  "changed_at": "2026-06-15T...Z",
  "reason": "employee_number_extracted",
  "migration": "20260615_bonus_employee_number"
}
```

This rides the field's existing shape (`[{ name, changed_at }, ...]` per ADR-0019
§9b) and adds two extra keys (`reason`, `migration`) that existing readers ignore.
It is self-contained, requires no new table, and means the original
number-bearing display string is never lost — anyone can reconstruct
`full_name + ' ' + employee_number` and confirm it equals the recorded
`previous_names` entry.

### 6.2 Optional formal-audit variant (only if Bill wants a hard audit trail)

If a stronger, queryable audit record is desired, the system already has an
`AuditLog` model (ADR-0007) and an audit-log viewer (ADR-0018). The variant: in
addition to (or instead of) the `previous_names` append, insert one `audit_logs`
row per modified employee with action `bonus_employee.number_extracted`, the
`before`/`after` `full_name`, and the extracted number. This is **not** in the
default plan because:

- The migration runs as the `migrate` service identity with no actor/operator
  context, so the audit row would have a synthetic `system`/`migration` actor —
  which the audit viewer (ADR-0018) may not render cleanly.
- `previous_names` already preserves the reversible record at the row level.

Decision: ship §6.1 only. If Bill requests the audit-log variant during review,
it is a small additive `INSERT ... SELECT` appended to `migration.sql` — but
confirm the `audit_logs` actor/nullable-actor contract first (read
`docs/adr/0007-audit-log.md` and `docs/adr/0018-audit-log-viewer.md`). Logged as
QUESTIONS Q-N (§10.3).

---

## 7. Verification (run after applying — REQUIRED)

Run via the recipe in §1.1. Expected results annotated.

```sql
-- (a) Exactly 21 extracted, 0 names still carry a trailing number.
SELECT
  count(*) FILTER (WHERE employee_number IS NOT NULL)            AS extracted,          -- expect 21
  count(*) FILTER (WHERE full_name ~ ' [0-9]{4}$')               AS name_still_numbered, -- expect 0
  count(*)                                                       AS total_rows          -- expect 107
FROM bonus_employees;

-- (b) Every extracted number is exactly 4 digits, no whitespace leaked.
SELECT count(*) AS bad_number_format
FROM bonus_employees
WHERE employee_number IS NOT NULL
  AND employee_number !~ '^[0-9]{4}$';                                                  -- expect 0

-- (c) No extracted name has leading/trailing whitespace.
SELECT count(*) AS bad_whitespace
FROM bonus_employees
WHERE employee_number IS NOT NULL
  AND full_name <> btrim(full_name);                                                    -- expect 0

-- (d) Per-site uniqueness holds among non-deleted rows (sanity, not enforced in DB).
SELECT site_id, employee_number, count(*)
FROM bonus_employees
WHERE employee_number IS NOT NULL AND deleted_at IS NULL
GROUP BY site_id, employee_number
HAVING count(*) > 1;                                                                    -- expect 0 rows

-- (e) Provenance landed: all 21 have a 'employee_number_extracted' entry.
SELECT count(*) AS rows_with_provenance
FROM bonus_employees
WHERE employee_number IS NOT NULL
  AND previous_names::jsonb @> '[{"reason":"employee_number_extracted"}]'::jsonb;        -- expect 21

-- (f) The soft-deleted numbered row was backfilled too.
SELECT count(*) AS soft_deleted_backfilled
FROM bonus_employees
WHERE employee_number IS NOT NULL AND deleted_at IS NOT NULL;                            -- expect >= 1
```

**Pass criteria:** (a) `extracted=21`, `name_still_numbered=0`, `total_rows=107`;
(b) `0`; (c) `0`; (d) `0 rows`; (e) `21`; (f) `>=1`.

Also verify the deploy wrapper emitted the ntfy event (optional): one
`[DR3-Vision] Migration applied 20260615_bonus_employee_number` on topic
`dr3-vision-system`.

---

## 8. Blast-radius analysis (files / lines)

The change is additive at the schema level and behavior-neutral at runtime. Every
consumer of `full_name` continues to work — it just no longer renders the trailing
number for the 21 rows (which is the desired outcome). Audit the following before
declaring done:

| Area                 | File(s)                                                                         | What to check                                                                                                                                                   | Expected impact                                    |
| -------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Schema               | `prisma/schema.prisma` (model `BonusEmployee`, lines 661–686)                   | Add `employee_number String?` + `@@index([site_id, employee_number])` (§4.1)                                                                                    | Required edit                                      |
| Migration            | `prisma/migrations/20260615_bonus_employee_number/migration.sql` (new)          | Create per §5                                                                                                                                                   | New file                                           |
| Migration lock       | `prisma/migrations/migration_lock.toml`                                         | provider already `postgresql` — no edit                                                                                                                         | None                                               |
| Deploy wrapper       | `scripts/migrate-with-ntfy.mjs`                                                 | Picks up new migration automatically; emits ntfy                                                                                                                | No edit needed                                     |
| Seed                 | `prisma/seed.mjs`, `prisma/seed/`                                               | If seed inserts `bonus_employees` with numbered `full_name`, the seed names should be cleaned + `employee_number` set so a fresh DB matches prod post-migration | Audit; edit only if seed carries numbered names    |
| Display-name reads   | grep `full_name` across `src/`                                                  | UI/PDF/email that renders `be.full_name` will now show the clean name (no number) — this is intended                                                            | Behavior-neutral / intended                        |
| Bonus PDF            | `src/**` payroll PDF generation + `scripts/generate-historical-pdfs.mjs`        | Confirm none parse the number out of `full_name` (they shouldn't — keyed by `bonus_employee_id` per the reachability note)                                      | Verify, expect none                                |
| Reconciliation       | MyMRC matching (`docs/MYMRC-INTEGRATION.md`, `scripts/mymrc-*.mjs`)             | MyMRC matches on `sources.name`/`transporters.name`, NOT employee names — so unaffected                                                                         | None                                               |
| Alias resolver       | `BonusEmployeeAlias` consumers                                                  | Aliases match `variant_name`; if any alias variant was the numbered string, it would now mismatch the clean `full_name`                                         | Grep alias seed/data for ` [0-9]{4}$`; expect none |
| App-level uniqueness | future bonus-employee create/edit handler (none writes `employee_number` today) | Add validation helper + TODO per §4.3 when a write path is introduced                                                                                           | Deferred; not wired now                            |
| Tests                | `vitest.config.ts` scope; any test asserting a numbered `full_name`             | Update fixtures asserting `"... 9071"` to the clean name + `employee_number`                                                                                    | Audit; edit if present                             |

**Concrete grep commands for the implementer:**

```bash
cd /home/bbarnard065/DR3-Vision
grep -rn "full_name" src/ scripts/ prisma/seed.mjs | grep -v node_modules
grep -rn "employee_number" src/ prisma/ | grep -v node_modules   # expect none pre-change
grep -rn " [0-9]\{4\}" prisma/seed.mjs prisma/seed/ 2>/dev/null   # numbered names in seed?
```

If `grep -rn "full_name"` reveals a path that _parses a number out of_ `full_name`
(rather than just displaying it), STOP and log a QUESTIONS entry — that path would
break and needs the column instead.

---

## 9. Rollback procedure

The migration is reversible because `previous_names` preserves the original
number-bearing display string. Prisma has no auto-down migrations, so rollback is
a manual forward-fix migration (preferred) or a direct SQL reversal (emergency).

### 9.1 Forward-fix migration (preferred, leaves history intact)

Create `prisma/migrations/20260616_revert_bonus_employee_number/migration.sql`:

```sql
-- Reverts 20260615_bonus_employee_number: restores numbered full_name from
-- previous_names provenance and drops the column/index. Idempotent.

-- 1. Restore full_name from the recorded pre-strip name for rows we modified.
UPDATE "bonus_employees" be
SET "full_name" = (
  SELECT elem ->> 'name'
  FROM jsonb_array_elements(be."previous_names"::jsonb) AS elem
  WHERE elem ->> 'reason' = 'employee_number_extracted'
  ORDER BY elem ->> 'changed_at' DESC
  LIMIT 1
)
WHERE be."employee_number" IS NOT NULL
  AND be."previous_names"::jsonb @> '[{"reason":"employee_number_extracted"}]'::jsonb;

-- 2. (Optional) prune the provenance entry we added. Usually keep it for history.
--    Left commented intentionally.

-- 3. Drop index + column.
DROP INDEX IF EXISTS "bonus_employees_site_id_employee_number_idx";
ALTER TABLE "bonus_employees" DROP COLUMN IF EXISTS "employee_number";
```

Then revert the `schema.prisma` edit (remove the field + index) so the schema
matches.

### 9.2 Emergency direct SQL (no new migration; only if prod is on fire)

Run §9.1 steps 1 + 3 directly via the §1.1 recipe inside a transaction:

```sql
BEGIN;
-- (paste steps 1 and 3 from 9.1)
COMMIT;   -- or ROLLBACK to abort
```

Note this leaves `_prisma_migrations` thinking `20260615_...` is applied while the
column is gone — only acceptable as a stopgap; follow up with §9.1 to reconcile.

### 9.3 Rollback verification

```sql
SELECT count(*) FILTER (WHERE full_name ~ ' [0-9]{4}$') AS restored_numbered  -- expect 21
FROM bonus_employees;
SELECT count(*) FROM information_schema.columns
WHERE table_name='bonus_employees' AND column_name='employee_number';          -- expect 0
```

---

## 10. Documentation deltas (land in the SAME commit)

### 10.1 ADR-0026 stub — write to `docs/adr/0026-bonus-employee-number-extraction.md`

```markdown
# ADR-0026: Extract legacy employee numbers from bonus_employees.full_name

**Date:** 2026-06-15
**Status:** Accepted
**Extends:** ADR-0019 (Bonus Management), ADR-0019.2 (Eugene enablement), ADR-0023 (Historical import)

## Context

The legacy DR3 Woodland roster carried each processor's employee number appended
to the display name as "Firstname Lastname 6317". This landed verbatim in
`bonus_employees.full_name` during the historical import (ADR-0023). Verified
against production 2026-06-15: 21 of 107 `bonus_employees` rows (all "DR3
Woodland") match the uniform pattern ` [0-9]{4}$` — a single space then exactly
four digits at the end. No width variance, no leading zeros, no embedded numbers;
all 21 numbers distinct; one row soft-deleted; all 21 already carry
`previous_names`. The operator `users` table is clean (0 numbered rows). Mixing
the identifier into the display name pollutes every UI/PDF/email render and blocks
ever keying on the number.

## Decision

Add a nullable `employee_number TEXT` column to `bonus_employees` with a
non-unique `(site_id, employee_number)` index. Backfill it from the trailing
4-digit token via a single idempotent migration (`20260615_bonus_employee_number`)
that also strips the token from `full_name` and appends a provenance entry to
`previous_names` (`reason: employee_number_extracted`). Per-site uniqueness of the
number is enforced at the **application layer among non-deleted rows**, not by a
DB unique constraint.

## Alternatives considered

- **DB unique constraint `(site_id, employee_number)`** — rejected: soft-delete +
  rehire (ADR-0019 §9a) can legitimately collide; the numbers are externally-owned
  legacy identifiers we don't allocate; a hard DB error surfaces as an opaque 500.
- **Keep the number in full_name, parse on read** — rejected: pollutes every
  render and re-parses fragile string state on every read.
- **One-off script instead of a migration** — rejected: the backfill is tightly
  coupled to the column add; co-locating in one migration guarantees ordering and
  reproducibility on any environment (incl. a fresh DB via seed reconciliation).
- **Separate audit_logs rows for the rename** — deferred (see ADR §Consequences):
  the migration has no operator actor context; `previous_names` already preserves
  the reversible record.

## Consequences

- The 21 numbered display names become clean; `employee_number` is available for
  future surfacing (no UI consumes it yet — additive, behavior-neutral).
- Rollback is possible by restoring `full_name` from `previous_names`.
- A future bonus-employee write path must add the app-level per-site uniqueness
  check (scoped to `deleted_at IS NULL`).
- The migration is idempotent and safe to re-run.

## Cross-reference

Charter: Bonus Management System (ADR-0019 family). Data ground-truth and full
build spec: `docs/plans/2026-06-15-bonus-employee-number-extraction.md`.
```

Also add this row to the index table in `docs/adr/README.md` (after the 0025 row):

```
| 0026   | Extract legacy employee numbers from `bonus_employees.full_name` (extends 0019, 0023)                        | Accepted                                                        |
```

### 10.2 CHANGELOG entry — prepend under the current `Unreleased`/dated section in `CHANGELOG.md`

```markdown
### Added

- **Bonus: `employee_number` on processors (ADR-0026).** New nullable
  `bonus_employees.employee_number` column + `(site_id, employee_number)` index.
  Migration `20260615_bonus_employee_number` backfills the 21 legacy DR3 Woodland
  rows whose display name carried a trailing 4-digit employee number, strips the
  number out of `full_name`, and records the original name in `previous_names`
  (`reason: employee_number_extracted`). Idempotent; behavior-neutral (no UI
  consumes the column yet). Per-site uniqueness enforced at the app layer, not the
  DB. Verified against production 2026-06-15 (21/107 rows; one soft-deleted row
  included).
```

(Match the existing CHANGELOG's section style — the repo uses Keep-a-Changelog-ish
`### Added/Changed/Fixed` groupings; place under the appropriate dated heading.)

### 10.3 QUESTIONS.md entry — append above the sentinel line in `docs/QUESTIONS.md`

```markdown
## Q-N: Should the employee-number extraction also write formal audit_logs rows, or is the previous_names provenance entry sufficient?

**Date:** 2026-06-15
**Encountered in:** docs/plans/2026-06-15-bonus-employee-number-extraction.md (§6); prisma/migrations/20260615_bonus_employee_number/migration.sql
**Question:** The migration records each rename in `bonus_employees.previous_names` (reason `employee_number_extracted`). Do we also want an `audit_logs` row per change (ADR-0007/0018) for a queryable, viewer-visible trail? The migration runs without an operator actor, so any audit row would carry a synthetic `system`/`migration` actor that the ADR-0018 viewer may not render cleanly.
**Alternatives considered:** (a) previous_names only — reversible, self-contained, no actor problem [chosen]; (b) previous_names + audit_logs INSERT...SELECT — stronger trail but synthetic actor; (c) audit_logs only — loses the row-level reversible record.
**Proposed answer:** Ship (a). Add (b) only if Bill wants a viewer-visible audit trail and after confirming the audit_logs nullable/synthetic-actor contract.
**Resolution:** Pending Bill review.
```

(Replace `Q-N` with the next sequential number when appending — the template's last
real entry is Q-1, so this is likely Q-2.)

---

## 11. Implementation checklist (for Aegis)

1. [ ] (Optional) Re-verify ground-truth via §1.1 recipe + §1.2 queries.
2. [ ] Confirm `previous_names` column type is `jsonb` (see §5 NOTE); adjust casts if `json`.
3. [ ] Edit `prisma/schema.prisma` `BonusEmployee` per §4.1 (field + `@@index`).
4. [ ] Create `prisma/migrations/20260615_bonus_employee_number/migration.sql` per §5.
5. [ ] Run blast-radius greps (§8); resolve/seed-audit any numbered `full_name` in seed or tests; STOP+log if any path parses numbers from `full_name`.
6. [ ] Apply via the deploy path (`migrate-with-ntfy.mjs` / compose `migrate` service) — do NOT run a bare `prisma db push`.
7. [ ] Run verification queries (§7); confirm all pass criteria.
8. [ ] Write ADR-0026 (§10.1) + add README index row.
9. [ ] Add CHANGELOG entry (§10.2).
10. [ ] Append QUESTIONS Q-N (§10.3).
11. [ ] Commit schema + migration + docs together (Documentation Discipline — one commit).

```

```
