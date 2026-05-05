# ADR-0007: Audit log design & retention

**Date:** 2026-05-04
**Status:** Accepted

## Context

DR3-Vision feeds billing (~$7M annual revenue) and compliance with two MRC contracts in different jurisdictions. Every record can become evidence in:
- MRC reconciliation disputes ("did this haul come on the 4th or 5th?")
- CalRecycle and Oregon DEQ audits ("show me the chain of custody for these mattresses")
- SVdP internal financial audits
- Termination dispute (if either contract were ever terminated, we'd need the full record)

A single tampering event — a count edited after submission, a photo deleted, an operator attribution swapped — could compromise all of this. We need a tamper-evident record of every state change.

## Decision

Implement an **append-only audit log table** that records every mutation across the application.

### Schema
```
audit_log
  id              uuid PK
  actor_user_id   uuid FK users.id (nullable for system actors like the Playwright job)
  actor_label     string (e.g., 'system:mymrc-scrape', 'system:r2-purge') for non-user actors
  action          enum (insert, update, delete, soft_delete, restore)
  table_name      string
  row_id          string (the affected row's primary key as a string)
  before          jsonb (the row's state before the change; null for inserts)
  after           jsonb (the row's state after the change; null for deletes)
  ip              inet (client IP for user actions; null for system actions)
  user_agent      string (client UA for user actions; null for system actions)
  created_at      timestamptz default now()
```

### Implementation
- Prisma middleware intercepts every mutation and writes an audit row before returning
- The middleware runs in the same transaction as the mutation, so audit-write failure rolls back the mutation
- For batch operations, each row gets its own audit entry

### Retention
**Indefinite. No pruning.** The audit log lives forever.

This is independent of the photo/load record retention rules (CA 4yr / OR 5yr); those apply to the *evidentiary* records. The *audit* record is organizational accountability and grows much more slowly (~500K rows/year at peak).

### Query patterns
- "Who modified load X and when?" — `WHERE table_name = 'inbound_loads' AND row_id = 'X' ORDER BY created_at`
- "What did Bill do today?" — `WHERE actor_user_id = bill.id AND created_at >= today`
- "Find all soft-deletes in the last 7 days" — `WHERE action = 'soft_delete' AND created_at >= now() - interval '7 days'`

### UI
- Admin-only audit viewer at `/admin/audit`
- Filterable by actor, table, date range, action
- Append-only display: no edit/delete UI ever exists

## Alternatives considered

- **Postgres temporal tables (system-versioned)** — would automate before/after capture but Postgres doesn't natively support them; would require an extension and complicate migrations
- **External audit service (e.g., Datadog audit log)** — adds external dependency, latency, and a per-row cost
- **Pruning audit log after some interval** — defeats the purpose of organizational accountability; storage cost is trivial
- **Logging-only (no DB table)** — logs are not queryable for the use cases above

## Consequences

- Every code path that mutates data must use Prisma. Raw SQL outside reviewed migrations is forbidden because it bypasses the audit middleware.
- The audit table is the largest table by row count over time. Indexes on `(table_name, row_id)`, `(actor_user_id, created_at)`, and `(action, created_at)` are required.
- The audit log is part of every backup. A restored database has full audit history.
- Photos are *not* logged in audit (their bytes would balloon the JSONB columns); the `load_photos` row mutation is logged, including the storage_key and metadata.

## References

- Charter §5.1 (Security), §5.3 (Audit & retention), §6 (Schema)
- Q23 in charter v0.30 changelog (indefinite retention)
- ADR-0005 (Photo storage; photo retention is separate)
