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

#### D3 pagination — CONFIRMED-LIVE mechanism (2026-07-22)

The `getItems` pagination was captured live against `mrc-us.my.site.com` (the transport was NOT guessable, so it was reverse-engineered before implementation — ADR-0057's "never guess the transport" rule). It is OFFSET pagination on the Aura `ListViewDataManagerController.getItems` action:

- **Request params:** `{ filterName:<listViewId>, entityName:<Object__c>, pageSize:50, layoutType:"LIST", sortBy:null, getCount:false, enableRowActions:false, offset:<N> }`. `filterName` is the Salesforce **list-view id** (`00B…`), e.g. Materials "All Active Processed Materials" = `00B4p000005DAqlEAG`, Haul "Docking Appointments (RC)" = `00B4p000005DAqWEAW`.
- **Response scalars:** `{ records:[…≤pageSize], offset:<cumulative-count-fetched>, hasMoreData:<bool>, filterTitle, entityLabelPlural }`.
- **Loop:** start `offset=0`; each response reports a cumulative `offset` + `hasMoreData`; repeat until `hasMoreData:false`. Because a ListView returns exactly `pageSize` rows per page until the last, the request offset for a 0-based page index is the pure function `offset = pageIndex * pageSize` — which is what makes the DB-durable `last_page_index` cursor resumable with no in-memory running offset.

**Implementation (Phase 1 D3):** the request/response codec + the list-view-id resolver are PURE (`src/lib/mymrc/list-page.ts`, unit-tested); `createBackfillPortalClient` (`backfill-portal-client.ts`) drives the offset loop over the shared self-healing admin session (`openAdminSession`), replaying the getItems POST with the **live aura framework envelope the browser itself sent** on the list page (immune to per-release `fwuid` drift) — the offset-replay path (ladder #1), chosen over DOM infinite-scroll for determinism. Multi-view objects (Haul ×2, Materials ×2) page each view as its own cursor and merge deduped by `salesforce_record_id` (the mirror upsert key). One-shot entrypoint: `scripts/mymrc-backfill.mjs`.

**List-view id resolution (never guessed):** precedence is operator override (`MYMRC_LISTVIEW_IDS` env, `{slug:id}`) → runtime capture (the browser's own getItems request on the list page, matched by object + filter title) → the id observed live 2026-07-22. Only 2 of 5 ids were captured live; the other 3 (Consumer Drop-Off, Outbound, Dock) resolve at runtime or via override, and an id that resolves to NONE fails LOUD per-target (a resumable wedge + ntfy), never a wrong/empty list.

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

## Post-acceptance implementation notes — first live run (2026-07-22)

The Phase 0 discovery + scrape code was written against synthetic fixtures and **never run against the live portal until 2026-07-22**. The inaugural run surfaced exactly the first-contact edge cases this ADR's §Consequences warned about. Corrected on branch `fix/mymrc-scrape-live-portal`; `SELECTOR_VERSION` bumped `2026-06-22` → `2026-07-22`.

Real-portal facts (captured live from `https://mrc-us.my.site.com`):

- **Login is by PLACEHOLDER, not id/name.** The Lightning login form fields carry NO `name`, DYNAMIC numeric ids (e.g. `173:0` username, `186:0` password), and are identifiable ONLY by placeholder text ("Username" / "Password"). The submit reads "Log In". The old `input[placeholder="Username"]` + `button:has-text("Log in")` flow filled/submitted nothing and stayed silently logged out. Fix: `page.getByPlaceholder('Username'|'Password').fill(...)` + `page.getByRole('button', { name: /log ?in/i }).click()`. `getByPlaceholder`/`getByRole` normalize whitespace, absorbing the trailing-whitespace padding the live form sometimes renders. Applies to BOTH the discovery runner and the hourly `portal-client.createPortalClient` login (shared `SELECTORS` + login sequence).

- **`/s/home` is a 404 "Error" page for EVERYONE** — authenticated and anonymous alike. It is NOT a list view. The old discovery runner enumerated against it and found zero objects, and the old auth check (URL + visible username field only) read the 404 shell as "logged in" because it has no password field — a false positive that meant `AuthFailedError` never fired on a failed login. The authenticated landing page is **`/s/`** (title "Home", banner "Good morning, Bill Barnard! You're currently viewing as DR3 Woodland. Switch Account").

- **`looksLoggedOut` is now a POSITIVE auth-marker check.** Logged-in ⇔ an authenticated marker is present (the "Switch Account" / "viewing as DR3" banner, or ≥2 object nav links) AND no visible "Log in" control. A bare 404 shell / unrecognized page with no marker is treated as logged out so the loud D5 `AuthFailedError` path actually fires.

- **Enumeration walks the NAV → per-object list pages, not `/s/home`.** After auth-verifying at `/s/`, discovery reads the nav (the `NavigationMenuDataProvider/getNavigationMenu` Aura response, supplemented by DOM `a[href^="/s/"]` links, with a static object allowlist as fallback) and visits each OBJECT page. The object slugs (2026-07-22): `hauls`, `illegal-dump-cip-`, `processed-materials`, `outbound-materials`, `availability`, `outbound-vendors`, `records-review`. Non-object nav entries — Home (`/s/`), FAQs (`/s/help-articles`), Support (`/s/contact`), Reports (`/s/report/Report/Recent`) — are filtered out. Each object page's `ListViewDataManagerController/getItems` Aura action is the real record-id source; one `/s/detail/<id>` (`getRecordWithFields`) per object captures the field set, as before. (The hourly sync's three feeds already point at `/s/hauls` `/s/processed-materials` `/s/outbound-materials` — correct object pages — so only its login + auth check needed the fix.)

- **Discovery output dir is configurable via `MYMRC_DISCOVERY_OUT_DIR`.** The runner previously wrote `docs/mymrc-discovery-<date>.md` + `src/lib/mymrc/__fixtures__/<object>/` under `/app`, which is read-only for uid 1001 in the container (the first live run died with `EACCES`). The out-dir now defaults to the repo root (unchanged for local dev) but can point at a writable mounted volume; the repo layout (`docs/` + `src/lib/mymrc/__fixtures__/`) is preserved under the override so artifacts copy back trivially.

- **FOLLOW-UP (not implemented this pass): "Switch Account" multi-recycler.** The admin account views ONE recycler at a time (DR3 Woodland ↔ DR3 Eugene) via the "Switch Account" banner; records carry the recycler (`Recycler__c`). The hourly scrape currently pulls whichever context the session lands in. To pull BOTH sites' data it will need to iterate account contexts (switch account, re-enumerate) per tick — evidence-backed but deferred; flagged here for Phase 1.
