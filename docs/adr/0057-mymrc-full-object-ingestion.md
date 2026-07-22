# ADR-0057 — MyMRC full-object ingestion via admin user credentials

**Status:** Accepted (2026-07-21)
**Date:** 2026-07-21
**Relates to:** ADR-0009 (initial Playwright decision), ADR-0038 (mirror-tables + Aura interception rebuild), ADR-0039 (3-way audit), rollup §S-4/S-5/S-6/S-7 (canonical name reconciliation gap)
**Series:** extends ADR-0038 to N objects + single admin-user auth model; retires never-honored service-account pattern

## Context

ADR-0009 (2026-05-04) and ADR-0038 (2026-07-03) built a production-grade Playwright + Aura-interception pipeline for MyMRC. Three list feeds (`Haul_Request__c`, `Materials__c` Processing, `Materials__c` Outbound), three mirror tables, run ledger, typed error surface, hourly cron container. All merged, all deployed to prod.

**The 2026-07-21 planning session revealed a foundational gap that reframes the entire integration:**

Vision has never pulled a single record from MyMRC. Not one. The DR3 Woodland + DR3 Eugene service accounts referenced in `docs/operator/mymrc-setup.md` were never created. The `mymrc-scrape` container has been running its fail-soft path since deployment — logging `creds not configured, skipping` and exiting 0 every hour. All three mirror tables are empty. The `mymrc_sync_runs` ledger has no rows. Zero pulls.

The elegant silent-failure elimination architecture in ADR-0038 (typed errors, zero-anomaly detection, run ledger) has never actually executed against live Salesforce data. It's aspirational until first contact.

Bill's 2026-07-21 directive resolves this at higher scope than the original ADR-0038 charter:

1. Bill's admin user credentials become the sole path (no service accounts, no fallback)
2. Every Salesforce object accessible to that account gets mirrored, not just the three list feeds
3. Full historical backfill on every object
4. No auto-updates to operational tables — every MyMRC-sourced change gates through an admin reconciliation queue
5. No MFA on Bill's account, so plain Playwright login works

This ADR retires the never-honored service-account pattern, converts ADR-0038's 3-mirror architecture to N-mirror discovery-driven, and establishes the reconciliation queue as the canonical write gate.

## Decisions

### D1 — Auth mode: single admin-user context, retire per-site pattern

`MYMRC_MODE` config flag is not introduced — there's only one mode. `MYMRC_ADMIN_USERNAME` + `MYMRC_ADMIN_PASSWORD` env vars are the sole auth. Old `MYMRC_WOODLAND_*` / `MYMRC_EUGENE_*` variable handling deleted from `mymrc-scrape.mjs`, `docker-compose.yml`, `docs/operator/mymrc-setup.md`, and any related fixtures/tests — they were never honored and existed only as unhonored fallbacks. Storage state persisted at `~/.dr3-vision/mymrc-admin/auth.json`. Site scoping happens on the data (records carry `Recycler__c` = "DR3 Woodland" or "DR3 Eugene"), not on the login identity.

### D2 — Object scope: all accessible objects, discovered dynamically

Rather than statically enumerate mirror tables per object at build time, Phase 0 discovery probes Bill's account and enumerates every accessible Salesforce object (via nav menu inspection + `sObjects/` metadata probe if permitted). Each accessible object gets a mirror table following the ADR-0038 pattern:

```
mymrc_<object>_mirror(
    id,                         -- Vision-side surrogate
    salesforce_record_id,       -- 15/18-char SF id, UNIQUE — upsert key
    external_name,              -- human name (H-####, M-####, etc.) if present
    site_id?,                   -- resolved from Recycler__c on the record (nullable if cross-site)
    payload jsonb,              -- FULL raw RecordRepresentation (ADR-0038 D2 audit-evidence discipline)
    first_seen_at,
    last_seen_at,
    disappeared_at?,
    detail_fetched_at?,
    -- object-specific normalized columns added per mapper
)
```

Discovery-first pattern: the migration for each object's mirror table is generated FROM the discovery output, not hand-authored ahead of time. Prevents guessing at fields that don't exist in the actual instance.

The three existing mirror tables (`mymrc_hauls_mirror`, `mymrc_processed_mirror`, `mymrc_outbound_mirror`) are kept as-is. Schema is correct per ADR-0038 D2; only data was missing.

### D3 — Full historical backfill, cursor-based + resumable

Every accessible object backfills to origin on first activation, including the three existing mirrors (which have never had any data). New table:

```
mymrc_backfill_cursors(
    id,
    object_api_name,            -- e.g., 'Account', 'Haul_Request__c'
    last_page_index,
    last_record_id,
    total_records_estimated?,
    records_completed,
    started_at,
    completed_at?,              -- NULL until backfill finishes
    error?                      -- last-run error text if backfill wedged
)
```

Backfill worker resumes from `(last_page_index, last_record_id)` on restart. Bounded concurrency ≤3 detail fetches (same as ADR-0038 D3). After `completed_at` is set, hourly cadence takes over — cursor is retired for that object.

### D4 — Reconciliation authority: admin-approve queue, no auto-updates

Vision NEVER auto-updates operational tables (`sources`, `source_aliases`, `state_program_rules`, etc.) from MyMRC. Instead, mirror sync writes candidate changes to a queue:

```
mymrc_reconciliation_queue(
    id,
    mirror_table,               -- 'mymrc_accounts_mirror' etc.
    mirror_record_id,           -- FK to the mirror row
    target_table,               -- 'sources' etc. (operational target)
    target_record_id?,          -- existing Vision row if matched
    field_name,                 -- 'name' | 'address' | 'category' | ...
    mymrc_value jsonb,
    vision_value jsonb,
    change_kind,                -- new_record | field_update | disappeared
    status,                     -- pending | approved | rejected | snoozed
    created_at,
    decided_at?,
    decided_by?,
    decision_note?
)
```

Admin surface `/admin/mymrc/reconcile`:
- Pending queue view with filter by mirror_table + change_kind
- Per-item Approve / Reject / Snooze with required note (mirrors AP approval pattern from ADR-0046)
- Bulk approve by class (e.g., "approve all `address` field_updates from `mymrc_accounts_mirror`")
- On Approve → Vision writes the change to the target operational table + `decided_at`/`decided_by` stamped
- Audit log preserves the full pending row even after decision

Auto-detection rules by change_kind:
- `new_record` — record in mirror with no matching Vision entity (name miss both verbatim + alias)
- `field_update` — mirror record's field differs from linked Vision entity
- `disappeared` — mirror row has `disappeared_at`; linked Vision entity may need deactivation

**One notification per sync run, not per queue item.** ntfy `dr3-vision-system` fires once at end of run: "N new pending reconciliations." Bill checks queue in-app.

### D5 — Auth failure: loud + no fallback

Admin login failure = typed `AuthFailedError` + immediate ntfy + `mymrc_sync_runs.status='auth_failed'`. No fallback (no service accounts exist). All ingestion stops until Bill updates the env + restarts the container. Runbook covers rotation.

### D6 — Discovery-first execution pattern

Phase 0 runs before ANY schema is designed for the extended objects. Deliverable: `docs/mymrc-discovery-2026-07-21.md` enumerating what Bill's account can see. Phase 1 mirror schemas are generated from Phase 0 output, not guessed.

The three EXISTING mirror tables stay as-is — they're structurally sound per ADR-0038 (just empty). Phase 1 adds new mirror tables next to them, doesn't rebuild them, and backfills all six (3 existing + 3 new) from origin.

### D7 — Session lifetime: proactive refresh at 90 min

Salesforce Experience Cloud default session TTL is 2 hours. Cron worker tracks session age and proactively re-authenticates at 90 min. Prevents mid-run auth failure. Storage state re-saved on refresh.

### D8 — MRC-side audit trail attribution accepted

All sync activity attributed to Bill's account in MRC's audit logs. Cosmetic. Bill accepted this tradeoff during planning.

### D9 — First-run silent-no-op detection (closes the historical failure mode)

The reason MyMRC ingestion silently produced zero data for months: `mymrc-scrape` startup treats missing credentials as an operator state (skip + exit 0), not a system failure. ADR-0057 changes this posture:

- Container startup asserts BOTH `MYMRC_ADMIN_USERNAME` and `MYMRC_ADMIN_PASSWORD` are set + non-empty.
- If missing: typed `CredentialsNotConfiguredError` + ntfy `dr3-vision-system` alert + exit non-zero.
- Docker healthcheck fails until credentials are set.
- No silent skip path. If Vision can't reach MyMRC, Bill knows within one hourly tick.

This preserves the deploy-before-provision workflow (containers can be up before secrets land) but converts the interim state from invisible to noisy. A future Bill reading the container log after weeks of skipped runs is no longer possible.

## Out of scope

- Write path (Vision → MyMRC updates). Stays out per ADR-0009 pending MRC API access or explicit Playwright-write decision.
- Reconciliation write-back (correcting MyMRC data from Vision). Manual for now.
- Rate limit / throttling analysis — assumed acceptable at hourly cadence + ≤3 concurrent details; monitor `mymrc_sync_runs` for evidence of throttle before revisiting.

## Consequences

- **Silent-failure elimination extends to auth path** (D9 closes the historical recurrence).
- **First-ever pull happens in Phase 0** — this is inaugural contact with production MyMRC data, not a re-probe. Expect edge cases the fixture-based tests never caught (custom formula fields, permission-limited fields, deleted-but-visible records).
- **N mirror tables** instead of 3, one per accessible Salesforce object. Storage grows with `payload jsonb` × record count × object count.
- **Reconciliation queue becomes admin's daily surface** during initial backfill (potentially hundreds of pending items on first-run for `Accounts`). Bulk-approve UI critical.
- **Bill's account is single point of failure** by design; no fallback exists (D5). Password rotation breaks integration until env update.
- **MyMRC-side observes constant polling from Bill's identity** (D8). Cosmetic.
- **Foundation objects unblock S-4/5/6/7 in Phase 1**: canonical names for OR sources flow from `Account` mirror through reconciliation queue to Bill's approval.
- **Kelsey's post-8/8 MRC contact handoff simplifies** — `Contact` mirror captures the roster directly, decoupling the transfer from Kelsey's individual availability.
- **Existing three mirrors get their first data** — hauls, processed, outbound. The operator queue (`expected_loads`) starts seeing MyMRC-scheduled hauls for the first time since the feature shipped.

## Test plan (summary)

- Discovery script CI test: fixture-based (against captured Aura envelopes) to ensure enumeration logic doesn't regress
- Per-object mapper tests with real (redacted) fixtures under `src/lib/mymrc/__fixtures__/<object>/`
- Reconciliation queue write logic: unit tests on change-detection classifier
- Reconciliation admin API: integration tests for Approve/Reject/Snooze + bulk
- Session refresh: unit test on age-based re-auth trigger
- Auth-failed path: fixture + ntfy assertion (no fallback executed)
- First-run silent-no-op detector (D9): env-missing scenario asserts fail-loud + exit non-zero
- Migration clean-replay (CI gate)
