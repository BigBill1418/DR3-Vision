# DR3-Vision — session handoff 2026-07-22

Large multi-track session. Everything below is **merged + deployed + container-verified on CHAD** unless marked IN FLIGHT. Deploy discipline: verify the CONTAINER (docker exec / `docker run dr3-vision-app:local`), never just git HEAD — the deployer build-races-pull (bit us this session; the `busy=N` `pgrep` build-idle check false-positives on ssh/bash wrappers — filter `pgrep|bash -c`).

## MyMRC ingestion — now COMPLETE + reliable (the big one)
Vision had never truly pulled MyMRC billing data. Fixed end-to-end:
- **#154** history views (Completed Hauls + inactive materials).
- **#155** — SOQL **OFFSET-2000 cap** silently truncated list pagination at 2050 rows → **sort-flip pagination** (asc/desc Id windows, union, dedup on salesforce_record_id). Row IDs now reconcile pulled==portal for all 8 views.
- **#158** — the `mymrc-scrape` worker was **profile-gated** (`profiles:['mymrc']`) so the deployer never ran it (empty `mymrc_sync_runs` ledger → "no sync has run" despite full mirrors). Un-gated (always-on). Also hardened mid-run re-auth: `ensureAuthenticated` now rebuilds a CLEAN context (mirrors `bootstrap`) + bounded retry — the portal drops sessions mid-run ~every tick and the old dirty-context relogin failed ~50%.
- **#160** — CRITICAL: billing fields (`program_unit_count`/`non_program_unit_count`/`weight_lbs`) come ONLY from per-record DETAIL (`getRecordWithFields`), and the old `/s/detail/<id>` navigation+interception was a RACE → only **0.4%** captured (7208 hauls, 29 detailed = mostly empty ID stubs). Terry researched + proved live: replay `aura://RecordUiController/ACTION$getRecordWithFields` as a **direct batched POST (~100 ids/POST)** to `/s/sfsites/aura`, envelope-reused, no navigation. New `src/lib/mymrc/record-fields-client.ts` + `enrich-details.ts` + `scripts/mymrc-enrich-details.mjs`; replaced the racy path in BOTH `sync.ts` (steady-state) and `backfill.ts`; `PortalClient.getSession()` shares one login. **Result: 0.4% → 100% in ~13 min, 0 errors** (hauls 7208/7208, processed 984/984, outbound 4514/4514, dock 14/14; sum haul program units = 645,416). Arch spec: `scratchpad/mymrc-field-capture-architecture.md`. Ruled out (live): richer list view, report/CSV export (`/services/data`→401, UI-API `API_DISABLED_FOR_ORG`).

## AP module — ADR-0046 Amendment 5 LIVE (#157)
Structured 4-field Approve (vendor/explanation/confirmed_amount/equipment), hybrid extraction (local pdf-parse→Claude fallback), **$1K dual-approval** (Woodland→Bill, Eugene→Shannon), vendor variance (block-until-ack), invoice history (`/admin/ap/history`), equipment linking. Migration `20260805` (monotonic ordinal — repo uses ordinals not calendar dates). `vendor`/`amount_cents` DEPRECATED not dropped. 9 pre-go-live minors fixed incl. iOS PDF-preview blank (now "Open PDF in new tab"), per-vendor 0% override, Feb-29 variance-window overflow, dual-approval stamp both approvers.
- **Anthropic key WIRED** for extraction: `~/.dr3-vision-secrets/anthropic.env` (chmod 600, mounted to `app` in compose; the poll runs `runApPoll` inside the app via `/api/internal/ap/poll`, NOT the ap-poll ticker). Validated (/v1/models 200), model `claude-sonnet-4-6` valid. Bill will rotate later — rotate = overwrite that file + `docker compose up -d app`.

## Other shipped
- **#156 Operations Dashboard** re-enabled (ADR-0020 tile), iPad-legible per-site + admin combined view; born-live (NOT behind /admin/rollout ramp). Screenshots reviewed by eye.
- **#159 Bonus** — total processed mattresses now shown in the Daily Bonus entry footer next to the dollar Day-total (+ read-only month grid). Live.
- **Bonus report timing** — `bonus_daily_report_config.send_time_pt` fixed 18:00→20:00 for BOTH sites (was firing the 8pm late-flag at 6pm; seed was already 20:00, rows predated it).
- **Shannon Rockwell** provisioned as Eugene 2nd approver: Vision user `shannon.rockwell@svdp.us` (manager, Eugene, `can_view_ap_history`), active `ap_approvers` roster row (REQUIRED — `canActOnApRequest`/`requireApApprover` gate the AP UI on roster/admin; pure 2nd-approver can't reach it), `ap_second_approvers` row `site_id='eugene'` (site_id = CODE not UUID). Bill added her to the Entra SSO group (Vision auth = email-match, no group claim, but the enterprise app is assignment-gated).

## Eugene iPad go-live = 2026-07-23 (TOMORROW)
Readiness = CONDITIONAL GO (terry audit `scratchpad/eugene-ipad-golive-readiness.md`). Deploy healthy. Eugene MANAGER uses Entra SSO at /login (NOT the PIN /operator floor UI). Pending operator: confirm who's at the iPad; upload AP baseline PDF to /admin/file-drop then run /admin/ap/baselines/import; Kelsey's AP approver role expires 2026-08-08 (Rick permanent).

## IN FLIGHT (not merged)
- **Navigation back-to-dashboard fix** — branch `fix/nav-back-to-dashboard` (off 7053fdf). AUDIT: 30/57 pages had NO in-app link to `/` (route-group layouts bonus/dashboard have no home nav; NO admin/layout.tsx; VisionShell logo not linked). Fix (aegis building): shared "← Dashboard" nav in bonus + dashboard + NEW admin layout + logo→`/`. Needs screenshot eye-review → PR → deploy.

## Follow-ups
- noc-master service-registry should add `mymrc-scrape` for fleet monitoring.
- Consider whether Shannon should be strictly 2nd-approver-only (currently also a 1st-approver via required roster access — code change if desired).
