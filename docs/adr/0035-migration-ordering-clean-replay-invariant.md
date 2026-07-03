# ADR-0035 — Migration ordering & the clean-replay invariant

**Status:** Accepted (Sprint 6, 2026-06-23)
**Related:** ADR-0028 (amendment workflow — created `bonus_amendment_requests`), ADR-0029 (amendment notification batching — added `submission_group_id`); enforced by the new `migrations` CI job (`.github/workflows/ci.yml`).

## Context

`prisma migrate deploy` replays the directories under `prisma/migrations/` in **lexical (byte) order of their directory names** — not in the order they were authored or historically applied. On disk we had two same-day migrations whose names sorted the _opposite_ of their true dependency order:

- `20260616_amendment_workflow/` — **CREATEs** table `bonus_amendment_requests` (ADR-0028).
- `20260616_amendment_submission_group/` — **ALTERs** `bonus_amendment_requests` to add `submission_group_id` (ADR-0029).

Lexically, `submission_group` < `workflow`, so `migrate deploy` ran the ALTER **first**:

```
Applying migration `20260616_amendment_submission_group`
Error: P3018 … 42P01 … relation "bonus_amendment_requests" does not exist
```

The **live** DB (svdp-dev) was never affected: it applied the migrations interactively in the correct order (`_amendment_workflow` finished 2026-06-15 21:51:29, then `_amendment_submission_group` finished 2026-06-16 01:39:36 — verified from `_prisma_migrations.finished_at`). The bug is latent: it only bites a **clean / DR replay** against an empty database. The new `migrations` CI job — which replays every migration against a fresh Postgres 16 — is exactly what surfaced it.

This is the same _class_ as the survey-migration `users.id` TEXT-vs-UUID hotfix (`4d42bb05`): SQL that is individually valid but only works against an already-populated or correctly-ordered schema, and so passes locally but fails a clean replay.

## Decision

**Invariant:** the on-disk migration set must apply cleanly, in lexical directory order, to an **empty** database. Every migration's prerequisites (tables, types, columns it references) must be created by a migration whose directory name sorts **before** it.

**Fix applied:** renamed the directory only — the `migration.sql` is byte-identical (checksum unchanged):

```
20260616_amendment_submission_group  →  20260616_amendment_workflow_submission_group
```

This name stays in the same `20260616` date slot and provably sorts **after** `20260616_amendment_workflow` and **before** `20260617_daily_production_report`:

```
20260616_amendment_workflow
20260616_amendment_workflow_submission_group
20260617_daily_production_report
```

(Note: a full-timestamp form like `20260616120000_…` does **not** work — the digit `1` sorts _before_ the underscore `_` in byte order, so it would land ahead of `20260616_amendment_workflow`. The `_workflow_submission_group` form was chosen because it both sorts correctly and makes the dependency self-documenting: "the submission-group extension of the workflow table.") The SQL was already idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), which makes the live re-apply harmless.

## Live ledger reconciliation (REQUIRED before the next deploy of this branch)

The live `_prisma_migrations` ledger still records the **old** directory name. After this rename, the recorded migration no longer matches any directory on disk, and the new directory is not in the ledger. On the next `migrate deploy` (the deployer runs it as a one-shot init container each deploy), Prisma would treat the renamed directory as a brand-new migration and **re-apply** it. Because the SQL is `IF NOT EXISTS`, that is data-safe — but it writes a **duplicate ledger row** and leaves `migrate status` warning about a recorded-but-missing migration. Avoid that confusion with a single, pure-rename UPDATE of the ledger row (no schema change, no data change):

```sql
-- Run ONCE against the LIVE dr3_vision DB, BEFORE the next deploy of this branch.
UPDATE _prisma_migrations
   SET migration_name = '20260616_amendment_workflow_submission_group'
 WHERE migration_name = '20260616_amendment_submission_group';
-- Expect: UPDATE 1  (verified: exactly one matching row on 2026-06-23).
```

Sequencing: apply the ledger UPDATE during a maintenance window **before** this branch deploys. If the deploy runs first, the only consequence is a duplicate ledger row + a `migrate status` warning (no data impact) — but run the UPDATE to keep the ledger clean.

## Enforcement

The `migrations` CI job (`.github/workflows/ci.yml`, "prisma migrate deploy (clean DB)") replays all migrations against a fresh Postgres 16 service container and asserts `migrate status` is up to date. Any future ALTER-before-CREATE, checksum drift, or order-dependent SQL fails **there**, in CI, instead of on a clean/DR deploy. That job is now the gate for this invariant.

## Known follow-up (out of scope for this ADR)

The CI job's third step — `migrate diff --exit-code` (schema.prisma vs the migrated clean DB) — currently reports **pre-existing** drift unrelated to this rename. It is almost entirely cosmetic: Prisma wants to rename hand-authored constraint/index names to its `*_fkey` / `*_key` convention, plus a few benign structural items (a couple of `import_session_id` FKs/indexes, `bonus_pay_periods` nullable→required tightening, default drops). This drift is reproducible order-independently (`migrate diff --from-migrations … --to-schema-datamodel`) and existed before this change. It should be reconciled in a dedicated migration (or the schema annotations aligned) so the drift step can be a hard gate; until then it should not mask the ordering gate above. Tracked as a separate hardening item — **no payroll/signature data semantics are involved.**
