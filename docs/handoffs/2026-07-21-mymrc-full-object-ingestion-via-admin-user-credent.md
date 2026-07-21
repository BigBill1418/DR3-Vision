# 2026-07-21 — MyMRC full-object ingestion via admin user credentials (ADR-0057 + Phase 0/1 plan)

**Session context (Bill × Claude, 2026-07-21):**

Bill directive: *"its time to pull in all the mymrc data - full sync - we will do it via my user creds and pull all data. we need to plan and wire this into the whole stack for full ingestion of all MyMRC data."*

**Foundational discovery during planning (the framing correction):**

- **Nothing has ever pulled from MyMRC.** Not a byte. Bill confirmed: *"we may have something built but nothing is running yet we have never pulled from MyMRC."*
- **Code exists, container exists, schema exists, migrations applied** — ADR-0009 (May 2026) + ADR-0038 (July 3, 2026) built the full Playwright + Aura interception + mirror-tables pipeline. All merged, all deployed to prod. `mymrc-scrape` is running hourly in docker-compose.
- **But the container has been silent no-op since day one.** The referenced service accounts (`DR3 Woodland`, `DR3 Eugene`) were never actually created. Startup logs "creds not configured, skipping" and exits 0 every hour. The fail-soft path swallowed the missing-config state entirely.
- **All three mirror tables** (`mymrc_hauls_mirror`, `mymrc_processed_mirror`, `mymrc_outbound_mirror`) **are structurally sound but empty.**
- **Vision has never seen a real haul, processed record, or outbound record from MyMRC.** Zero rows across all three mirrors. The reconciliation layer, run ledger, PortalContractDriftError safety — all engineered against production Salesforce, all deployed, all completely untested against live data.
- **Phase 0 discovery is the inaugural pull.** Not a re-probe, not an audit of existing sync behavior. First contact.

**Bill's directive translates to:**

- Retire the never-created service-account architecture entirely
- Use Bill's admin user credentials (no MFA on his account)
- Extend from 3 hardcoded feeds to N discovered feeds
- Full historical backfill on every accessible object
- Manual reconciliation queue for all operational updates
- All under Bill's single admin identity

**Execution posture:** full green light — Phase 0 into Phase 1 without stopping. Claude Code reports Phase 0 findings before designing Phase 1 mirror schemas but does not wait for Bill approval to proceed.

**This handoff contains:**

1. Full ADR-0057 draft (§1) — Claude Code accepts + ships to `docs/adr/0057-mymrc-full-object-ingestion.md`
2. Phase 0 discovery spec (§2)
3. Phase 1 foundation spec (§3) — Accounts/Contacts/Rates + reconciliation queue
4. Bill's action items (§4)
5. Claude Code execution order (§5)
6. Success criteria (§6)

---

## §1 — ADR-0057 draft (Claude Code: accept + move to `docs/adr/0057-mymrc-full-object-ingestion.md`)

```markdown
# ADR-0057 — MyMRC full-object ingestion via admin user credentials

**Status:** Proposed — accept on adoption of this handoff (2026-07-21)
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
```

---

## §2 — Phase 0 discovery spec

**Goal:** enumerate exactly what Bill's admin account can see. No production changes. First-ever pull from MyMRC.

### §2.1 — New script `scripts/mymrc-discovery.mjs`

**Behavior:**
1. Read `MYMRC_ADMIN_USERNAME` + `MYMRC_ADMIN_PASSWORD` from env (set per §4)
2. Playwright login using existing login helpers in `src/lib/mymrc/` (extend if needed for admin login flow — existing helpers were written against service-account UX)
3. Save storage state to `~/.dr3-vision/mymrc-admin/auth.json`
4. Navigate `/s/home` — capture nav menu / launcher / list-view selector
5. For each accessible page discovered:
   - Load the page
   - Intercept `ListViewDataManagerController/ACTION$getItems` — record `objectApiName`, list view name, column metadata, record-count-estimate from response
   - Grab one representative record id from the list
   - Load `/s/detail/<recordId>` — intercept `RecordUiController/ACTION$getRecordWithFields`
   - Capture full field set (`fields.<ApiName>.{displayValue, value}` shape)
6. Also probe (may or may not work per ADR-0009's API-Enabled denial):
   - `GET /services/data/v58.0/sobjects/` — object metadata (likely 401 but capture the response either way)
   - `GET /s/global-search?q=*` — cross-object search endpoints
7. Emit report `docs/mymrc-discovery-2026-07-21.md` with:
   - Auth outcome (session cookie present + not-a-login-page validation)
   - Per-object row: `{objectApiName, listUrl, listViewName, fieldCount, sampleFields, recordCountEstimate, hasDetailPage}`
   - Access gaps: pages seen in nav but 403/redirect on load
   - API probe results (accessible endpoints if any)
   - Storage estimate: total mirror table row count × avg payload size

### §2.2 — Discovery fixtures

Capture REAL (redacted for person names) Aura envelopes for each newly discovered object under `src/lib/mymrc/__fixtures__/<object_api_name>/`:
- `list-getItems-response.json`
- `record-getRecordWithFields-response.json`
- `discovery-metadata.json` (object metadata Bill's account can see)

These become the source of truth for Phase 1 mapper design + test fixtures. Existing three mirror objects (`Haul_Request__c`, `Materials__c`) already have fixtures from the 2026-07-03 discovery — do not re-capture unless drift detected.

### §2.3 — What Phase 0 does NOT do

- No mirror table migrations for new objects
- No changes to existing sync behavior
- No production code changes
- No reconciliation queue writes
- No backfill of existing mirrors (that's Phase 1)

### §2.4 — Phase 0 exit criteria

Discovery report exists at `docs/mymrc-discovery-2026-07-21.md` with:
- Auth outcome documented (Bill's admin creds authenticate cleanly, or failure mode captured)
- ≥ 5 objects enumerated (existing 3 + at least Accounts + Contacts + Rates likely accessible to admin)
- Fixture capture per new object
- ntfy notification to Bill: "Phase 0 discovery complete: N objects, M fields captured, ready for Phase 1"

Claude Code moves immediately to Phase 1 without waiting for Bill review — full green light (§6).

---

## §3 — Phase 1 foundation spec

**Goal:** turn on admin-auth sync + backfill everything (including the existing 3 mirrors that have never had data) + close the S-4/5/6/7 canonical-name gap + close Kelsey's post-8/8 contact handoff.

### §3.1 — Env + config transition

- `MYMRC_ADMIN_USERNAME` + `MYMRC_ADMIN_PASSWORD` added to `~/.dr3-vision-secrets/mymrc.env` on CHAD-HQ (per §4)
- DELETE `MYMRC_WOODLAND_*` / `MYMRC_EUGENE_*` / `MYMRC_OR_*` / `MYMRC_CA_*` handling from `mymrc-scrape.mjs`, `docker-compose.yml`, `docs/operator/mymrc-setup.md`, `docs/MYMRC-INTEGRATION.md`, and any related fixtures/tests
- `mymrc-scrape` startup validates admin creds present, fail-loud if missing (D9)
- Single Playwright context, single storage state
- Update `docs/operator/mymrc-setup.md` for admin-mode runbook (reflect reality: this is Vision's first-ever MyMRC sync)

### §3.2 — Foundation mirror tables

Following the ADR-0038 D2 pattern, add three new mirror tables in Phase 1:

**`mymrc_accounts_mirror`** (Salesforce `Account`):
- Canonical site/organization records
- Fields (subject to Phase 0 confirmation): Name, ShippingAddress, RecordType (site vs retailer vs hauler), Category custom fields, Contract terms
- Feeds S-4/5/6/7 reconciliation

**`mymrc_contacts_mirror`** (Salesforce `Contact`):
- MRC-side people (Ryan Trainer, Christine, Mark P, Darcy, and whoever else)
- Fields: Name, Email, Phone, Title, AccountId (which Account they're associated with)
- Feeds Kelsey's post-8/8 MRC contact map

**`mymrc_rates_mirror`** (whatever object holds rate cards — likely `Rate__c` or similar, confirmed by Phase 0):
- MRC's contracted rate structure
- Fields (subject to Phase 0): Rate type (processing / trans / rental / event), amount, effective dates, site scope, applicable object references
- Cross-checks Vision's `state_program_rules` + `source_service_rates` seeds

### §3.3 — Reconciliation queue table + admin surface

Ship `mymrc_reconciliation_queue` per D4. Admin UI at `/admin/mymrc/reconcile`:

**Route:** `GET /admin/mymrc/reconcile` (admin-only per ADR-0017)

**UI features:**
- Filter by `mirror_table` (dropdown), `change_kind` (dropdown), status (default = pending)
- Table showing: mirror table icon, entity name, field name, MyMRC value, Vision value, change_kind badge, per-row Approve/Reject/Snooze buttons
- Bulk actions: "Approve all `address` updates from `mymrc_accounts_mirror`" style filters
- Per-item modal for Approve/Reject requires a note (mirrors AP approval pattern from ADR-0046)
- Audit log tab: decided items with decision + who + when

**On Approve:**
- Vision writes the change to the target operational table (`sources.name`, `sources.address`, etc.)
- Stamps `decided_at` / `decided_by` / `decision_note`
- Emits audit-log row (existing `activity_log` pattern)

**On Reject:**
- No write to operational tables
- Mirror row keeps last_seen; next sync run will re-queue if the discrepancy persists

**On Snooze:**
- 7-day defer; mirror sync skips re-queuing until snooze expires
- Configurable per-item duration if needed later

### §3.4 — Change detection classifier

`src/lib/mymrc/reconcile-detect.ts` — pure function library:

**`detectAccountChanges(mirrorRow, sources, sourceAliases): ReconciliationCandidate[]`**
- For each field in the mirror payload we care about (`Name`, `ShippingAddress`, `Category`):
  - Attempt to link mirror row to a Vision `sources` record via existing two-step alias fallback (`upsert-alias-fallback.ts`)
  - If linked + field differs → emit `change_kind=field_update`
  - If unlinked → emit `change_kind=new_record`
  - If mirror row has `disappeared_at` + linked Vision record is still active → emit `change_kind=disappeared`

Similar detectors for Contacts (link to a Vision `mrc_contacts` table if we build one, or just report as new) and Rates.

### §3.5 — Initial backfill

**Six objects need backfill, not three.** The existing three mirrors have never had data — this is their first-ever pull too.

- Backfill cursor rows created for each of the 6 objects
- Backfill worker runs on first `mymrc-scrape` startup after Phase 1 deploy
- Cursor-based, resumable, one-time; hourly sync takes over after all `completed_at` are set

**Estimated durations** (rough — actual numbers from Phase 0 report):
- `Haul_Request__c`: 12+ months × ~60 hauls/mo = ~720+ records, ~5 min at 3-concurrent
- `Materials__c` Processing/Outbound: similar magnitude
- `Account`: probably 100-500 records total, ~2 min
- `Contact`: similar, ~2 min
- `Rate__c`: probably < 100 records, seconds

Total initial backfill: ~30-60 min. Overnight window is overkill; a coffee break suffices.

### §3.6 — Success surface for Bill

- `/admin/mymrc/reconcile` populated with the initial backfill's `new_record` and `field_update` candidates
- ntfy notification: "Phase 1 complete: N accounts, M contacts, K rates mirrored; existing 3 mirrors backfilled (H hauls, P processed, O outbound). Q reconciliation candidates pending your review."
- Immediate action for Bill: review reconciliation queue, batch-approve canonical name updates for OR sources (closes S-4/5/6/7)

### §3.7 — Phase 1 exit criteria

- Admin auth path live in prod, verified sync run
- All 3 existing feeds populated with historical data for the first time (parity with reality, no baseline comparison possible)
- All 3 new feeds populated (Accounts, Contacts, Rates)
- Reconciliation queue populated with initial backfill candidates
- S-4/5/6/7 candidates specifically identified for Bill review
- ntfy notification sent
- Runbook updated (`docs/operator/mymrc-setup.md`)
- `expected_loads` operator queue seeing MyMRC-scheduled hauls for the first time

---

## §4 — Actions for Bill

### §4.1 — Set MyMRC admin credentials on CHAD-HQ

Add to `~/.dr3-vision-secrets/mymrc.env`:

```bash
ssh 10.99.0.2
umask 077

# Append these two lines to ~/.dr3-vision-secrets/mymrc.env
tee -a ~/.dr3-vision-secrets/mymrc.env <<'EOF'

# 2026-07-21 — MyMRC admin user credentials (ADR-0057)
# Sole credentials for MyMRC ingestion (retires unused MYMRC_WOODLAND_* / MYMRC_EUGENE_*)
MYMRC_ADMIN_USERNAME=<Bill's SVdP email login>
MYMRC_ADMIN_PASSWORD=<Bill's MyMRC password>
EOF
chmod 600 ~/.dr3-vision-secrets/mymrc.env

# Verify
grep -c '^MYMRC_ADMIN_' ~/.dr3-vision-secrets/mymrc.env  # expect 2
```

**Important:** no trailing whitespace on values (same MyMRC quirk documented in existing setup runbook — password with stray space returns "Invalid username or password").

### §4.2 — Approve reconciliation queue after Phase 1 completes

Once ntfy fires "Phase 1 complete", visit `/admin/mymrc/reconcile`. Expected initial state:

- Bulk-approve all `field_update` on `mymrc_accounts_mirror` with `field_name=name` → closes S-4 (canonical name gap)
- Bulk-approve `field_update` on `field_name=address` → closes S-5
- Review + approve `new_record` for any Accounts we don't have as `sources` yet → seeds missing OR sites Rick's answers implied
- Review `mymrc_contacts_mirror` → Kelsey's MRC contact map surfaces automatically

Reconciliation is DAILY WORK during initial backfill window. After that, expect a handful of items per week.

### §4.3 — Rotate MYMRC_ADMIN_PASSWORD runbook

Documented in updated `docs/operator/mymrc-setup.md` per Phase 1 exit criteria. Same pattern as existing rotation: update env, `docker compose up -d --force-recreate --no-deps mymrc-scrape`.

---

## §5 — Actions for Claude Code (execution order)

Bill's directive: full green light, no stopping between phases.

### §5.1 — Ship ADR-0057

Move §1 content to `docs/adr/0057-mymrc-full-object-ingestion.md`. Status: Accepted (2026-07-21).

### §5.2 — Execute Phase 0 discovery

Per §2 spec. Deliverable: `docs/mymrc-discovery-2026-07-21.md` + fixtures.

**Prerequisite:** Bill's credentials landed per §4.1. If credentials missing, ntfy Bill + halt with typed error (no silent no-op — D9).

### §5.3 — Execute Phase 1 foundation

Per §3 spec. Ordering:

1. Auth transition — env + config + fail-loud validator + docs update (D9)
2. Foundation mirror table migrations (Accounts, Contacts, Rates) — schemas informed by Phase 0 output
3. Mappers with fixture tests
4. Reconciliation queue table + change detection classifier + admin surface `/admin/mymrc/reconcile`
5. Initial backfill worker + cursor plumbing
6. Deploy + verify per §3.7 exit criteria

Existing 3 mirror tables (`mymrc_hauls_mirror`, etc.) stay as-is. Do not rebuild them. Backfill them from origin as part of the initial backfill wave — this is their first data.

### §5.4 — Do NOT

- Do NOT design Phase 1 mirror schemas from guesses. Wait for Phase 0 output.
- Do NOT auto-update `sources` / `source_aliases` / `state_program_rules` from mirror data. All changes go through the reconciliation queue.
- Do NOT drop `mymrc_hauls_mirror` / `mymrc_processed_mirror` / `mymrc_outbound_mirror` — they're empty but the schema is correct.
- Do NOT touch write-path work (Vision → MyMRC). Out of scope.
- Do NOT skip fixture capture in Phase 0 — future portal drift detection depends on it.

### §5.5 — Notify Bill

- After Phase 0 completes: ntfy summary of discovered objects
- After Phase 1 completes: ntfy queue population + reconciliation count
- On any auth failure: immediate ntfy

---

## §6 — Success criteria

**Phase 0:**
- Discovery report exists with ≥ 5 objects enumerated
- Fixture capture complete per new object
- Auth outcome documented (this is Vision's first-ever authenticated MyMRC session)
- No production changes (auth, sync behavior, schemas)

**Phase 1:**
- Admin auth active + verified sync run
- 6 mirror tables populated (3 existing filled for the first time + 3 new)
- Reconciliation queue populated
- Bill can navigate `/admin/mymrc/reconcile` and see candidate updates
- S-4/5/6/7 items specifically visible for Bill review + bulk-approve
- `expected_loads` operator queue reflecting real MyMRC-scheduled hauls
- Runbook updated

**Overall:**
- ADR-0057 shipped
- ADR-0038 references updated to note the auth model change + the never-honored service-account history
- `docs/operator/mymrc-setup.md` reflects admin-mode reality
- OPEN-ITEMS.md: S-4/5/6/7 flagged as "unblocked by ADR-0057 Phase 1 — awaiting Bill queue review"

## §7 — Session close

Bill's directive translates to: extend the existing production pipeline (already built + deployed but never actually run) from 3 planned feeds to N discovered feeds, retire the service-account architecture that never existed, add manual reconciliation gate before operational updates, backfill everything to origin, run everything under Bill's admin identity.

Everything else (Rick's 13-question source disambiguation from earlier today, event billing wiring, etc.) is separate work. This handoff is exclusively MyMRC ingestion + reconciliation surface.

Standing by after Phase 0 for scope check if Bill wants to review discovery output before Phase 1 mirror schemas ship. Per Bill's execution posture: **do NOT wait for scope check** — Phase 1 proceeds automatically after Phase 0 completes.
