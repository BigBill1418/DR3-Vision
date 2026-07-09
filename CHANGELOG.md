# Changelog

All notable changes to DR3-Vision are recorded here.
Format follows Keep a Changelog (semver-ish, sprint-tagged).

## Unreleased

### Added — 2026-07-09 (dr3-intel-2026-06 survey export — campaign closure)

- **Survey campaign `dr3-intel-2026-06` closure completed.** Mary Scott (final
  outstanding respondent) self-submitted 2026-07-07 12:29 PM PT after 5 automated
  reminders; ADR-0036 auto-close fired 3 minutes later. Response export (9
  respondent files + `_summary.md`) generated from the prod DB in `buildExport`
  format and committed under `docs/operations-intel/dr3-intel-2026-06/` — the
  close route builds but does not push the export (ClaudeSync push is still a
  follow-up), so this commit is the export artifact. Operator runbook campaign
  log updated with the final standing.

### Added — 2026-07-09 (ADR-0046 Amendment 3 — AP go-live features)

Operator-directed (Bill, 2026-07-09) ahead of AP going LIVE ~2026-07-11. Amends
ADR-0046 §C5; mock-first transport architecture unchanged. Migration
`20260716_ap_hold_and_notes` is purely additive and clean-replays on empty PG16.
All AP mail still routes through `notifyStaff('ap_notify')` (born pilot — reroutes
to admins until Bill flips it live).

- **New-invoice notification to ALL active approvers, enriched.** The one-per-request
  new-request email (already sent to the full expiry-aware roster, excluding any
  approver past `active_until`) now carries the requester, subject, received-at
  (Pacific), attachment count, and a **tier-1 deep link** to the specific queue item
  (`/dashboard/ops/ap?request=<id>`).
- **Approval / rejection notes.** A **rejection now REQUIRES a note** (plain-English
  400 at the decide route + disabled Reject until a note is present); approvals stay
  note-optional. The note rides the decision email, the **stamped decision PDF**, and
  the audit row.
- **`pending_review` (hold) status.** An approver may place a pending request **on
  hold** with a required hold note (`ap_requests.held_by`/`held_at`/`hold_note`,
  enum value `pending_review`). Accounting (the original forwarder) is emailed that
  it is held (who + note + "a final decision follows"). The queue shows an amber
  **ON HOLD** chip with holder + note visible to all approvers. From hold, any
  approver may approve/reject (first-action-wins unchanged) or update the hold note.
  Held items are excluded by design from any future staleness alert (none exists
  today). Every transition is audited.

### Added — 2026-07-09 (planning rollup 2026-07-08 — build-now subset)

The OPERATOR-ordered build-now subset of the 2026-07-08 planning rollup
(`docs/handoffs/2026-07-09-planning-session-decisions-rollup-2026-07-08.md`). Four
features + two proposal ADRs. Every new staff-facing surface is **born pilot**
(ADR-0047); no email is sent by anything added here in pilot (decision/board-pack
mail reroutes to admins). Migrations `20260715_pool_split` +
`20260715b_rollup_ap_boardpack_yard` clean-replay on empty PG16.

- **ADR-0037 §3 — inventory pool split.** `site_inventory_snapshots` gains
  `program_units` / `non_program_units` (`Decimal(7,1)`) + `pool_attribution`
  (`measured` | `legacy`). Physical counts record the program and non-program pools
  separately; a `measured` count is validated `program + non_program == total`
  (typed `PoolSplitMismatchError`, 422). Existing rows backfilled `legacy`
  (all-to-program). The count-entry UI gains the two fields + a live running-total
  helper + plain-language mismatch error (EN/ES/UR). `running-balance.ts` `onHand()`
  uses the measured split as the anchor when present, else legacy fallback;
  `{ program, nonProgram, total }` return shape unchanged.
- **ADR-0046 §3 — AP mailbox expansion.** Explicit `ap_approvers` roster (Morena,
  Rick, Janette, Kelsey; Bill acts as admin) with `active_until` — single-site
  managers are now full approvers (queue permission = admin OR active approver).
  Kelsey auto-removes 8/1 via a daily `ap-approver-expiry` cron (audit + Bill ntfy).
  Optional site tag at decision (`ap_requests.site_id`). Decision email routes to
  the original internal `@svdp.us` forwarder (intake sender validation unchanged),
  carrying a visible-stamp PDF (no crypto) whose sha256 is a tamper record
  (`ap_requests.decision_pdf_sha256`); stamping reuses the repo's Playwright→PDF
  mechanism (no PDF library added — see the ADR §3 amendment for the deviation).
- **ADR-0045 §3 — board-pack digest.** New org-wide `board_pack_digest` notification
  surface (born pilot) sent via `notifyStaff`. `board_pack_recipients` roster
  (Bethany + Bill; Bethany is a documented placeholder). Fires the 2nd Wednesday +
  preceding Monday (Pacific, reusing `digest-calendar.ts`), one send/month
  (`board_pack_send_log`). Payload: prev-month processed units, MTD, YoY, P&L
  placeholder, no safety section. First LIVE send targets 2026-08-10 (ships pilot).
- **Trailer/yard list scaffold (rollup §1.8).** Manager `/dashboard/<site>/yard`
  view behind the new `yard_list` UI surface (born pilot ⇒ admin-only). Reads
  `container_rental_sites` + on-hand context; `yard_trailers` table (label,
  location, status) with add/edit (audited). EN/ES/UR.
- **ADRs 0049 (workbook sync bridge) + 0050 (compliance-admin ledger)** drafted as
  Proposed (no code) and indexed. ADR post-acceptance notes added to 0030 / 0028 /
  0029 / 0047 (Q-0047 grandfather resolutions).
- **ADR-0049 — Woodland workbook → Vision sync bridge (BUILT, mock-first).** Status
  → Accepted (2026-07-09 operator build-all order; parser finalization + enable flip
  gated). The `Files.Read.All` tenant grant landed 2026-07-09 (app
  `2da2…`). Mirrors each site's monthly Woodland daily-log workbook from Kelsey's
  OneDrive into `processed_units_daily` every 10 min (business hours, PT). New
  `src/lib/msgraph-files/` READ-ONLY Graph Files transport (live + fixture mock; creds
  fall back to the shared `MSGRAPH_MAIL_*` app — one app, two capabilities) and
  `src/lib/workbook-sync/` engine: current-month discovery + auto rollover (D5), cTag
  delta (no re-download when unchanged, D2), **workbook-wins** upsert with an audit row
  per Vision-overwrite (D3), mid-edit skip+count (D11), `workbook_sync_runs` ledger
  (mymrc shape, always written), 403 fail-soft (log + ntfy, no crash, D6). Cutover flip
  (in `/admin/rollout` OR `/admin/workbook-sync`) stops sync + fires R2 archival to
  `workbooks/{site}/{yearMonth}.xlsm` (D8), soft-gated on Rick's parity signoff (D7).
  `/admin/workbook-sync` admin surface (sources add/edit/enable, run ledger, cutover).
  10-min cron (`scripts/workbook-sync-cron.mjs`) + business-hours-enforcing internal
  route + public-paths exemption (+ regression test) + `workbook-sync` compose profile.
  Migration `20260716b_workbook_sync` (`workbook_sources` + `workbook_sync_runs`,
  `RolloutSurfaceKind` gains `workbook_sync`) clean-replays on empty PG16. Seed adds the
  Woodland source (born `is_syncing=false`) + `workbook_sync` surface (born `pilot`),
  idempotent. GATED: the per-day parser mapping (`daily-adapter.ts`) reads the
  Addendum-B fixture layout until Kelsey's real `.xlsm` lands (D12); each source is
  born disabled pending a deliberate operator enable.

### Fixed — 2026-07-07 payroll-morning hotfix

- **Signature-chain cache TTL (30s).** The per-site chain cache was keyed on the
  prisma singleton and lived for the process lifetime — the 2026-07-07 chain
  repair (override actors pointed at a deactivated duplicate admin user) was
  invisible to the t3 auto-override until an app restart. Config repairs now
  take effect within 30s.
- **Future-period close guard.** The manual "ready to sign" close now refuses
  (409, plain-English) any period whose end date is still in the future —
  Eugene's current P15 was closed by mistake during the P14 signature scramble,
  locking daily bonus entry site-wide. Early close on the final day remains
  allowed.

### Added — 2026-07-07 (ADR-0047 — staff-output rollout gate + ADR-0039 A1 bootstrap gating; INCIDENT)

Response to the 2026-07-06 incident (the ADR-0043 digest emailed a site manager
two true-but-useless bootstrap findings the day the feature merged). Two
release-discipline fixes, deployed together.

- **`notifyStaff()` chokepoint (`src/lib/notify/`).** The ONLY sanctioned path to
  non-admin recipients. Resolves the `(surface_code, site)` rollout state:
  `pilot` reroutes to admins with a `[PILOT — would have sent to: …]` subject +
  body banner (validates content AND targeting); `live` sends to the real
  recipients; an unregistered surface throws `UnregisteredSurfaceError` (never a
  silent send). Every decision is audited + logged.
- **Rollout registry (`rollout_surfaces`, migration `20260713_rollout_gate`).**
  One row per staff-facing surface × site, default `pilot`. Notification
  surfaces seeded pilot (alert_digest, task_reminders, contact_intake_notify,
  invoice_approval_notify, cor_notify, ap_notify) except the grandfathered
  production surfaces (bonus_signature_chain, survey_sends) → live. UI surfaces
  (workbench_manager_read, loads_events_or_tabs, equipment_entry, equipment_trend)
  seeded pilot (admin-only, the ADR-0037 D7 template made data-driven).
- **Rewired through the gate:** the ADR-0043 alert digest (which still fires in
  pilot for admin validation even while the roster is muted), ADR-0045
  contact-intake routing, ADR-0046 AP notifications (new-request + quarantine +
  decision email). Task reminders ride the digest.
- **Repo guard (`src/lib/notify/__tests__/no-direct-mail.test.ts`).** Scans the
  real `src/` tree and fails if feature code imports `@/lib/m365-mail` outside the
  allowlist (transport core, notify layer, auth, payroll delivery, and the
  grandfathered signature-chain + survey + daily-report + amendment senders).
  Proven with an in-memory synthetic-import test-of-the-test.
- **Admin panel `/admin/rollout`** (admin role) — every surface × site with
  state + last-flip evidence; flip requires a criteria note; audited + immediate;
  rollback = inverse flip (no code).
- **Bootstrap gating (ADR-0039 Amendment 1, `src/lib/audit/bootstrap-gate.ts`).**
  `c4_billing_basis` / `m1_missing_close` / `m2_missing_snapshot` (registry-driven)
  emit findings only once their leg (billing/close/snapshot) has ever had data
  OR an admin `go_live_date` (`audit_bootstrap_gates`) has passed. Suppressed
  counts land in `audit_runs.suppressed_bootstrap` (visible in admin, never
  silent). Comparators untouched. Existing bootstrap findings auto-resolve with
  cause `bootstrap_suppression` + provenance via migration
  `20260713b_bootstrap_resolve` (never deleted).

### Changed — 2026-07-07 (bonus period-close moves to payroll-day 07:00 PT — ADR-0019.1 amendment)

- **Period close now fires 07:00 PT on the payroll day (the day AFTER
  `period_end`)**, not 17:30 on `period_end` itself. `scripts/bonus-period-close.mjs`
  fire time 17:30 → 07:00 (`msUntilNext1730Pacific` → `msUntilNext0700Pacific`);
  the close route predicate moved from `period_end == appToday()` to
  `period_end == previousDayKey(appToday())` (idempotency preserved — still filters
  `state = 'draft'`). Escalation tier **t1 moved 06:00 → 07:10** (a post-close
  nudge; t2 07:30 / t3 08:30 / t4 09:00 unchanged). Pacific date matrix + DST
  boundary tested; the escalation route already keyed off yesterday, so its logic
  is unchanged.
- **Amendment error messages** are now plain English at the UI layer
  (`src/lib/bonus/amendment-error-messages.ts`) — no more raw `period_not_draft`
  codes on the request-creation + approve/reject surfaces; every
  AmendmentRequestError code has a sentence (period_not_draft references the new
  7:00 AM payroll-day close window).
- **Report-email logo fix.** `SVDP_LOGO_URL` in the daily production report now
  points at our own asset `https://dr3-vision.svdp.us/brand/svdp-logo-white.png`
  (checked in at `public/brand/svdp-logo-white.png`), not the dead
  `svdp.us/wp-content` WordPress hotlink. No other live hotlinked logo exists (the
  bonus-PDF uses an embedded data URI; the audit digest has no logo).
### Added — 2026-07-07 (ADR-0048 — June operational backfill + Terex history import)

- **Staging→operational promotion (`src/lib/audit/workbook-promotion.ts`).** The
  ADR-0023 historical-import discipline (SHA gate + idempotency + provenance +
  audit) applied to loads/inventory. `promoteWorkbookImport(importId, scope)`
  reads a workbook's parsed staging rows (ADR-0039 `workbook_import_rows`) and
  promotes them, in ONE transaction, into `processed_units_daily`,
  `inbound_loads`, `outbound_materials`, `landfilled_units`, `consumer_dropoffs`,
  and the anchor `site_inventory_snapshots` — every row `source=import` (or, for
  `inbound_loads` which has no RecordSource column, tagged by `import_id`) with the
  promotion id stamped in a new bare `import_id` column on each table.
  - **Idempotent** on `workbook_promotions.import_id` (UNIQUE) — a re-run is a
    no-op that returns the prior counts; a re-run whose staged content changed is
    REFUSED (SHA mismatch).
  - **Conflict refusal** — any live (non-import) row in the (site, table, window)
    is a typed `PromotionConflictError` listing table + dates; no partial merge.
  - **Scope enforcement** — table-driven allow-list (`backfill-scopes.ts`):
    Woodland Jun 1–30, Eugene Jun 24–30; rows outside the window are clipped.
    Enforced in the promote ROUTE (a request may only promote an allowed window).
  - **D2 live assertion** — the June-1 opening inventory is promoted as the
    physical anchor and the June-close balance is recomputed via the shared
    `computeRunningBalance`; the transaction REFUSES COMMIT unless Woodland closes
    to exactly **4,062** (the expected total is scope config, not a hardcode).
  - One audit row per promoted table with counts (append-only, hard rule #6).
- **Terex history import (`src/lib/equipment/import.ts`).** Admin upload
  (xlsx/csv) → `equipment_events` (`source=import`). Flexible header detection
  (date/notes/hours/downtime); downtime rows → `kind=downtime` (hours where
  stated), everything else → `kind=note`. FAILS LOUD (typed `TerexParseError`,
  listing what it saw) on an unrecognized shape — never guesses rows. Idempotent
  on (site, event_date, kind, note-hash); re-uploading the identical file is a
  no-op (`equipment_history_imports.source_sha256` UNIQUE). The mapping is
  **finalized against Janette's real file on receipt** — the upload UI says so.
- **Admin surfaces.** Promotion panel on the workbook-import detail
  (`/admin/audit/workbook/[importId]`): scope options → dry-run preview (per-table
  counts + conflicts + recomputed close vs the known figure) → commit. Terex
  upload page (`/admin/equipment/import`). Both admin-only, both audited.
- **Migration `20260714_june_backfill`.** Purely additive: two ledger tables
  (`workbook_promotions`, `equipment_history_imports`) + a nullable `import_id`
  column (with a sparse partial index) on each of the seven promotable operational
  tables. Clean-replays on an empty PG16.
- **Blocked on Bill's three files (ADR-0048 D4):** the June Woodland `.xlsm`, the
  Eugene June log, and Janette's Terex spreadsheet. Until supplied, everything
  ships tested against Addendum-B-shaped fixtures. Click-path in
  `docs/operator/june-backfill.md`.

### Ops — 2026-07-06

- **Restore drill PASSED (readiness P1-3 closed).** Latest restic/R2 snapshot restored into a throwaway postgres and verified against prod on five invariants (migration head, entry counts, paid-payroll cents exact). Two DR-procedure gotchas discovered and documented in `docs/operator/restore-drills.md` (R2_* env mapping; the postgres init-server race that yields a silent empty restore). Remaining D7 activation gate item: RESTIC_PASSWORD off-box confirmation (operator).

### Added — 2026-07-06 (ADR-0046 — vendor-invoice approval via Graph mailbox ingestion)

- **ADR-0046.** Vision's FIRST inbound-email transport. Accounting mails an
  approval request to `approvals-dr3@svdp.us`; Vision polls the mailbox by
  Microsoft Graph delta, turns each valid message into an approval request,
  Morena/Janette (as data: org-reach approvers) decide inside Vision
  (first-action-wins, atomic), and Vision mails the decision back to a FIXED
  recipient list for Mary's Great Plains filing. Built **mock-first**: it runs
  complete against a fixture-driven transport and flips to live creds with
  configuration only (SVdP IT delivers the mailbox + Graph app + tenant consent +
  ApplicationAccessPolicy — the 8/1 risk is IT lead time, not code).
- **Generic transport `src/lib/msgraph-mail/`** (deliberately NOT AP-scoped —
  Morena's parked dispatch↔Outlook ask consumes it later): a `MailTransport`
  interface (`listDelta`/`getMessage`/`listAttachments`/`moveMessage`, typed
  `AuthFailedError`/`GraphContractDriftError`), `graphTransport`
  (client-credentials via `@azure/identity` + plain `fetch` against Graph v1.0 —
  no heavy Graph SDK, `MSGRAPH_MAIL_{TENANT_ID,CLIENT_ID,SECRET,MAILBOX}`,
  `Mail.ReadWrite`), and `mockTransport` (the DEFAULT until creds land). Mode is
  self-reported at startup + in every ledger row; the transport NEVER sends
  (outbound stays `sendSystemEmail`). Delta tokens persist per mailbox+folder
  (`ap_delta_tokens`); a lost token degrades to a full resync, absorbed by
  idempotency.
- **Sanitization (C10.2, non-negotiable):** email HTML is allowlist-sanitized
  with `sanitize-html` AT INGEST into `body_html_sanitized` (raw HTML is never
  stored for render); the queue additionally renders it inside a maximally
  restrictive `<iframe sandbox="">`. Regression test asserts a
  script/onerror/iframe/style-url fixture renders inert.
- **Pipeline (D3):** every polled message reaches exactly one terminal state
  (created/followup/quarantined/duplicate). Sender validation on the
  authenticated envelope sender (forwarder rule, C10.4); full Graph attachment
  taxonomy (fileAttachment → R2 `ap/`; itemAttachment unwrapped one level, deeper
  nesting kept as a visible marker; referenceAttachment recorded, NEVER fetched);
  idempotency on `internet_message_id` UNIQUE; same-conversation follow-ups;
  move-to-Processed hygiene; **quarantine-never-drop** with a Bill page/email
  carrying row id + sender DOMAIN only (no body/attachment/amount — PII-absence
  tested).
- **Approvals (D4):** `/dashboard/ops/ap` queue (org reach — admin or all_sites),
  atomic first-action-wins (`updateMany` count; loser sees "already decided by
  {actor} at {time}"; both attempts audited), optional vendor/amount at decision,
  decision email to the FIXED `ap_decision_recipients` (refuses + pages when the
  list is empty — never the inbound Reply-To), new-request notification to
  approvers, and a pending-AP count line on the ADR-0043 daily digest.
- **Daemon + ops (D5):** thin `scripts/ap-poll-cron.mjs` (10-min tick) →
  loopback-guarded `/api/internal/ap/poll` (+ `public-paths.ts` exemption with a
  mandatory regression test). Profile-gated compose service `ap-poll`
  (`profiles: [ap]`) cloned from `mymrc-scrape`'s shape. Poll-run ledger
  (`ap_poll_runs`) ALWAYS written incl. throw paths; 45-min deadman page.
- **Schema (one additive migration `20260712_ap_approvals`, sorts after
  `20260711_ops_ledger_intake`; clean-replays on empty PG16):** five enums +
  `ap_requests` (org-level, not site-scoped) / `ap_attachments` / `ap_followups` /
  `ap_sender_config` + `ap_sender_entries` (mode `tenant_wide` default |
  `explicit_list`) / `ap_decision_recipients` (seeded EMPTY) / `ap_delta_tokens` /
  `ap_poll_runs`.
- **Dependency:** `sanitize-html` (+ `@types/sanitize-html` dev). Operator doc
  `docs/operator/ap-approvals.md`; `.env.example` gains `MSGRAPH_MAIL_*` +
  `AP_QUARANTINE_EMAIL`.

### Added — 2026-07-05 (ADR-0044 — P4 Terex equipment module)

- **ADR-0044 (P4).** The Terex operational record moves out of a side spreadsheet
  and hallway conversation into Vision: one capture table for
  downtime/maintenance/repair/cost/notes, a derived-throughput trend view, and a
  small site-dashboard tile. Throughput needs NO new capture — it is DERIVED from
  the daily processed-units close (the same number billing bills from). No new
  container, no second entry path.
- **Schema (one additive migration `20260710_equipment_events`, sorts after
  `20260709_alert_recipients`; clean-replays on empty PG16):** the
  `EquipmentEventKind` enum (`downtime`/`maintenance`/`repair`/`cost`/`note`) +
  `equipment_events` (`equipment_code` String default `'terex'`, `event_date`
  @db.Date, `hours_down` Decimal(5,2)?, `cost_cents` Int?, `vendor`, `notes`,
  `source`, audit-actor columns, `voided_at`/`voided_by`). There is **no
  `locked_at`** — events are freely editable and the full history lives in
  `audit_log`; removal is a **soft-void** (never a hard delete, hard rule #6).
  `equipment_code` is a plain string so a second machine is a data value, never a
  migration.
- **Service (`src/lib/equipment/service.ts`, TDD):** `create`/`list`/`update` +
  `void` (soft, audited, idempotent) — no delete. Site-scoped; every write emits an
  `audit_log` row. Validation: `hours_down` only meaningful for
  downtime/maintenance/repair (rejected on cost/note), `cost_cents >= 0`.
- **Derived throughput (`src/lib/equipment/throughput.ts`, pure builders + one
  aggregator, TDD):** units/day (`stripped_program + stripped_non_program`),
  units/run-hour where downtime hours exist (`assumed_day_hours − hours_down`, the
  8h assumption a labeled module constant — not a config table), 7/30-day rolling
  means (null days skipped, never counted as zero), monthly cost series, downtime
  bands, and the `pocketcoil_estimate` overlay series. Downtime hours for the
  run-hour denominator + red bands use `kind=downtime` only (planned
  maintenance/repair hours are captured but not folded in — documented decision).
- **Tile (`src/lib/equipment/tile.ts`, TDD):** last event + 7-day units/day mean,
  site-scoped.
- **Routes (`/api/manager/[site]/equipment` + `[id]`):** manager-scoped
  (`requireManagerForSite` — NOT the ADR-0037 D7 activation gate). GET lists events
  or (`?view=throughput`) the derived series; POST creates; PATCH edits; DELETE
  soft-voids.
- **UI (`/dashboard/[site]/equipment`):** English-first office surface, green/black
  palette, `onClick` handlers (no `<form>`, hard rule #10). Trend chart (units/day
  bars + 7-day mean line + red downtime bands + pocketcoil overlay), monthly-cost
  bars, CSV export, and an event entry row + audited log with soft-void. Plus the
  launcher **Equipment** tile (manager+) and the site-dashboard tile.
- **Docs:** operator guide `docs/operator/equipment.md`; ADR-0044 post-acceptance
  implementation notes.
### Added — 2026-07-05 (ADR-0045 — P5 ops ledger + Updates digest + contact routing)

- **ADR-0045 (P5).** Three of Kelsey's residual functions become thin, audited
  surfaces over existing machinery (no new pipeline, no new container): a
  meeting-notes + task-follow-up ledger, a Vision-drafted / human-sent DR3 Updates
  digest + board pack, and website contact-form routing. Everything human-sent stays
  human-sent — Vision never impersonates Morena/Bethany.
- **Schema (one additive migration `20260711_ops_ledger_intake`, sorts after
  `20260709_alert_recipients` and the parallel ADR-0044 `20260710_`; clean-replays on
  empty PG16):** four enums (`OpsTaskStatus`, `OpsTaskSource`, `UpdateDigestStatus`,
  `UpdateDigestKind`) + five tables — `ops_notes`, `ops_tasks` (source
  manual/meeting/contact_form, `note_id` FK), `update_digests` (draft/finalized, no
  send column), `contact_intakes` (visitor-PII columns), `contact_routes` (seeded
  idempotently in-migration: `tour*` → rick.albritton@, `*` → morena.gomez@). Sibling
  FK columns (`site_id`, audit-actor cols) are bare DB-level constraints per the
  ADR-0040/0041/0042 precedent; the two intra-block relations (`ops_tasks.note`,
  `contact_intakes.task`) carry Prisma relations.
- **Ledger (`src/lib/ops/`, TDD):** notes + tasks services with hard-rule-#2 reach
  (site rows site-scoped; `site_id = NULL` rows org-wide, admin/all_sites only),
  the meeting → action-items motion (one note + N tasks in one transaction), audited
  status transitions, and `dueSummaryForSite` (overdue / due-today). Dashboard tile
  + `/dashboard/[site]/ops` surface (notes list/editor, task queue with filters). The
  ADR-0043 daily digest gains a second **Follow-ups due** section and now sends when
  findings OR due tasks exist (a quiet day still sends nothing).
- **Updates digest + board pack (`src/lib/ops/update-digest.ts`, D2):** weekly draft
  on the Monday tick + board pack on the 2nd-Wednesday-and-preceding-Monday cadence
  (`digest-calendar.ts`, pure, TDD incl. month/year edges), composed from
  closes/movement/open-findings/completed-tasks and equipment events via an injected
  provider with a documented **absent-table fallback** (ADR-0044 equipment table not
  in this worktree — see MERGE-WIRING note). Review surface `/dashboard/ops/digests`
  (admin/all_sites): markdown edit, audited finalize, copy-ready HTML + copy button.
  The module has **no mail path** (a test scans the source and fails on any send).
- **Contact intake (`src/lib/intake/`, D3):** `POST /api/intake/contact` — public,
  fail-closed shared-secret (`x-intake-token`, absent env → 503), honeypot, in-memory
  per-IP rate limit, zod validation; routes via `contact_routes` (first active match,
  `*`-suffix glob) → creates an `ops_task` + `sendSystemEmail` to the routed address.
  PII discipline: name/email/phone never logged (row ids only; log-absence test).
  Middleware exemption `/api/intake/` + `public-paths.test.ts` case. `.env.example`
  gains `INTAKE_TOKEN`.
- **Docs:** operator runbook `docs/operator/ops-ledger-and-intake.md` (incl. the WP
  form wiring), ADR-0045 post-acceptance notes.

### Added — 2026-07-04 (ADR-0043 — P3 rate alerts + missing-record detection)

- **ADR-0043 (P3, first post-P2).** Early warning before MRC computes the official
  numbers: recycling/recovery rates and missing daily records become four new check
  codes on the existing ADR-0039 audit engine (same nightly sweep, same findings
  lifecycle, same `audit_check_config` thresholds, same review surface) — plus two
  dashboard rate tiles and one daily digest email. No new pipeline, no new container.
- **Schema (one additive migration `20260709_alert_recipients`, sorts after
  `20260708_cor_certificates`; clean-replays on empty PG16):** four `AuditCheckCode`
  enum values (`r1_recycling_rate`, `r2_recovery_rate`, `m1_missing_close`,
  `m2_missing_snapshot`) + `alert_recipients` (digest roster, `active` toggle,
  admin-editable) + `alert_digest_logs` (the `(site, digest_date)` idempotency
  ledger). Recipients seeded idempotently: Morena + Janette → Woodland, Rick →
  Eugene (emails from `prisma/seed/users.csv`).
- **Rate computations (`src/lib/rates/`, pure, TDD):** `recyclingRate` (by weight —
  non-`trash` outbound ÷ total; `trash` counted DISPOSED conservatively pending
  Addendum B10-5, so the alert fires early, never late; landfilled units × the
  55-lb `unit_weight_estimate` carry an `estimated` marker) and `recoveryRate` (by
  units, renovation whole-units credited). Both return
  `{ rate, numerator, denominator, components, estimatedInputs }`; a zero
  denominator yields a typed no-data result — never `NaN`, never a throw-through.
- **Four checks (`src/lib/audit/comparators/`, registered exactly like C1–C7):**
  R1/R2 grade the rolling ~9-month rate against `floor + margin` (CA 75 / OR 70,
  warn +3 pts · high +1 pt — all data in `audit_check_config`), window-normalized
  so a persisting low rate UPDATEs one finding instead of duplicating. M1 flags a
  business day (site-calendar-aware via `site_holidays` + weekend logic) with
  inbound activity but no daily close past a 1-business-day grace; M2 flags no
  physical snapshot within 35 days. R-findings link any concurrent open M-finding
  ids into their detail (explain-don't-flag: a low rate over a data gap is likely
  data, not operational).
- **Dashboard (`/dashboard/[site]`):** two site-scoped rate tiles — current rolling
  rate vs floor, trend arrow vs the prior equal-length window, an `estimated` badge
  when the 55-lb estimate contributed; the whole tile links into the site audit
  queue filtered to the R-check.
- **Digest (`src/lib/audit/alert-digest.ts`):** rides the existing daily-report
  cron tick (the internal route runs it after the production-report send) — one
  SVdP-shell email per site per day, ONLY when open R/M findings exist, to the
  `alert_recipients` roster via `sendSystemEmail` from `dr3-vision@svdp.us`,
  idempotent through `alert_digest_logs`. A total delivery failure pages
  `dr3-vision-system` (fingerprint `alert-digest-failed:<site>`, 6-h cooldown); a
  healthy send is silent; ntfy is otherwise untouched (hard rule #5).
- **Operator doc:** `docs/operator/rate-alerts.md` (editing thresholds via
  `audit_check_config`, editing recipients, what the tiles mean, the estimate
  caveat).
- **Deviation from the ADR (documented):** the digest rides the existing daily-report
  tick, which fires at each site's `send_time_pt` (18:00 PT today), not the 07:00 PT
  the ADR assumed — there is no separate 07:00 tick and the ADR mandates no new
  container. The dedup ledger keeps it to one email per site per day regardless.

### Added — 2026-07-04 (ADR-0042 — COR generator: Exhibit 5 pre-fill + human-signs-always boundary)

- **ADR-0042 COR generator (P2, third of three).** Generates the monthly CA
  Certificate of Recycling, Employment and Inventory (Exhibit 5) with every number
  pre-filled from provable Vision data — a human reviews, enters the FT/PT split,
  and **signs the printed copy** (Vision never auto-certifies; the rendered
  signature block is empty). CA-only: an Oregon site gets a typed error / 404 (no
  Exhibit 5 exists there).
- **Schema (one additive migration `20260708_cor_certificates`, sorts after
  ADR-0041's `20260707_…`; clean-replays on empty PG16):** `cor_certificates`
  (immutable-versioned artifact with a `supersedes_id` chain — draft regenerates
  freely, finalized is immutable, corrections are new versions) + `cor_site_config`
  (site-scoped signer) + enum `CorStatus`. `site_id` FKs are DB-level (migration),
  keeping the ADR block self-contained (no back-relation on `Site`), mirroring
  ADR-0040/0041.
- **Service (`src/lib/cor/`, TDD):** `prefill.ts` pre-fills the three numbers with
  provenance — inventory = the ONE pool-aware running balance (ADR-0037 D6) as of
  month-end + anchor-snapshot ref + reconcile delta (`inventory_source`); headcount
  = the month-end daily-close totals + the full month series (`headcount_source`),
  the FT/PT split entered by the preparer at review with the pre-fill retained.
  `lifecycle.ts` finalize / supersede / void mirror the ADR-0041 immutability
  discipline (manager-of-site or admin; audited). A **pre-render reconcile tripwire**
  (ADR-0033 style) recomputes inventory via the one balance function and refuses on
  mismatch with both numbers, in both finalize and PDF render.
- **Render (D3):** internal loopback-guarded print route `/internal/cor-pdf/[id]`
  (added to the middleware public-paths allowlist + its regression test — the
  mandatory ADR-0036 lesson) rendered to PDF via the bonus-PDF Playwright pipeline
  FROM the stored row, stored to R2 under `cor/`. The **signature block renders
  EMPTY** — Rick prints, signs, submits.
- **UI (D4):** `/dashboard/[site]/cor` (CA-only; hidden/404 for OR) — month picker,
  the three numbers with drill-down (inventory → balance ledger + snapshot;
  headcount → the daily-close series), FT/PT entry, display-only capacity banner,
  version diff, penalty-of-perjury finalize confirmation, print-and-sign download.
- **Observability (D5):** generation / finalize / supersede / reconcile-refusal log
  with certificate id / month / site / actor; typed errors carry the numbers. No PII.
- **June acceptance fixture (§7-b):** `prefill.test.ts` reproduces the Woodland June
  2026 inventory of **4,062** from the balance function's own semantics.
- **Config choice (D2.3):** signer implemented as a simple site-scoped `cor_site_config`
  row (Rick Albritton / "Transportation Manager"); the title is flagged **TBC with
  MRC** (`docs/QUESTIONS.md` Q-5) — a one-row edit to confirm, never a code change.

### Added — 2026-07-04 (ADR-0041 capture half — collection events, OR counts, DR3# sequences)

- **ADR-0041 capture half (P2; the invoice-engine half ships separately).** Closes the
  two capture gaps the invoice math needs — collection events and the DR3#
  document-number sequence — plus Oregon collection-site counts. **Schema (one
  additive migration `20260706b_events_and_sequences`, sorts after ADR-0040's
  `20260706_…` and before the engine half's `20260707…`; clean-replays on empty
  PG16):** three new tables — `collection_events` (daily-log Events tab: freight,
  driver/labor hours + wages, mileage, per diem, misc — money in cents, dates
  `@db.Date`), `or_collection_site_counts` (Oregon monthly per-location unit counts),
  `document_sequences` (per-`(site, sequence_code)` atomic counter) — plus a nullable
  `inbound_loads.dr3_number` column. FK constraints are DB-level (migration) so the
  capture block stays self-contained (no back-relation fields on the sibling-touched
  `Site` model), mirroring ADR-0040.
- **Collection events (`src/lib/events/service.ts`, TDD):** create / list /
  update-before-lock. **Wages are stored as entered**; the B5 rules (`driver_hourly`,
  `general_labor_hourly`, `per_diem_nightly`, via the ADR-0037 program-rule resolver)
  only DEFAULT blank wages from `hours × rate` — deviation is derivable, never flagged;
  a missing rule leaves the wage null rather than blocking capture. **Mileage is
  captured twice:** `mileage` (informational miles) + `mileage_cents` (the billed
  dollars that feed the §3.1 B8 event total); freight is a distinct B8 term.
  `EventCostRow` (`src/lib/events/types.ts`) + `eventMiscCents` are the cross-agent
  seam the invoice engine codes against.
- **Oregon collection-site counts (`src/lib/events/or-counts.ts`, TDD):** Eugene-scoped
  create / list / update-before-lock; a non-Oregon site is refused with a typed
  `JurisdictionNotAllowedError`. The $2.25/unit rate stays in `state_program_rules`;
  no invoice math here (the engine half consumes at merge).
- **DR3# issuance (`src/lib/events/sequences.ts`, TDD + real-DB concurrency proof):**
  `issueDocumentNumber` hands out a per-site number via a single atomic
  `UPDATE … RETURNING` (row-lock serialized; a 64-way concurrent test against Postgres
  yields 64 unique contiguous numbers). Woodland-style (CA) inbound loads get a
  Vision-assigned DR3# at the office **verify** step (inside the verify transaction,
  so a failed verify rolls the counter back); Eugene (OR) gets none; **Material # is
  MyMRC-owned and never issued by Vision**. Trigger is `jurisdiction == california`
  with a `TODO(B10-6)` to become a per-site config flag.
- **Manager surfaces:** `/api/manager/[site]/events` (+ `[id]`) and
  `/api/manager/[site]/or-counts` (+ `[id]`), and two new tabs (**Collection events**,
  **OR collection counts**) on the loads/inventory page — admin-only behind the same
  ADR-0037 D7 activation gate.
- **Seed:** Woodland `dr3_number` counter seeded at a **safe-high `5000`** (> the June
  daily-log ceiling 4805). **⚠ Operator action before go-live: align `next_value` to
  the real current counter** (runbook: `docs/operator/events-and-sequences.md`).
  Eugene gets no counter.
### Added — 2026-07-04 (ADR-0041 — invoice generation, engine half)

- **Invoice engine (ADR-0041, P2; second of 0040/0041/0042).** Vision now generates
  what Rick assembles by hand from several spreadsheets — the six-invoice set with
  line-level provenance, immutable-once-approved versioning, Rick's approval gate, and
  the Great-Plains export boundary. Every number on an invoice is a query result with
  a `rate_ref` + `source` provenance trail (Rick's typo class, survey Q8, dies at the
  root). **Schema (one additive migration `20260707_invoice_generation`, clean-replays
  on empty PG16):** two new tables — `invoices` (six-kind enum with NO
  `or_processing_mid_month` by construction; `billing_month @db.Date`; `version` +
  `supersedes_id` self-chain; `status draft|approved|void`; `total_cents` DERIVED but
  stored for query efficiency with a service-layer Σ-lines invariant enforced on every
  write and re-asserted at approval) and `invoice_lines` (`line_code`, `quantity`,
  `rate_ref` jsonb, `amount_cents` incl. negatives, `source` jsonb, `position`).
  Site-FK is a bare DB-level constraint (self-contained block, mirrors ADR-0040).
- **Math (§3.1 verbatim, pure + TDD).** `generate.ts` composers: B6 processing
  (stripped_program × effective `processing_rate`), B7 incentives, B8 event misc
  (via the `EventCostRow` interface — INTEGRATION-PENDING on the sibling's
  `collection_events`), B15 = B6+B7+B8, B20 mid-month (1st–15th inclusive, Pacific
  calendar), B22 = B15 − B20 rendered as an explicit NEGATIVE offset line (the
  "$118,239 trade discount" artifact becomes an honest subtraction). B16
  transportation = per-load `resolveFreightCents` (ADR-0040, per-load ref in source)
  + event freight + fuel surcharge (`fuel.ts`, CA-only, missing-week = typed error)
  + Σ active `container_rental_sites`. OR: EOM-only, transportation with NO fuel line
  (structural guard, tested), collection-site count = manual lines (`source.manual`).
  Zero-guard: a 0¢ processing charge on nonzero units → typed `InvoiceZeroError`.
- **Trust gate + lifecycle.** Approval enforces the ADR-0039 `gateForWindow`
  (refuse-with-finding-codes; super-admin override with audited justification),
  the `can_manage_rates`-is-NOT-sufficient approver rule (manager-of-site or admin),
  and immutability (approved rows never mutate — corrections are a superseding new
  version). Draft regenerate voids the prior draft and takes the next version.
- **Renders + surfaces.** xlsx Summary (exceljs, processing + transportation kinds;
  commodity blocks excluded per D5) + neutral `invoice_export` JSON (frozen v1
  contract) as the GP boundary. Routes `/api/manager/[site]/invoices` (list/generate)
  + `/[id]` (detail w/ inline gate findings + prior-version diff) +
  `/[id]/{approve,void,supersede,export}`. Manager UI at
  `/dashboard/[site]/invoices` (list/generate + line drill-down to source rows,
  approve-with-confirmation). D6 structured logging on every path; no PII in lines
  or logs.
- **INTEGRATION-PENDING (wired at merge with the CAPTURE half):** the events (B8 /
  event-freight) leg — `event-leg.INTEGRATION-PENDING.ts` (ts-nocheck, excluded from
  tsc/eslint/vitest) maps `collection_events` → `EventCostRow`; until wired,
  generation prices events at 0¢ with `source.pending = 'events-integration'` (never
  silently absent).

### Added — 2026-07-03 (ADR-0040 — billing rate infrastructure)

- **Billing rate infrastructure (ADR-0040, P2; first of 0040/0041/0042).** Puts every
  rate the invoice layer needs that isn't already in `state_program_rules` into
  effective-dated tables so ADR-0041 invoicing becomes pure computation. **Schema
  (one additive migration `20260706_billing_rate_infrastructure`, clean-replays on
  empty PG16):** four new tables — `transport_rate_tiers` (freight ZONE table,
  jurisdiction `CA|OR`, mileage band → flat `rate_cents`, effective-dated),
  `account_haul_rates` (per-account freight override, FK→sources, effective-dated),
  `container_rental_sites` (monthly trailer rentals, FK→sites/sources, `active`,
  effective-dated), `fuel_prices` (`week_of @db.Date UNIQUE`, `usd_per_gal
  Decimal(5,3)`, source `eia_api|manual`, `fetched_at`) — plus `users.can_manage_rates`
  (scoped rate-write flag). FK constraints are created at the DB level (migration) so
  the ADR-0040 schema block stays self-contained (no back-relation fields on the
  sibling-owned `Source`/`Site` models).
- **Seeds:** the CA freight zone table (7 tiers, effective 2026-01-01) is seeded;
  `account_haul_rates` and `container_rental_sites` seed **empty by design** (Rick
  populates from the workbook after confirming current values — seeding contested
  numbers would launder a discrepancy into "truth"); **no OR tiers** are seeded (the
  freight resolver returns a typed error for OR until they exist).
- **Money-path libraries (`src/lib/billing-rates/`, all TDD):** `tier-validation.ts`
  (a proposed tier set must be contiguous-from-0, non-overlapping, no gaps — typed
  problems name the offending rows); `freight-resolver.ts` (`resolveFreightCents` —
  account override → tier by `Source.canonical_mileage` → typed
  `FreightUnresolvableError`, with provenance ref for the retro-audit; never a silent
  $0); `fuel.ts` (Monday-of-week normalization, `price > $5.05` trigger predicate,
  `(price/mpg)×miles` surcharge, typed `MissingFuelPriceError`; OR guarded by the
  existing `RuleStructurallyDisallowedError`); `eia.ts` (EIA API **v2**
  `petroleum/pri/gnd` weekly West-Coast PADD-5 ULSD fetch; **fail-open** — absent
  `EIA_API_KEY` never crashes).
- **Weekly fuel fetch:** `scripts/fuel-price-cron.mjs` (thin Pacific daemon, Tue 06:00
  PT) → internal route `/api/internal/billing/fuel-fetch` (loopback-guarded; **added
  to `public-paths.ts` + its test on day one** per the ADR-0036 lesson) → upserts
  `fuel_prices` (manual entries never overwritten; a fetch failure pages
  `dr3-vision-system` fingerprint `fuel-fetch-failed`, success silent). New compose
  service `fuel-price-fetch`; `EIA_API_KEY` wired fail-open in `app` env +
  `.env.example`.
- **Scoped rate-write access (D5):** `users.can_manage_rates` grants writes to the four
  rate tables ONLY (never any admin power — enforced by construction:
  `requireAdmin` checks role, the flag is never in the session and is read fresh from
  the DB in `requireRateManager`). Grantable from `/admin/users` (mirrors the
  `all_sites` toggle, manager-only). Admin rate-table CRUD under
  `/api/admin/billing-rates/*` (write = admin|can_manage_rates, read = manager+); every
  write emits an audit row + structured log (actor, table, before→after).
- **Variance report (D6):** `/dashboard/billing-variance` + CSV export
  (`/api/manager/billing-rates/variance?format=csv`) — per trans-charge source,
  tier-now vs tier-last-billed, per-haul delta, monthly leakage. Last-billed history
  reads through a provider seam; until the ADR-0039 audit-engine workbook staging
  lands the report shows an honest empty state (tier-now only) with a TODO banner.

### Added — 2026-07-03

- **Loads & inventory foundations (ADR-0037, P1 groundwork; reconciled to mission
  Addendum B).** Takes the loads/inventory/commodity layer from built-but-dormant
  toward production, CA-first, in the **Addendum B** shape (operator-directed,
  2026-07-03; docs/QUESTIONS.md Q-4 ANSWERED). **Schema (one additive migration
  `20260703b_loads_inventory_foundations`, clean-replays on empty PG16):** five new
  tables — `state_program_rules` (effective-dated rate/rule table; rates are DATA,
  never code), `consumer_dropoffs` (CA CIP drop-offs, with a
  `kind` incentive|unpaid|illegal), `outbound_materials` (commodity × sub-category —
  renovation folds the old renovator channel in), `landfilled_units`,
  `processed_units_daily` (the daily close) — plus a `source_aliases` table and
  `sources` flags (`is_non_program`, `is_trans_charge`, `canonical_mileage`),
  `inbound_loads` extensions (`retrac_id` indexed, `slip_number`, `transport_charged`,
  `freight_cents`, `fuel_surcharge_cents`, `program_unit_count`,
  `non_program_unit_count`), `site_inventory_snapshots` extensions (`snapshot_kind`
  physical|computed, `reconciled_delta`, `source`), and `LoadSourceType` + `event`.
  `outbound_materials.commodity` is the **daily-log 9** (`trash, toppers, foam, metal,
  wood, cardboard, plastic, shoddy, cotton`), with `sub_category`
  (renovation|baled|shredded) + nullable `whole_units`/`program_units`/
  `non_program_units` on renovation rows. `processed_units_daily` carries
  `stripped_program`/`stripped_non_program`, `saved_units` (captured, EXCLUDED from
  inventory math — B10-2 open), and daily-close metadata (`material_ticket_number`,
  `employees_count`, `processors_count`, `pocketcoil_estimate`). All ids TEXT; money
  integer cents; unit counts Decimal(7,1). Idempotent `state_program_rules` seed
  (Addendum B5): CA processing effective-dated 2025=1600¢/2026=1650¢/2027=1700¢, OR
  processing 1700¢, OR satellite 225¢, CA collector_incentive 300¢ cap 5/day, CA
  fuel_surcharge formula-driven with a $5.05/gal trigger — **never seeded for
  Oregon** — plus CA driver_hourly 12500¢, general_labor_hourly 9000¢,
  per_diem_nightly 27500¢, and `unit_weight_estimate` {lbs:55, estimate_only} both
  sites. No mattress/foundation categories anywhere; no DR3#/Material# sequence
  issuance yet (B10-6 open).
  **Libs (TDD):** `program-rules/resolver.ts` — strict effective-date resolver; OR
  fuel surcharge structurally disallowed at BOTH layers (never seeded AND the
  resolver throws `RuleStructurallyDisallowedError`, reading site jurisdiction, not
  hardcoding ids); fuel computation refuses (typed error).
  `dropoffs/incentive.ts` — pure per-person-per-day cap function (cap on UNITS paid;
  incentive kind only). `inventory/running-balance.ts` — the ONE shared pool-aware
  balance `End = Start + Inbound − Stripped − WholeUnitsSold − Landfilled`
  (WholeUnitsSold reads renovation-sub-category outbound; baled/shredded never
  subtract; saved excluded) + `reconcilePhysicalCount` (records
  `reconciled_delta = physical − computed` with an audit row). `loads/verify-gate.ts`
  — server-side enforcement that a load cannot reach `verified` unless
  `program + non_program == total_units`, with the DEFAULT split derived from the
  load's source `is_non_program` flag (manager override wins, B7).
  `loads/processed-units.ts` — daily close derives whole-units-sold + landfilled
  from the day's renovation outbound + landfilled rows for confirmation (never
  entered twice). **Surfaces:** super-admin `/admin/processed-units` daily close
  (stripped split + saved + close metadata; close writes audit; post-close edits
  blocked → amendment path); admin-gated manager `/dashboard/<site>/loads-inventory`
  CRUD-lite for drop-offs / outbound (commodity × sub-category) / landfilled + a
  running-balance readout; all site-scoped, `onClick` handlers (no `<form>`), audit
  row in the same transaction as every mutation. Drop-off `person_name` is CIP PII
  (Exhibit I / ADR-0010) — kept off every export. New surfaces linked from the
  dashboard tile matrix but **admin-only for now** (ADR-0037 D7 activation gate — the
  manager audience opens once the restore-drill + off-box-backup ops gates close).
  **Investigation findings (1a/1b):** (1a) there was **no** verify action on `main`
  at all — `submitted → verified` existed only in the load-service state table with
  no implementation, so the new columns are the persistence and this build adds the
  gate; (1b) `processed_units_daily` is a NEW site-level billing record, distinct
  from the ADR-0030 daily production total (a query over `bonus_daily_entries` +
  adjustments) — it does not duplicate the payroll tables and does not touch payroll.
  **Reconciled to Addendum B** (PR #47, workbook reverse-engineering): dropped
  `renovator_shipments` (folded into `outbound_materials.sub_category = renovation`),
  re-based the commodity taxonomy to the daily-log 9, added `sub_category` +
  whole-unit pool columns, `consumer_dropoffs.kind`, `LoadSourceType` + `event`,
  site-driven program-ness (`sources` flags + `source_aliases` + verify-gate
  default), the restructured daily close (stripped + saved + metadata; whole-sold +
  landfilled derived), the `End = Start + Inbound − Stripped − WholeUnitsSold −
  Landfilled` balance, and the Addendum B5 rate seeds. Still open per B10: outbound→
  invoice block mapping (B10-5), `saved_units` semantics (B10-2), DR3#/Material#
  sequences (B10-6), CA fuel COMPUTATION (P2). ADR-0037 "Post-acceptance revision —
  Addendum B" itemizes every change vs the accepted text. Operator guide:
  `docs/operator/loads-inventory-foundations.md`. (ADR-0037)
- **MyMRC ingestion rebuild — JSON transport, mirror tables, loud failure (ADR-0038).** The MyMRC feed (0 rows because the old DOM scraper broke silently twice — most recently landing logged-out on a 404 and reporting "ok") is rebuilt on the Salesforce **Aura/JSON** transport. New migration `20260704_mymrc_mirrors` adds four additive tables: `mymrc_hauls_mirror`, `mymrc_processed_mirror`, `mymrc_outbound_mirror` (raw audit-evidence mirrors keyed by Salesforce record id, with `external_*_id` UNIQUE, full `payload` jsonb, and first/last_seen/disappeared/detail_fetched lifecycle) and `mymrc_sync_runs` (per-site-per-feed run ledger, status `ok|auth_failed|contract_drift|error`). New `src/lib/mymrc/`: `portal-client.ts` (the ONLY transport — Playwright login + in-page Aura interception; typed `AuthFailedError`/`PortalContractDriftError`; **hardened `isLoginPage()`** that catches the 404/logged-out shell), `mappers.ts` (JSON record → mirror rows; DST-correct Pacific parse of `Docking_Appointment_Time__c`), `sync.ts` (one run per site per feed: list → mirror upsert with disappeared detection → bounded ≤3 detail pass → run-ledger row ALWAYS, incl. on throw; **zero-anomaly** rule = 0 listed where the last success listed >0 ⇒ error), and `ntfy.ts` (self-contained `dr3-vision-system` pager with per-fingerprint dedup). Hauls also feed `expected_loads` via the existing upsert, now with **source=manual overwrite protection** (operator/manual rows — any non-`H-` id — are never scrape-cancelled). Deadman (no successful run >26h) pages per tick. The old `parser.ts` (HTML) + `scrape.ts` were deleted and replaced by fixture-tested JSON mappers (fixtures captured LIVE 2026-07-03, person names redacted, under `src/lib/mymrc/__fixtures__/`). Transport ladder decided empirically = in-page interception (#2); raw fetch-replay (#1) proven viable but deferred (fwuid-fragile) — see the ADR post-acceptance notes. The `mymrc-scrape` compose service is rebuilt but stays profile-gated (`mymrc`); enabling is an operator action per the new `docs/operator/mymrc-ingestion.md`. A green run with no data is now impossible by construction. (ADR-0038)
- **Survey daily reminders + campaign auto-close (ADR-0036).** For every OPEN survey campaign, a new 09:00 America/Los*Angeles daemon (`scripts/survey-reminder-cron.mjs`) POSTs an internal, loopback-guarded route (`/api/internal/survey/reminder-tick`) that sends **one reminder per day** to each still-unsubmitted invite until it completes, then **auto-closes** the campaign once the last response lands. Reminder copy is tiered on the invite's live state: opened-with-saved-answers ("your progress is saved" → \_Finish your survey*), opened-but-empty (friendly nudge → _Open your survey_), and sent-but-never-opened (original subject + a "resending in case it got buried" line). A 20h DB gate (`survey_invites.last_reminder_at`/`reminder_count`, additive migration `20260703_survey_invite_reminder_tracking`) makes reminders idempotent — a restart or slightly-early fire never double-sends, and a no-op fires cleanly when no campaign is open. Auto-close closes under a system actor (`actor_label: 'system:survey-reminder-cron'`), fires a `dr3-vision-system` ntfy (fingerprint `survey-campaign-autoclosed:<id>`), and does NOT run the export — the admin Export button still works after close. Drafts do not block auto-close; approved/sent/opened invites do. Reminders are unbounded by design (operator directive) — stop them by closing the campaign in the admin UI or `docker stop dr3-vision-survey-reminder`. New compose service `survey-reminder` (no `db.env` — the daemon reads nothing). The invite + three reminder tiers now share one branded email shell. (ADR-0036)

- **3-way audit engine + Audit Workbench + retro-audit (ADR-0039).** The third P1 ADR. Compares three structurally-independent legs — Vision operational data (ADR-0037), MyMRC mirrors (ADR-0038), and billing (P2 / historical workbooks) — via pure comparators, so no leg feeds another. New tables (migration `20260705_audit_engine`, additive, clean-replays standalone): `audit_findings` (fingerprint UNIQUE, status/cause_category enums, lifecycle), `audit_check_config` (per-check tolerance/severity DATA not code — seeded defaults incl. C3 EOD+1 grace and the C4 45-day vendor window), `workbook_imports` + `workbook_import_rows` (retro-audit staging with tab/row/col provenance), and the `audit_runs` ledger. **Comparators C1–C7** (`src/lib/audit/comparators/`) are pure `(window, legA, legB, config) → Finding[]` functions with distinct finding kinds (missing_counterpart / value_mismatch / date_mismatch): C1 inbound, C2 processed, C3 outbound (EOD+1 grace), C4 billing basis, C5 program/non-program conservation (passes Rick Q11's 150P+25NP-legal / 151P-illegal worked example), C6 inventory continuity (Addendum B §B4 equation + the Friday→Monday / DAY6 roll-break class), C7 business-day deadline clocks (3d inbound / 1d processed / 3d outbound-from-EOD, reusing `compliance.addBusinessDays`). **Findings lifecycle**: upsert-by-fingerprint (stable across runs + windows), last_seen refresh, auto-resolve when legs agree, auto-reopen on recurrence, manual acknowledged/resolved/not_an_issue transitions with cause_category + note — every transition audited in the same transaction (append-only, hard rule #6). **Retro-audit**: an admin uploads a historical monthly workbook (`exceljs` added — the repo had no xlsx lib; papaparse is CSV-only); the parser tolerates ≥3 template generations and the Summary-recompute check reproduces the §4.1 sum-range drift — recomputing every Summary figure from the workbook's own detail rows and flagging the rows the template's SUM range clipped (the fuel-rows-71–130 "money already dropped" class, caught by a synthetic fixture). Site names resolve through an alias interface; unresolvable names emit an `unresolved_site` finding, never a dropped row. **Nightly sweep**: thin 02:30 PT daemon (`scripts/audit-sweep-cron.mjs`, `redirect:'manual'`) → internal loopback-guarded route (`/api/internal/audit/sweep`) with the middleware exemption added on day 1 (`/api/internal/audit/` in `src/lib/public-paths.ts` + regression test — the ADR-0036 lesson); it writes a run record and pages `dr3-vision-system` only on sweep failure. New compose service `audit-sweep`. **UI** (`/dashboard/[site]/audit`, site-scoped, English-first office surface): findings queue with check/status/severity filters, per-finding expected/actual JSON + provenance + classify/act controls (onClick, not `<form>`), and a Workbench tab rendering three rollup frames from a typed provider + drill-down wiring points. **Billing trust gate** (`src/lib/audit/billing-gate.ts`): pure `gateForWindow` + audited super-admin override for P2 to consume. **Integration complete (2026-07-03):** the DB-fetch layer (`src/lib/audit/leg-fetchers.ts`, `buildRunChecksForWindow`) maps the merged ADR-0037/0038 Prisma models onto the comparator interfaces and is wired into the sweep, so the nightly sweep and a new **on-demand run** action (`POST /api/audit/<site>/run`, site-scoped manager/admin) audit the LIVE legs. Real sibling shapes forced adjustments: C7's "entered in MyMRC" instant derives from the matched mirror row (no Vision-side submit column exists); C2's program/non-program sub-checks degrade to the total-units comparison (the processed mirror carries no split); the outbound Material-# join is `external_materials_id` (the outbound mirror has no ticket/units columns and uses `shipment_date`); the inbound-load provenance is `manual` with the site name from the `source` relation (no scalar record-source). C5/C6 internal-invariant inputs derive per-day from the operational rows anchored at, and reusing, the ONE shared `computeRunningBalance` (cross-checked in tests); C6 gained an `npStripped` term to model Woodland non-program co-processing (`stripped_non_program`). The Workbench is **live** over the real tables (`dbWorkbenchProvider`) with honest empty-window states; historical workbook site names resolve through the `source_aliases`-backed resolver (canonical `Source.name` first, then the alias table; unresolved → `unresolved_site` finding). The audit `Commodity` type was corrected to the daily-log-9 (Addendum B §B1) to match the merged `OutboundCommodity` enum. (ADR-0039)

### Fixed — 2026-07-03

- **P1 observability & correctness hardening of the just-merged ADR-0037/0038 code
  (operator-directed: "make sure error logging is baked into everything so we can
  diag later easily").** One pass, TDD where behavior changed, all diagnosable now.
  - **Loud, structured logging on every non-2xx.** The `processed_units_daily`
    routes (GET/POST + `[id]/close`) now emit a request-correlated (`x-request-id`
    child logger) `warn`/`error` line — `{op, actor, site, status, reason}` — on
    every rejection incl. `forbidden`/`invalid_input`/`site_not_found`/service
    errors/unexpected 500s. `loadsErrorResponse` (the four manager resource families
    — dropoffs, outbound, landfilled, loads-verify) now logs the mapped error with
    `reason`/`status` (and an `error`-level line before re-throwing an unexpected
    500), threading a `{site, id, op, requestId}` context from every call site.
  - **MyMRC sync run correlation + failure logging (ADR-0038).** Each site+feed run
    mints a `runId` (crypto.randomUUID), prefixes every log line with it, and
    persists it on the `mymrc_sync_runs` row (new nullable `run_id`, additive
    migration `20260704b_sync_run_correlation`, clean-replays on PG16). The
    run-ledger write is now a real try/catch that logs the **error class** + run
    context (never a silent `.catch`); detail-fetch failures log the record's
    business `externalId` alongside the Salesforce record id. `upsertScrapedHauls`
    now logs (warn, once per run) the **deduped unmatched source/transporter NAMES**
    (a missing seed row → null FK) and returns them in `UpsertSummary`, not just
    counts.
  - **Verify-gate never defaults billing attribution blind (ADR-0037 D2).** When an
    inbound load has **no source** and no explicit split is supplied, `verifyLoad`
    now THROWS a typed `VerifyGateError('no_source_for_default')` (422) instead of
    silently crediting the whole load to the program (billed) pool; a source-driven
    default now logs `{loadId, defaulted:true, source flag}`.
  - **Daily-close negative-balance guard (ADR-0037 D6).** Closing a
    `processed_units_daily` day now computes the pool-aware running balance (the ONE
    `onHand`/`computeRunningBalance`) as of end-of-day; if either pool would go
    negative (an upstream inbound gap) it returns a typed 422 with the numbers —
    UNLESS `acknowledgeNegative: true` accompanies the request, in which case the
    close proceeds and the acknowledgment + balances are recorded in the close audit
    row (warn-and-confirm posture).
  - **Effective-dated rate resolution proven unambiguous (ADR-0037 D1).**
    `resolveProgramRule` now fetches all covering rows and throws a typed
    `AmbiguousProgramRuleError` (naming the tied row ids) when two rows share the
    winning `effective_from` — money math never coin-flips a rate. Legitimate
    supersession (distinct `effective_from`) is unaffected.
  - **Dropoff incentive failures fail loud + typed (ADR-0037 D3).** A missing
    `collector_incentive` rule (`NoActiveProgramRuleError`) is logged with
    `{site, date}` before re-throw; recovering prior paid units from a stored
    `incentive_cents` that no longer divides the rate now throws a typed
    `IncentiveComputationError` (500 with `{person, date, incentive_cents}` logged)
    instead of a bare `RangeError`.
  - **Efficiency (N+1 kills, behavior identical).** `listProcessedUnits` replaces
    per-row `deriveDailyOutflow` with two grouped aggregate queries over the date
    range (tests assert list == per-day-derive equivalence); `upsertScrapedHauls`
    replaces the per-haul `expectedLoad.findUnique` with one batched `findMany` +
    live map.
  - **Route-layer pagination clamp.** The manager list surfaces (dropoffs, outbound,
    processed-units) now clamp a client `?limit=` to `[1, 200]`, falling back to the
    default on absurd/non-numeric input, so no request can force an unbounded scan.
  - **Portal list completeness diagnostics (ADR-0038 D4).** The MyMRC Aura getItems
    payload carries no absolute record total (verified against the captured
    fixtures — only `hasMoreData`/`offset`), and `hasMoreData=true` is a NORMAL live
    state for large feeds, so a throwing count-guard would false-page every run;
    instead `extractListView` surfaces the `hasMoreData` window signal and the
    transport WARNs loudly when a list is windowed (disappeared-detection sees only
    that page), while the existing "no getItems action" / error-list-view / settle
    guards stand.
- **Survey reminder-tick was blocked by the auth middleware (ADR-0036 hotfix).** `/api/internal/survey/reminder-tick` was missing from the middleware public-path exemptions (only `/api/internal/bonus/` was listed), so the daemon's first 09:00 PT fire was 307'd to `/login` — and because `fetch` follows redirects by default, the login page's 200 made the tick log **success while sending nothing**. Three-layer fix: (1) the public-path predicate moved to `src/lib/public-paths.ts` (pure, edge-safe) with the `/api/internal/survey/` exemption added and a regression test over the whole exemption list (`src/__tests__/public-paths.test.ts`); (2) the daemon now uses `redirect: 'manual'` and treats any redirect or non-200 as a failure (a login 307 can never masquerade as success again); (3) response bodies in daemon logs are truncated to 300 chars (the failure had dumped a full HTML page). The route's own loopback/cf-connecting-ip + bearer guards are unchanged — the exemption only lets the session-less in-fleet caller reach them, same trust model as the bonus cron routes. After deploy the missed 2026-07-03 tick was re-fired manually (in-network POST), so the outstanding invites still got their day's reminder.
- **Pre-push gate (ADR-0033 / P0-4) no longer blocks deletion-only pushes.** `git push origin --delete <branch>` pushes no code, but the hook still ran the full tsc + payroll-suite gate — which blocked the 2026-07-02 stale-branch sweep on type errors from an unrelated stale generated Prisma client. The hook now reads the ref list git supplies on stdin and skips the gate only when EVERY pushed ref is a deletion (all-zero local sha); a mixed push (deletion + real ref) still gets the full gate. Regression tests in `src/__tests__/pre-push-hook.test.ts` cover deletion-only, empty-ref, mixed, and normal pushes.

### Fixed — Sprint 6

- **Migration ordering: clean-replay invariant (ADR-0035)** — `prisma migrate deploy` replays migrations in lexical directory-name order. On disk, `20260616_amendment_submission_group` sorted _before_ `20260616_amendment_workflow`, so a clean/DR replay ran the `ADD COLUMN submission_group_id` ALTER before the `CREATE TABLE bonus_amendment_requests` it depends on → `P3018 / 42P01 relation … does not exist`. The **live** DB was never affected (it applied them in the correct order: `_amendment_workflow` 2026-06-15 21:51, then `_amendment_submission_group` 2026-06-16 01:39). Renamed the directory to `20260616_amendment_workflow_submission_group` (byte-identical SQL — checksum unchanged), which provably sorts between `_amendment_workflow` and `20260617_daily_production_report`. Clean replay now applies all 16 migrations with `migrate status` up to date. The new `migrations` CI job (clean Postgres 16 replay) is the gate that caught this and now enforces the invariant. **Live ledger reconciliation required before next deploy** — single pure-rename `UPDATE _prisma_migrations SET migration_name='20260616_amendment_workflow_submission_group' WHERE migration_name='20260616_amendment_submission_group';` (1 row; no schema/data change); see ADR-0035 for sequencing.

### Added — Sprint 6

- **Operational intelligence survey system (ADR-0034)** — Vision-native survey for structured intelligence gathering across the DR3 team. New tables `survey_campaigns`, `survey_invites`, `survey_questions`, `survey_responses`. Public token-gated route `/survey/{token}` with no auth (token IS the access). Super-admin route group `/admin/operations/intel` for campaign management with per-invite approval gate and send confirmation interstitial that requires matching `confirmed_recipient_count`. Email send via existing M365 path, extended to support per-campaign sender display name, reply-to, and CC. SVdP-branded email shell matching the daily production report style. Idempotent seed pre-loads the DR3 Intel 2026-06 campaign with all 10 recipient packets (Bethany, Leisha, Shannon, Mary, Rick, Janette, Morena, Kelsey, Juan, Patrick) in draft status. Closing question "What are we missing?" appended to every packet. On campaign close, responses export as markdown to `docs/operations-intel/{slug}/` via the same ClaudeSync handoff mechanism used for sprint work. (#34)

### Fixed / Changed — Sprint 6 (survey launch hardening, 2026-06-23)

- **Public survey form (`/survey/[token]`)** — required-field validation now runs client-side: submitting with unanswered required questions no longer bounces the respondent off a bare server 422; the first gap is scrolled into view, focused, and every gap is outlined in red with an inline "required" note. Submit now opens a confirmation step before locking (irreversible action guard). Accessibility: inputs are associated with their prompt via `aria-labelledby`/`aria-describedby`, required fields carry `aria-required`/`aria-invalid`, radio/checkbox groups use `role="radiogroup"`/`role="group"`, and the save-status line is an `aria-live` region. A select question that reaches a respondent with no configured options now renders a clear empty-state instead of a blank gap (and does not trap the required gate). An `already_submitted` race now refreshes cleanly into the thank-you view.
- **Invite editor** — saving a packet with an empty prompt, or a `single_select`/`multi_select` with zero options, is now blocked client-side with a precise inline message (previously POSTed an invalid packet and surfaced a bare "save failed: 422"). Server error reasons are translated to human text. Added a Label|value hint under select kinds.
- **Campaign detail** — header now shows a status pill and a roster summary (invites / approved / submitted); the Send button explains why it is disabled and a hint guides the operator to approve first; Export/Close actions give typed success/error feedback that auto-clears; busy states are reflected on every action button.
- **Survey input legibility + mobile (post-launch hotfix)** — respondents reported the text they typed was nearly invisible. Cause: the `<input>`/`<textarea>` set no explicit `color`/`background`/`color-scheme`, so a device in dark mode (common on phones) painted the field text with a light system color, and `fontSize:14` triggered iOS zoom-on-focus. Fixed by setting explicit `color:#1a1a1a` (+ `-webkit-text-fill-color` to defeat iOS/autofill light text), `background:#fff`, and `colorScheme:'light'` on both text fields, bumping field text to `16px` (no zoom-on-focus, more legible), and adding a dark base `color` + `colorScheme:'light'` on the page `<main>` so inherited-color text (select-option labels, radios, checkboxes) is also high-contrast on the cream theme regardless of OS dark mode. Input behavior (value/onChange/aria) unchanged — no inputs broken; SurveyForm tests green.
- Added component tests for the survey-form required-gate + select empty-state and for the invite-editor validation guards. Full gate green (tsc, eslint, vitest, next build).
- **Admin survey preview now renders (2026-06-23)** — the invite-preview "Survey page" tab (`InvitePreview.tsx`) embeds the survey in a same-origin `<iframe src="/survey/{token}?preview=1">`, but a global `X-Frame-Options: DENY` in `next.config.js` forbade _all_ framing — including same-origin — so the iframe came up blank ("vision won't connect"). Fixed by adding a more-specific `/survey/:path*` header block that sets `X-Frame-Options: SAMEORIGIN` and appends `frame-ancestors 'self'` to the (otherwise identical) CSP, while every other route keeps the hard `DENY` via a negative-lookahead `source` so the global block never re-emits `DENY` onto the survey route. Verified against the _emitted_ response headers (not config intent) and with a headless same-origin iframe load. Separately, the survey page now SKIPS `markInviteOpened` when `?preview=1` is present, so an admin previewing a sent invite never flips its status to `opened` or stamps `first_opened_at`. New regression test asserts the resolved header blocks (`src/__tests__/next-config-headers.test.ts`).

### 2026-06-23 — Payroll incident resolved + enterprise P0 hardening

Resolved the 2026-06-22→23 Woodland P13 incident: the delivered payroll PDF was
always correct ($2,125.50, verified from R2 bytes); only the internal
`total_payout_cents` field was wrongly $0 (Decimal type bug). **Audited backfill**
0→212550¢ (audit_log row, fresh restic snapshot). Three root causes fixed
(`5192345`, `526f46d`). Four P0 guardrails added (ADR-0033, `6d14406`): payout
reconciliation tripwire, implausible-$0 delivery guard, loud payroll-failure ntfy,
and a pre-push/CI correctness gate. Enterprise-readiness gameplan + buildout
checklist: `docs/handoffs/2026-06-23-current-state-and-buildout-readiness.md`.

### 2026-06-23 — Payroll-correctness guardrails: reconciliation tripwire, zero-payout guard, loud failures, correctness gate (ADR-0033)

Four P0 enterprise-hardening guardrails closing the OUTER RING around the
payroll-critical path, all on top of the Decimal-lock fix below. No payout/period
data touched; no calculator math changed. **NOT deployed** — operator coordinates
deploy after the in-flight signature.

- **P0-1 — Reconciliation tripwire.** New invariant: for a `signed`/`paid` period,
  the recomputed grand total MUST equal the locked `total_payout_cents`. Pure
  logic in `src/lib/bonus/reconcile-payout.ts`; independent recompute + page in
  `src/lib/bonus/reconcile-fetch.ts`. Wired into `generateBonusPdf` (pre-upload)
  and `triggerPayrollDelivery` (pre-mail) so a mismatched PDF can never reach R2 or
  payroll. On mismatch → refuse + URGENT ntfy `payout-reconcile-mismatch:<monthId>`.
  Exact integer equality of the same computation → no false positives by design.
  This is the assertion that would have caught tonight's $0-lock-vs-$2,125.50-PDF
  disagreement.
- **P0-2 — Implausible-(zero)-payout delivery guard.** Predicate: block delivery
  iff `lockedTotalCents === 0` AND `recomputedTotalCents > 0`. A `$0` that AGREES
  with the entries (everyone sub-threshold, e.g. Timothy Elich 24 mattresses) is a
  real `$0` and is ALLOWED; a `$0` that DISAGREES is blocked + URGENT ntfy
  `payout-zero-suspected:<monthId>` for human confirmation.
- **P0-3 — Loud payroll failures.** ntfy pages added to previously log-only paths:
  signer unresolvable / no email (`signer-unresolved`), signature-request mail
  failed (`signer-mail-failed`), PDF generation failed for a signed period
  (`payroll-pdf-failed`), missing `pdf_storage_key` (`payroll-pdf-missing-key`),
  R2 unconfigured (`payroll-r2-unconfigured`), sign-route notify threw
  (`signer-notify-threw`). Per-fingerprint cooldowns. CONFIG-ABSENT (M365 unset)
  stays SILENT and fail-open — the app still boots without M365 (hard rule #5).
- **P0-4 — Correctness gate.** `.husky/pre-push` runs `tsc --noEmit` + the
  bonus/payroll vitest suite, blocking the push on failure, and SKIPS cleanly when
  `node_modules` is absent (the in-container deploy clone can still commit/push).
  `.github/workflows/ci.yml` runs `tsc` + lint + full `vitest run` + `next build`
  on push/PR (targets `ubuntu-latest`; self-hosted runner labels unconfirmed —
  switch `runs-on` if desired). This is the gate the original `total_payout_cents:
number` type-lie would have tripped.

Tests: `reconcile-payout.test.ts` (pure matrix), `reconcile-fetch.test.ts`
(recompute coercion + mismatch pages + zero-guard agree/disagree),
`payroll-delivery.test.ts` (P0-3 pages + pre-send blocking), and additions to
`signature-notifications.test.ts` (P0-3 signer pages, config-absent stays silent).
See `docs/adr/0033-payroll-payout-reconciliation-guards.md`.

### 2026-06-23 — Payroll-correctness fix: sign-time payout lock zeroed by Prisma Decimal

Confirmed payroll-correctness defect. When a bonus pay period reached `signed`,
the sign-time lock in `src/lib/bonus/signatures.ts` (the `if (fullySigned)` block)
passed each entry's `mattress_count` **raw** into `calculateMonthlyBonusCents`.
`mattress_count` is a `Decimal(5,1)` — Prisma returns a `Decimal` object, not a JS
number — and the calculator's `Number.isFinite()` guard rejects a non-number, so
**every entry contributed 0 and the period locked to `total_payout_cents = 0`**.
The on-screen / PDF / CSV paths coerce with `.toNumber()` and computed the correct
figure, which is why the screen showed a real bonus while the locked (and paid)
total was $0. Woodland period `9b3dc951-4c0c-4c2c-b68c-e3e7ac726211` (2026-06-09→22,
99 entries) locked **$0** but should be **$2,125.50 (212550 cents)** — verified by
reproducing the corrected formula against the live entries + active rule.

Why static typing didn't catch it: the `SignatureDb` structural type declared
`bonusDailyEntry.findMany` as returning `{ mattress_count: number }[]` (a type lie),
so `tsc` saw a number and the number-based mock in `signatures.test.ts` never
exercised a real `Decimal`.

**Fixes:**

- **Lock site:** coerce via a new `toCount()` helper before calling the calculator
  (`entries.map((e) => toCount(e.mattress_count))`), mirroring the `.toNumber()`
  coercion the on-screen/PDF/CSV paths already use so the signed total can never
  diverge from the displayed total. `SignatureDb.bonusDailyEntry` retyped to the
  truthful `DecimalLike` (`number | { toNumber(): number }`).
- **Calculator hardening:** `calculateDailyBonusCents` now THROWS `TypeError` on a
  non-`number` `units` (Prisma `Decimal`, numeric string, object) instead of
  silently returning 0 — a payout calc must never silently yield $0 from a type
  error. Existing numeric behavior is unchanged: genuine `NaN` / `Infinity` /
  negative / below-threshold numbers still return 0.
- **Regression tests:** `signatures.test.ts` feeds real `Prisma.Decimal` counts
  through the sign-time lock path and asserts the correct non-zero total (FAILS on
  pre-fix code: locks `+0`); `calculator.test.ts` asserts non-number input throws.

NOT deployed. **No payout / `bonus_pay_periods` data mutated** — the operator
re-triggers the recompute via the amendment flow once this fix ships.

### 2026-06-23 — Payroll-signing incident fixes: signer-notification + PWA stale-shell

Two confirmed defects from the 2026-06-22 payroll-signing incident (contributed
to a missed deadline). NOT yet deployed — held until payroll clears (a deploy
re-triggers the PWA shell swap).

**Defect 1 — signer notification resolved the WRONG signer (signers never emailed).**
`resolveSlotSigner` (`src/lib/bonus/signature-notifications.ts`) resolved the ops
signer by a legacy heuristic (`primary_site_id IS NULL`), which disagreed with the
authoritative `bonus_signature_chains` row used by the sign route and the month
page. Woodland's ops signer (Morena Gomez) has a non-null `primary_site_id`
(Woodland), so the null query returned nobody and she was **never emailed her
signature request** ("no email for the responsible signer; skipping", signer_id
null). Fix: resolve the signer from `getSignatureChain(siteId)` (the same source
`naturalSlotFor` / the month page / `signer-names.ts` use), then load that user by
id. Regression test added (ops signer with a non-null `primary_site_id` must still
be found + emailed). No payout/`bonus_pay_period` data touched.

**Defect 2 — PWA stale-shell stranded signers after a deploy (read-only error).**
`src/app/UpdatePrompt.tsx` (ADR-0027) only detected a waiting SW on `updatefound`
(navigation / ~24h browser cadence), so an open signer tab could keep serving the
stale read-only shell indefinitely. Hardened: poll `registration.update()` every
60s and on tab-visible; **auto-promote** the waiting worker silently when the tab
is hidden (safe — operator not mid-entry), keeping the explicit reload banner only
while the tab is visible. `skipWaiting:false` and the offline-queue caching are
unchanged. See ADR-0027 addendum.

### 2026-06-22 — DB backups + MyMRC portal-redesign login fix

**Backups (NEW — DB previously had NONE):** nightly encrypted Postgres backups to
Cloudflare R2 via restic — `scripts/dr3-pg-backup.sh` + systemd
`dr3-vision-pg-backup.{service,timer}` (03:45 PT, retention 7d/4w/12m/5y, AES-256).
First snapshot verified. RESTIC_PASSWORD (recovery key) → 1Password. See
`docs/operator/backups.md`.

**MyMRC:** MRC redesigned the Salesforce portal; the old scraper silently failed
(logged-out 404 parsed as "0 hauls ok"). Login selectors fixed + verified live, no
MFA (SELECTOR_VERSION 2026-06-22). Data pages moved/expanded (`/s/hauls`,
`/s/processed-materials`, `/s/outbound-materials`); parser rebuild + loads/inventory
ingestion handed off to claude.ai. See `docs/MYMRC-PORTAL-REDESIGN-2026-06-22.md`.

### 2026-06-22 — SVdP ad-hoc mail sender (scripts/send-svdp-mail.sh)

Added `scripts/send-svdp-mail.sh`: sends ad-hoc Vision email **from dr3-vision@svdp.us**
via Microsoft Graph, reusing the running app container Entra credentials, with To + CC
support (the in-app `sendSystemEmail` has no CC field). Vision is the Society of St.
Vincent de Paul — a separate org from BarnardHQ — so Vision correspondence must originate
from an @svdp.us identity; this is the sanctioned channel for one-off reports. Used to
re-deliver the Woodland June 1–8 reconciliation report to morena.gomez@svdp.us
(cc bill.barnard@svdp.us) from the correct org identity.

### 2026-06-20 — Reporting-only production adjustments, decoupled from bonus math (ADR-0032)

**Headline.** Woodland **production totals** (daily-report month-to-date and the annual year-over-year aggregate) now reflect the operator's true paper figures, **without moving any bonus/payout dollar**. The closed pay period 2026-05-26…2026-06-08 stays frozen at `legacy_total_payout_cents = 96475` ($964.75), byte-for-byte. Operator decision 2026-06-19 ("Option B": reporting-only, keep payroll frozen).

**Mechanism.** A new, additive table `bonus_reporting_adjustments` (migration `20260620_bonus_reporting_adjustments`) — one signed unit delta per site per day (`UNIQUE(site_id, entry_date)`, TEXT ids/FKs per convention). Chosen over a "phantom employee" (would leak — bonus paths don't filter `is_active`) and over a `reporting_only` column on `bonus_daily_entries` (would force a filter onto every bonus-dollar query; high blast radius). **No bonus-dollar read path queries this table**, so an adjustment is structurally incapable of reaching payroll math.

**Invariant.** Production-QUANTITY read paths INCLUDE adjustments; every bonus-DOLLAR read path EXCLUDES them. Wired the complete production-quantity set: `sumRangeOrNull` in `daily-report.ts` (covers MTD, prior-month, **and same-day-last-year** YoY); the annual page `totalMattresses` (new `annualAdjustmentUnits` helper in `aggregates.ts`); the annual CSV export (a single `"Reporting adjustment (ADR-0032, production-only)"` provenance row, mattress column carries the delta, bonus column `0.00`). Left untouched: `employeeHistory`, per-employee `annualTotals` rows, `pdf-data.ts`, the bonus-PDF page, and `current-period.ts` standings — all bonus dollars / per-employee.

**Launch-month load.** Five Woodland adjustments — 6/1 −4, 6/2 +13, 6/4 +694, 6/5 +653, 6/8 +451 (net **+1,807**). Reason recorded on each row: _"Launch-month backfill: missing-day production (6/4,6/5,6/8) / paper reconciliation (6/1,6/2); reporting-only, payroll frozen per operator 2026-06-19."_

**Proof (before → after).**

- Frozen closed-period payout `legacy_total_payout_cents`: **96475 → 96475** (unchanged).
- Annual 2026 bonus-dollar total for Woodland: **unchanged** (adjustments never enter it).
- Woodland June MTD through 2026-06-18: **9,067 → 10,874**; per-day 6/1→940, 6/2→695, 6/4→694, 6/5→653, 6/8→451.
- Annual 2026 production-quantity aggregate: **+1,807** (now includes the adjustments).

**Test.** New cases in `daily-report.test.ts` (MTD includes ±adjustments; same-day-last-year non-null on adjustment-only window; bonus-dollar totals invariant under a large adjustment) and `aggregates.test.ts` + `export.route.test.ts` (`annualAdjustmentUnits` year/site scoping; CSV provenance row present/absent/negative; export integration). Suite **928 green**; `tsc` 0; ESLint clean. Migration auto-runs on deploy.

### 2026-06-17 — Hotfix: per-employee history 500 on historical periods (ADR-0031 / ADR-0023)

**Bug.** Opening a processor's history (`/bonus/employee/[id]`) — newly prominent via the ADR-0031 standings drill-in — returned the generic error page ("The error has been reported…"). Root cause from the app log: `NoActiveRuleError: no active processor_bonus_rules row for site …`. `aggregates.ts` (`employeeHistory` / `annualTotals`) resolved each period's rule with the **strict** `resolveActiveRule`, but the ADR-0023 historical import seeded entries back to **Jan 2025** while the `processor_bonus_rules` table only goes back to **2026-01-01** (verified on prod: 27 Woodland periods pre-2026 with 3,092 entries). Any processor with 2025 entries threw and 500'd the whole page. The same class was already fixed for the historical-PDF path in ADR-0023; the aggregate views were missed.

**Fix.** `ruleResolver` now uses `resolveRuleForHistorical` (the ADR-0023 fallback): a pre-rule period resolves to the site's earliest rule instead of throwing; live periods still resolve strictly. One-line behavioral change; also un-breaks the annual aggregate for prior years. (The new current-period standings/banner were never implicated — they resolve only the open period, which always has a rule.)

**Test.** Failing-first regression in `aggregates.test.ts` reproducing the prod `NoActiveRuleError` (rule effective 2026-01-01 + a 2025 period with entries), now green; the rule mock was upgraded to honor `effective_date`/`end_date` so the fallback path is actually exercised. Suite **919 green**; `tsc` 0; ESLint clean; `next build` ok. No migration.

**Status (ADR-0031 set).** All three pieces — live standings + per-employee banner, canonical `Period N · <range>` labels, and this historical-rule hotfix — are shipped to prod (svdp-dev) and **operator-confirmed 2026-06-17** (Bill confirmed the history page loads).

### 2026-06-17 — Current pay-period standings (ADR-0031)

**Headline.** Adds a live, in-progress view of where every processor stands in the **open** bi-weekly pay period — the piece the cross-period history and closed-period reports never surfaced. Fixes the Reports "Per-employee history" card, which linked to the employee **roster manager** (`/bonus/employees`) and showed no bonus data: it now opens **"Current pay period — live standings"** (`/bonus/standings`).

**What you see.** Per active processor for the open period (e.g. _Period 13 · Jun 9–22_): **units so far · days qualified · days short of the minimum · bonus accrued**. "Days short" = a keyed day whose bonus is $0 because units didn't exceed the rule's daily minimum (Woodland: >50/day); `daysQualified + daysShort = days keyed`. Days with no entry count on neither side. The qualifying threshold is read from the effective `processor_bonus_rules` row, never hardcoded.

**Surfaces (the operator's "both").**

- `/bonus/standings` — new `force-dynamic` report: live all-processor table, name-sorted, each row drilling into that processor's full history. Same `tryBonusAccess` gate as the other bonus surfaces; Eugene + Woodland via `?site=`. "No open period" empty state when today falls outside every seeded period.
- `/bonus/employee/[id]` — now leads with a **Current pay period** banner (the four live metrics, marked _in progress_) above the existing YTD + last-12 + history.

**Service layer — `src/lib/bonus/current-period.ts`** (new, isolated, read-only). Resolves the period covering Pacific "today" by the daily grid's date-range contract, then tallies every keyed entry through the shared `calculateDailyBonusCents`, so standings can never diverge from the daily grid or the signed PDF (hard rule #3). `currentPeriodStandings(siteId)` returns all active processors (a processor with no keyed day yet shows at zero, so the full roster is visible); `currentPeriodForEmployee(siteId, employeeId)` is a focused per-employee query (correct for a since-deactivated processor; never loads the roster).

**Reports card.** "Per-employee history" → **"Current pay period — live standings"** pointing at `/bonus/standings`. The roster manager stays reachable from the `/bonus` landing ("Manage Employees"), so nothing is orphaned.

**History-table labels fixed (same ADR).** The cross-period history table on the detail page had labeled periods by calendar month (`monthLabel`, e.g. "June 2026"), a pre-cadence artifact — so two bi-weekly periods in one month rendered **duplicate** labels. Now a shared `src/lib/bonus/period-label.ts` is the single source of truth for the canonical `Period 13 · Jun 9–22, 2026` label, used by the standings table, the current-period banner, and the history table alike. `employeeHistory` emits `label` (full) + `shortLabel` ("Period 13", for the trend bar list); detail-page copy corrected ("Last 12 months" → "Last 12 pay periods", "Monthly totals" → "Per-period totals", "Month" column → "Pay period"). The PDF/email surfaces keep their own labels (separate concern, untouched).

**Gates.** New `current-period.test.ts` (8 cases) + a duplicate-label regression test in `aggregates.test.ts` + updated `BonusReports.test.tsx`. Full suite **918 green** (was 909); `tsc --noEmit` 0; ESLint clean; `next build` ok. No migration (read-only over existing tables).

### 2026-06-17 — Sprint 5: daily production report (ADR-0030)

**Headline.** Replaces Morena Gomez's manual 6 PM Pacific daily processing email for Woodland and adds the same automation for Eugene. Both sites are independently configurable from a Bill-only admin tile (`/admin/production-report`). Recipients, send time, subject template, and skip rules are all editable through the UI; every config change is audit-tracked. Email body includes per-employee mattress count + bonus dollars + total processed + total bonus paid + four comparison lines (same day last year, MTD, prior month same period, percentage delta).

**Migration `20260617_daily_production_report`:** three new tables — `bonus_daily_report_config` (per-site, unique on site_id), `bonus_daily_report_recipients` (child table, unique on (config_id, email)), `bonus_daily_report_log` (per-day idempotency, unique on (site_id, report_date)). Plus a new `is_super_admin` boolean column on `users`, defaulting false, with the seed flipping Bill to true.

**Seed:** Both sites enabled at 18:00 Pacific. Woodland recipients: bill, bethany, morena. Eugene recipients: shannon, bill, bethany, rick. Re-running the seed is idempotent (`ON CONFLICT DO NOTHING` on recipients; `ON CONFLICT DO UPDATE` on config).

**Service layer:**

- `src/lib/bonus/daily-report.ts` — pure aggregation. Per-employee bonus via `calculateDailyBonusCents` against the site's effective `processor_bonus_rules`. Date math handles leap years, year boundaries, and short-month clamping. Comparison totals return `null` on empty windows so Eugene's sparse history renders gracefully.
- `src/lib/bonus/daily-report-config.ts` — config + recipient CRUD with in-transaction audit logging. Email validation app-side (lowercase normalization, regex). Time validation accepts `HH:MM` or `HH:MM:SS`.
- `src/lib/bonus/daily-report-notifications.ts` — subject + HTML body rendering, per-recipient `sendSystemEmail`. Header reads "DR3 - {Site} Automated Production Report" + dated subtitle. Color-codes the pace delta (green up, red down). Conditional sections honor `include_bonus_dollars` and `include_comparisons`. **SVdP-branded** (operator request 2026-06-17): St. Vincent de Paul Society of Lane County palette from `svdp.us` — red `#a3151a` masthead with the white SVdP wordmark, gold `#ffcc69` accent, cream `#f7f3ea` panels. Table-based, inline-styled, ≤600px for Outlook/M365 fidelity. (Deliberately the SVdP parent-org palette, distinct from the DR3 green/black in-app brand.) Default subject tightened to `DR3 Daily Production Report — {site} — {date}`.
- **Math-correctness hardening (correctness audit, 2026-06-17):** floor each `Decimal(5,1)` entry consistently across per-line units, the bonus basis, and every range sum — so `totalToday` always reconciles with MTD and per-line bonus equals the signed payroll PDF (`month-list.ts` floors raw). Collapsed the redundant MTD double-query/`?? totalToday` fallback to a single range read. Masthead title is now `{Site} Daily Production Report` (DR3 led the subject + footer — no longer duplicated). Regression tests added (fractional reconciliation, tier-boundary bonus parity, MTD left boundary, pace-edge). Accepted limitation: month-end "pace vs last month" compares against the clamped prior-month window (informational; absolute totals authoritative).
- `src/app/api/internal/bonus/daily-report/test/route.ts` — loopback+bearer-guarded internal **test-send** (`POST { siteCode, to, date? }`); returns a clean 422 for a back-dated day with no active rule. Renders the production-identical email and sends to one address with a `[TEST]` subject prefix; writes **no** log row, so it never blocks the scheduled fire. Lets an operator preview branding/quality from the host without a browser session.

**Daemon:**

- `scripts/bonus-daily-report.mjs` — long-running thin Pacific scheduler, same shape as `bonus-period-close.mjs`. Imports only `@prisma/client` (no `tsx`, no `.ts` import — the prod image is `npm ci --omit=dev` and `tsx` is a devDependency). Reads each enabled config's `send_time_pt`, sleeps until the soonest next-fire across all sites, then POSTs to the loopback+bearer-guarded internal route `/api/internal/bonus/daily-report`, which runs the tested TS runner `src/lib/bonus/daily-report-runner.ts` (`runDailyReportFire`) inside the Next app — mirroring the `bonus-period-close.mjs` → `/api/internal/bonus/close-months` pattern. The runner fires per site within a 60-second wake window (handles two sites configured for the same time). Idempotency via `bonus_daily_report_log` uniqueness; container restart cannot re-send a delivered report.

**Admin UI:**

- `/admin/production-report` route gated on `session.user.is_super_admin`. Per-site card with enable toggle, send time picker, subject template, recipient chips (add/remove), skip rule checkboxes, include flag checkboxes, Save/Send Test/View Recent buttons.
- "Recent sends" table shows last 30 sends across all sites with delivered_count vs attempted, today's total + bonus, and last Graph HTTP status for diagnostics.

**Auth plumbing:** `is_super_admin` propagated through next-auth `jwt` and `session` callbacks; `next-auth.d.ts` extended.

**docker-compose:** New `bonus-daily-report` service alongside the three existing bonus daemons.

**Operator action on first deploy:**

1. `prisma migrate deploy` applies the additive migration.
2. Seed runs (or run `npx prisma db seed`) to populate both configs and the super-admin flag.
3. `docker compose up -d` starts the new daemon.
4. Bill verifies via `/admin/production-report`; first scheduled fire is the next 18:00 PT.

**Tests:** ≥ 32 new vitest cases — aggregation, date math, comparison nulls, config CRUD with audit assertions, notification rendering with conditional sections, route-level super-admin gating (Bill 200, Kelsey 403).

### 2026-06-17 — Fix: EOD bonus alert now fires only when a site has zero entries (ADR-0019 §2)

Bill was being paged whenever **any** active processor lacked a bonus entry by
the 5:00 PM PT cron — but not every processor has a bonus every day (different
position, day off), so the alert false-fired on normal partial days. The check
now pages only when a bonus-enabled site has **zero** entries for the Pacific
day (nobody logged anything). A partial day never pages.

- `src/lib/bonus/eod-check.ts` — `evaluateEod` now alerts iff `enteredCount === 0`;
  the `all_entered` skip reason becomes `has_entries`; `missingCount` →
  `enteredCount`. The pure decision and its tests are the source of truth.
- `scripts/bonus-eod-check.mjs` — `checkSite` fires only when the site has no
  entries; the ntfy title/body now read "No bonus entries for &lt;site&gt;"
  instead of an N-processors-missing count. Fingerprint (`bonus-entry-missing:…`)
  and dedup behaviour unchanged.
- Weekend / holiday / no-active-employees skips and the fire-once-per-day
  fingerprint guarantee are unchanged.

### 2026-06-16 — Feature: amendment notification batching — one notification per root action (ADR-0029)

ADR-0028 modelled each amended line item as its own request, so a manager
correcting N rows in one save fired N approval emails to the approver, N pushes
to Bill, and would need N approve-clicks + N result emails. A real 16-line
correction sent Morena 16 emails. ADR-0029 groups the requests submitted
together and notifies once per root action (applies the ADR-0037 "deduplicate
against root cause" rule).

- **Schema (`prisma/schema.prisma` + `prisma/migrations/20260616_amendment_submission_group/`):**
  adds a nullable `submission_group_id TEXT` column (+ index) to
  `bonus_amendment_requests`. **TEXT, not UUID** — all ids/FKs in this DB are
  TEXT (the UUID/TEXT mismatch is what broke prod in the ADR-0028 migration).
  The migration is additive + idempotent (`ADD COLUMN IF NOT EXISTS` /
  `CREATE INDEX IF NOT EXISTS`), safe against the existing live-test pending row.
- **Batch submit → ONE notification (`src/lib/bonus/amendment-requests.ts`,
  `src/app/api/bonus/amendments/route.ts`):** the submit endpoint now accepts a
  batch body (shared `bonusPayPeriodId` / `targetEntryDate` / `justification` +
  an `items[]` array) as well as the legacy single-item body. `submitAmendmentBatch`
  creates all N rows in one transaction, stamps the shared `submission_group_id`
  (null for N=1), writes a per-row audit row for every item (hard rule #6), and
  fires exactly one `notifyAmendmentBatchSubmitted` (one approver email, one ntfy
  to Bill).
- **Single batch modal (`src/app/bonus/RequestEditBatchModal.tsx`,
  `DailyEntryGrid.tsx`):** the per-item modal **queue** is replaced by one batch
  modal that lists every pending prior-day change, takes one ≥20-char
  justification, shows who it routes to, and POSTs the whole batch in one request.
  `RequestEditModal.tsx` (the per-item modal) is removed.
- **Batch approve/reject → ONE result notification
  (`AmendmentQueue.tsx`, `[id]/approve`, `[id]/reject`):** the queue groups
  pending requests by `submission_group_id` and offers **Approve all** /
  **Reject all** (reject shares one reason, entered inline — no `window.prompt`).
  `approveAmendmentGroup` / `rejectAmendmentGroup` apply every item (each with its
  own entry write + per-item audit, in one transaction) and fire one
  `notifyAmendmentBatchDecided`. All ADR-0028 invariants (four-eyes eligibility,
  requester≠approver, period-still-draft, Patrick carve-out, ping-Bill) hold per
  request. The queue's prior **red** buttons/banner are corrected to DR3
  green/black (hard rule #3).
- **In-app discoverability (`src/app/bonus/page.tsx`):** a "Pending Amendments"
  nav link with a pending-item count, shown only to admins (all-site) and
  managers who are a signature-chain signer at their site (Patrick / non-signers
  never see it).
- **Tests:** batch submit creates N rows + ONE notification + a shared group id;
  N=1 submit is a null-group singleton; batch approve/reject applies all + fires
  ONE result notification; one bad item rolls the batch back; the grid pivots to
  ONE batch modal (not a queue) and POSTs a single `items[]` request.
- **Deployed & verified (2026-06-16, svdp-dev prod):** merged to `main` (PR #28),
  built + deployed; the `migrate` init container applied
  `20260616_amendment_submission_group` (column verified `submission_group_id text
YES`). Typecheck clean, 536/536 tests pass.
  - **Legacy-backlog note (important):** amendment requests created **before** the
    migration carry `submission_group_id = NULL` and — by design — behave as
    singletons, so each fires its own notification. When the first approver cleared
    the ~13-row pre-migration backlog right after rollout it produced one email per
    row. **This is expected, not a regression** — only un-grouped legacy rows do
    it, and the backlog is now drained (0 pending). New multi-line saves get a
    shared group → one email.
  - **Live prod self-test:** a 3-line grouped batch was submitted + approved
    against the production DB (data layer only, no notifications fired), confirming
    one shared `submission_group_id` across all rows and atomic group approval,
    then **fully reverted** with a verified before==after row-count assertion
    across `bonus_amendment_requests` / `bonus_daily_entries` / audit rows (zero
    residue). Confirms one-notification-per-batch holds on real prod data.

### 2026-06-15 — Fix: complete the ADR-0028 amendment client wiring + remove the stale today-only gate

The Sprint 4 amendment workflow (ADR-0028, PR #26) shipped the server side, but
the client glue was missing and a stale gate blocked the feature end-to-end. A
non-admin Woodland manager (Janette) trying to edit a prior day's bonus record
hit `403 "Entries may only be recorded for today"` — the change never reached
the amendment routing.

- **Gate fix (`src/app/api/bonus/entries/route.ts`):** the pre-ADR-0028
  today-only gate (`date !== appToday()` → 403) is replaced with a future-only
  gate. A non-admin may now POST for **today** (direct write) or a **prior day**
  (the data layer routes it through the four-eyes amendment workflow and returns
  `409 requires_amendment`); only a **future** date is rejected `403`. Admins
  keep unconstrained back-dating. The client stays untrusted — all draft/period/
  prior-day scoping is re-enforced in `upsertDailyEntries` →
  `shouldRequireAmendment`; a prior day in a closed period still returns
  `month_locked` (409) and an uncovered day still returns `NoOpenPayPeriodError`
  (409).
- **409 payload carries `approverName`:** the route resolves the counterpart
  signer via the signature chain (`resolveAmendmentApprover`) and looks up the
  user's display name, surfacing it top-level on the `requires_amendment` 409 so
  the modal can show "sent to X for approval". A requester structurally outside
  the workflow (Patrick / non-chain manager) is surfaced as the 403 the
  amendment submit would itself return, rather than dangling an unsubmittable
  modal.
- **Client wiring (`src/app/bonus/DailyEntryGrid.tsx`):** `handleSave` now
  detects the `409 requires_amendment` response and pivots to the previously
  orphaned `RequestEditModal` instead of showing the raw error string. Each
  pending change becomes a modal payload, mapping `bonus_employee_id → full_name`
  from the grid's own rows and old/new values from `pending[i].existing` /
  `.proposed`. Multiple pending changes are handled as a **queue** — one modal at
  a time; submit or cancel advances to the next; the last one drained triggers
  `router.refresh()`. Uses `onClick` (no `<form>`, hard rule #10); brand styling
  preserved.
- **Tests:** route — non-admin prior day → 409 `requires_amendment` with
  `approverName`, non-admin future → 403, admin prior day → direct write; grid —
  a 409 opens the modal with the mapped payload and a multi-pending queue
  advances one modal at a time. Full suite green (830 tests), tsc 0, eslint 0,
  `prisma validate` clean, `next build` succeeds.

This completes ADR-0028's intended flow; no new ADR.

### 2026-06-16 — Fix: amendment-workflow migration used UUID columns against a TEXT-id schema

The Sprint 4 migration `20260616_amendment_workflow` (ADR-0028) declared every
id/FK column as `UUID`, but this database stores all primary keys as `TEXT`
(Prisma `String @default(uuid())` → `text`). On deploy the migration failed at
`bonus_amendment_requests_period_fk` (Postgres 42804: "Key columns
bonus_pay_period_id and id are of incompatible types: uuid and text"), which
(a) blocked the deploy's `migrate deploy` step and (b) left the app container
unable to start. The CI gate (tsc/eslint/vitest/`next build`) never executes the
migration against a real Postgres, so it passed while the migration was broken.
Fix: all id/FK columns in `migration.sql` are now `TEXT` (and the
`gen_random_uuid()` default removed — ids are generated client-side by Prisma,
matching every other table). Recovered on prod by cleaning the partial state +
re-running the corrected migration; the table, both enums, and all existing data
verified intact. The Prisma schema (`String`) was already correct; only the raw
`migration.sql` was wrong.

### 2026-06-16 — Added: prior-day bonus amendment workflow + manager date picker + bi-site EOD check (ADR-0028)

Morena Gomez asked (2026-06-15) what the correct process is to fix a prior day's
bonus entry. There wasn't one. Within a `draft` pay period, a manager could
silently rewrite any prior day; closed periods had no manager path at all. This
sprint defines the answer: a **four-eyes prior-day amendment workflow**.

- **Workflow (Sprint 4):** within the current `draft` period, a non-admin
  manager's change to a prior day's `mattress_count` (an `update`, or an
  `insert` of a missed day) no longer writes directly — it opens a Request Edit
  modal requiring a ≥20-char justification and routes to the signature-chain
  counterpart for approval. Approval applies the entry change, writes the
  entry-audit row (`actor_label='system:amendment-approved'`), marks the request
  `approved`, and links the applied audit id back into the request — all in one
  Prisma transaction. Rejection requires a reason. Bill is notified (ntfy +
  email) on **every** approval and rejection. A requester whose approver is
  unavailable can "Ping Bill" to add the Director as a second eligible approver
  (soft control; the audit log records ping timing for abuse detection).
- **Carve-outs:** same-day corrections, note-only prior-day edits, and admin
  writes stay direct. Patrick Dills (Eugene Lead processor) is excluded from the
  workflow by separation of duties — his prior-day grid is read-only. Closed
  periods stay immutable for managers; Bill keeps the existing audit-labeled
  admin escape valve in `src/lib/bonus/amendment.ts` (unchanged).
- **Concurrency:** a new request from the same requester for the same
  `(target_entry_date, bonus_employee_id)` auto-cancels their prior pending
  request (audit-tracked, `superseded_by_new_request`).
- **Date picker:** the admin-only `AdminDatePicker` is replaced by
  `BonusDatePicker`, visible to all managers and constrained to the current
  draft window (`min=period_start`, `max=today` Pacific); admins remain
  unconstrained. Both the client `min/max` and the server-side `resolveEntryDate`
  enforce the bound. The PR #25 grid date-key remount fix is preserved.
- **Bi-site EOD check:** the 5 PM Pacific missing-entries notification, formerly
  Woodland-only and not wired into the production stack, is now bi-site (iterates
  every site with an active signature chain) and runs as a long-running
  `bonus-eod-check` docker-compose daemon alongside `bonus-period-close` and
  `bonus-escalation-check`. `missingFingerprint(siteCode, dateIso)` and
  `evaluateEod` are now site-scoped so Woodland and Eugene alerts never collide.
- **Migration `20260616_amendment_workflow`** (pure additive): one new table
  (`bonus_amendment_requests`), two enums, five DB-level CHECK constraints
  (requester ≠ approver, justification ≥20, decided rows have a reviewer,
  rejected rows have notes), five indexes.
- New service modules (`amendment-approvers`, `amendment-requests`,
  `amendment-notifications`), five routes
  (`GET/POST /api/bonus/amendments`, `POST .../[id]/(approve|reject|cancel|ping-bill)`),
  three UI components (`BonusDatePicker`, `RequestEditModal`, `AmendmentQueue`)
  and the `/bonus/amendments` queue page. ADR-0028 + operator runbook
  `docs/operator/bonus-amendment-workflow.md` document the design and deploy/verify/rollback.

### 2026-06-15 — Fix: bonus daily-entry grid now repopulates when the admin changes the date

Picking a different business day in the admin date picker left the grid showing
the **previous** day's counts (or blanks) until a manual page reload. Root cause:
`DailyEntryGrid` seeds its input state from `rows` in the `useState` initializer,
which runs once per mount; client-side date navigation (`router.push`) passes new
`rows` but React reuses the same instance, so the seed never re-ran. Fix: a
`key={entryDate}` on the grid in `src/app/bonus/page.tsx` forces a remount on date
change, re-seeding from the new day's rows. Save/`router.refresh()` is unaffected
(same date → same key → no remount, in-progress edits preserved). New
`DailyEntryGrid.test.tsx` (+3) pins the seed-on-mount contract and documents why
the key is required. Suite 762 → 765 green.

### 2026-06-15 — Added: PWA "update available — tap to reload" prompt (ADR-0027)

An installed, always-open PWA never reloads on its own, so after a deploy it
kept serving the **old precached app shell** — whose hashed
`/_next/static/chunks/*.js` references 404 against the new deploy, rendering
blank pages. This once read to the operator as "all my data is gone" (nothing
was lost; the shell was simply stale). DR3-Vision now surfaces an explicit,
user-controlled update prompt so a stale shell can never silently strand anyone.

- **SW change (minimal):** `src/app/sw.ts` flips `skipWaiting: true` →
  `false` so a freshly installed SW parks in the `waiting` state where the page
  can detect it. `clientsClaim` stays `true`; the existing `SKIP_WAITING`
  message handler is retained and now drives the user-initiated promotion. The
  **offline-queue / BackgroundSyncPlugin runtime caching is untouched.**
- **New client component:** `src/app/UpdatePrompt.tsx` watches the SW
  registration (`getRegistration()` + `updatefound`/`statechange`, and checks
  `registration.waiting` on mount), and shows a non-intrusive bottom banner —
  "A new version is available. Reload" — only on a real update (worker
  `installed` **and** a controller already exists), never the first install.
  Tap **Reload** → posts `SKIP_WAITING` to the waiting worker, then reloads
  **once** on `controllerchange` (guarded against reload loops). **Dismiss**
  defers. Never auto-reloads (operators may be mid data-entry). SSR-safe;
  no-ops where service workers are unsupported.
- **Mounted in the root shell** (`src/app/layout.tsx`) so it appears on every
  surface (operator, manager, bonus). The root layout has no `I18nProvider`, so
  the prompt is wrapped in a scoped `I18nProvider` with the operator dictionary
  (smallest correct integration; no collision with route-group providers).
- **i18n:** `update_prompt.{title,body,reload,dismiss}` added to the operator
  namespace in **en/es/ur** (CLAUDE.md #4). Banner uses brand green/cyan on the
  dark space surface (#3) with `onClick` handlers, not `<form>` (#10).
- **Tests:** `src/app/UpdatePrompt.test.tsx` — banner renders the translated
  strings + fires callbacks on tap; the prompt surfaces on a waiting worker,
  posts `SKIP_WAITING`, and reloads exactly once on `controllerchange`.

### 2026-06-15 — Added: Employee # surfaced end-to-end in Manage Employees UI (ADR-0026)

ADR-0026 added the `bonus_employees.employee_number` column + backfill but no UI
or API read or wrote it (`grep employee_number src/` returned nothing). The
"Manage Employees" screen (`/bonus/employees`) now **shows and manages** the
field — closing the gap ADR-0026 flagged ("no UI consumes it yet" + "a future
write path must add the app-level per-site uniqueness check").

- **Display:** each employee row shows `Employee #: <number>` or an italic
  "No Employee #" empty state (most rows have none — only the 21 legacy Woodland
  imports carry one).
- **Create:** the Add-employee row gains an optional "Employee # (optional)"
  input alongside the name.
- **Edit:** a per-row "Edit #" inline editor sets or clears the number
  (clearing = empty input → stored `null`). Uses `onClick` handlers, no `<form>`
  (CLAUDE.md #10).
- **Validation:** `employee_number` stays a `String?`; when present it must match
  `^[0-9]{4}$` (the live prod data format — all 21 rows are exactly 4 digits).
  Per-site uniqueness is enforced at the **app layer** among **active** rows
  (`deleted_at IS NULL`, mirroring the §9a rehire freeing) — no DB constraint,
  per ADR-0026. Duplicate → 409; bad format → 422; both surface inline.
- **Audit:** the new `set_number` PATCH action writes an `update` audit row with
  before/after DTO snapshots in the same transaction, exactly like the §9b
  rename path. The append-only audit log is never mutated destructively
  (CLAUDE.md #6).
- **i18n:** the bonus surface had no `I18nProvider` and shipped English-only
  hardcoded strings. Wired the manager-namespace dictionary into the `/bonus`
  layout (mirroring `/dashboard`) and added a `bonus_employees` namespace to
  `en` / `es` / `ur` (RTL) `manager.json`; the Manage Employees page + component
  are now fully translated (CLAUDE.md #4). Brand stays DR3 green/cyan dark
  surface — no red/navy/gold introduced (#3).

Files: `src/lib/bonus/employees.ts` (DTO + `setEmployeeNumber` +
`normalizeEmployeeNumber` + `findByEmployeeNumber`), the two
`api/bonus/employees` routes, `app/bonus/employees/{page,EmployeeManager}.tsx`,
`app/bonus/layout.tsx`, the three `manager.json` locales, and the two test
files (+21 new cases; `npm test` 755 green, `tsc`/ESLint/`prisma validate`
clean).

### 2026-06-15 — Added: `employee_number` on bonus processors (ADR-0026)

New nullable `bonus_employees.employee_number` column + `(site_id,
employee_number)` index. Migration `20260615_bonus_employee_number` backfills the
21 legacy DR3 Woodland rows whose display name carried a trailing 4-digit employee
number, strips the number out of `full_name`, and records the original name in
`previous_names` (`reason: employee_number_extracted`). Idempotent;
behavior-neutral (no UI consumes the column yet). Per-site uniqueness enforced at
the app layer, not the DB. **Deployed and verified live on prod 2026-06-15** —
migration `20260615_bonus_employee_number` applied at 18:05 UTC (11:05 AM PDT) via
the auto-deploy `migrate deploy` step; post-deploy verification on the live DB:
21/107 rows extracted, 0 names still numbered, 21 distinct numbers, 0 bad formats
(one soft-deleted row included, by design).

### 2026-06-11 — Fix: manager bonus UI shows the SITE's signers (no hardcoded Woodland names)

The manager-facing bonus UI hardcoded the WOODLAND signature-chain names, so a
**Eugene** pay period rendered **Janette Tomas / Morena Gomez** (the Woodland
facility/ops signers) instead of Eugene's **Rick Albritton / Kelsey Ruhland**.
Kelsey — reaching Eugene via the ADR-0024 `all_sites` flag — opened a Eugene
report and saw the wrong signers. Ground truth (who signs which slot at which
site) lives in the `bonus_signature_chains` data; the data layer was already
site-scoped everywhere, and the **bonus-pdf page already resolved names from the
chain correctly** — only these three presentation surfaces
