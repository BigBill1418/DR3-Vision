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
