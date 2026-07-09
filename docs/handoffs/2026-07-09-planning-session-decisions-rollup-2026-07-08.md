# 2026-07-08 — Planning session decisions rollup (Bill × Claude)

**Session:** Bill × Claude (planning channel), ~2h+ across 26 discrete decisions
**Purpose:** Rollup of decisions locked while walking the open register from `2026-07-04-adr-0036-mission-forward-handoff-p1-complete-p2-ga.md` §7 + post-incident QUESTIONS.md items + parked scope from prior sessions
**Follows:** `2026-07-07-incident-directive-staged-rollout-policy-for-staff.md` (incident + staged plan) and `2026-07-04-adr-0036-mission-forward-handoff-p1-complete-p2-ga.md` (current marching order)

## §0 — Executive summary

Twenty-six discrete decisions locked across coordination, the post-incident rollout gate (Q-0047-1/-2/-3), a new continuous workbook sync (ADR-0049), the physical inventory pool split (Q-3), historical audit disposition (Q-2), significant AP mailbox scope expansion (ADR-0046), five organizational role assignments, and eleven roadmap dispositions covering the last of the parked scope items.

The single most consequential decision: **Woodland+Eugene single go-live wave wk of 7/20** (originally planned as separate 7/9 and 7/20 waves). This compresses Kelsey's validation window from ~3 weeks to ~1.5 weeks and folds the original Stage 2 into Stage 1. Stage 3 shadow-billing still starts 7/16 independently.

The single biggest new build item: **ADR-0049 — Woodland workbook → Vision continuous sync bridge to cutover.** Full daily-log mirror from Kelsey Ruhland's OneDrive `JUNE 2026 DAILY LOG WOODLAND.xlsm` file (and monthly rollovers), 10-min polling during business hours, workbook-wins conflict rule, R2 archival at cutover, tenant-wide `Files.Read.All` for access. Replaces the "fix ADR-0030 accuracy" approach with a structural sync that also feeds ADR-0039's 3-way audit as Leg C during shadow-billing.

Two emails drafted (SVdP IT and Morena) that unlock next-week workstreams; not yet sent.

## §1 — Session-locked decisions

### §1.1 — Coordination

- **Woodland + Eugene single go-live wave wk of 7/20.** Original two-wave plan (Stage 1 Woodland 7/9, Stage 2 Eugene 7/20) collapses to one wave. Stage 3 money-in-shadow, 7/16 → EOM, unchanged. Original Stage 2 folds into Stage 1; wk of 7/27 becomes shakedown week, not a separate go-live.
- **Kelsey's validation window** compresses to 7/20 → 8/1 (~1.5 weeks active). Front-load her cross-checks on Woodland Day 1.
- **E-Rick note still stands** — send before Stage 0 exits. Timing independent of go-live date.

### §1.2 — Post-incident rollout gate (Q-0047-1/-2/-3)

**Q-0047-1 — ADR-0030 daily production report.** Grandfather through cutover, revisit post-8/1. Rather than gate it, ADR-0049 workbook sync fixes the underlying accuracy problem structurally — gating becomes moot.

**Q-0047-2 — ADR-0028/0029 amendment lifecycle mail.** Leave alone. Permanent grandfather. Working production surface, not incident-implicated.

**Q-0047-3 — AP mailbox emails.** Both AP email kinds (incoming-request-alert AND decision-back-to-accounting) flip together under one `ap_notify` surface.

### §1.3 — Workbook sync (ADR-0049, new)

Full draft in §2.1. Bullet locks:

- **Scope**: full daily log mirror. Feeds ADR-0030 report accuracy + ADR-0039 audit Leg C + Stage 3 shadow-billing parity.
- **Cadence**: 10-min polling business hours (6 AM – 8 PM PT weekdays). Graph delta-query change detection.
- **Conflict rule**: workbook wins pre-cutover. iPad-captured Vision data that disagrees gets overwritten with audit log noting the write. Post-cutover, direction flips.
- **Monthly file rollover**: naming pattern `<MONTH> <YEAR> DAILY LOG WOODLAND.xlsm`; sync auto-discovers.
- **Historical scope**: June forward. Nothing older.
- **Storage source**: Kelsey's personal OneDrive at `svdplanecounty-my.sharepoint.com/personal/kelsey_ruhland_svdp_us/`. Not moving — she stays employed.
- **Access**: `Files.Read.All` tenant-wide app permission. Sharing to `dr3-vision@svdp.us` failed (shared mailbox has no OneDrive to receive shares); delegated auth is fragile; tenant-wide is only permission that stays functional.
- **Cutover trigger**: manual admin flip in `/admin/rollout`, gated on Rick's parity signoff in audit ledger. R2 archival fires atomically with flip.
- **R2 archival at cutover**: `archiveWorkbooksToR2()` copies June + July `.xlsm` (and any others in scope) to `workbooks/{site}/{yearMonth}.xlsm`. Immutable, forever.
- **Eugene coverage**: pending Rick's confirmation whether Eugene has an equivalent workbook. Schema is site-parameterized day one.

### §1.4 — Inventory pool split (Q-3)

**Physical inventory counts record program and non-program separately.**

New columns on `site_inventory_snapshots`: `program_units` and `non_program_units`. Count-entry UI gets two fields with a helper showing running total. Validation: `program + non_program === total`.

Historical rows attributed-all-to-program during migration, flagged with `pool_attribution: 'legacy'`. Clean data starts when counters actually enter both fields.

Workbook sync parser needs to be checked: if June daily log workbook already tracks the split, clean data for June and July; if not, legacy attribution for those months.

### §1.5 — Historical audit (Q-2)

**Employee-number extractions stay as-is.** `previous_names` is the trail; no formal `audit_log` rows added for historical migration.

### §1.6 — AP mailbox expansion (ADR-0046)

Significant scope expansion this session. Amendments in §3.

- **People model expanded**: Gloria Salpino (SVdP accounting, strictly AP / invoice approval) added. Mary Scott is higher-level. Decision emails route to internal SVdP forwarder (Mary or Gloria) at time of original submission.
- **Scope broadens**: from "DR3 vendor invoices" to ALL Woodland + Eugene invoices. One mailbox, both sites.
- **Approver list expands to five**: Morena, Rick, Janette, Bill, Kelsey (until 8/1 auto-remove).
- **All approvers see all invoices.** First-action-wins (existing D2). Site tag captured OPTIONALLY at approval time via dropdown — intake stays untagged because incoming email doesn't inherently know which site.
- **Kelsey auto-removes 8/1 midnight PT.** Schema: `active_until` on `ap_approvers`; daily job removes expired approvers with audit + ntfy.
- **Decision email carries signed PDF of approved item**:
  - PDF attachments signed directly
  - Body-only emails captured as PDF via headless Chrome, then signed
  - Signature: visible stamp only, NO CRYPTO. Same style as bonus PDFs. Free. Audit log holds PDF hash as tamper record.
- **Return-to-sender routing**: decision email goes to original internal SVdP forwarder. Security posture holds — sender validation still requires internal `@svdp.us` per D2.

### §1.7 — Organizational assignments

- **MRC point person**: Bill, permanent. Portal creds, rate discussions, contract touchpoints default to Bill.
- **Compliance/permits/COIs**: Bill takes permits, legal, COIs. Floor-level things (bed-bug, HazMat, closure plans, scale/fire inspections) split by site — Janette for Woodland, Rick for Eugene.
- **Accounting**: Mary higher-level (MRC entry to GP, various tasks). Gloria strictly AP / invoice approval. No single "accounting liaison" — Vision routes AP to whoever forwarded each invoice.
- **Dispatch inbox**: Morena, unchanged. Manual cross-check continues until dispatch integration ADR ships.

### §1.8 — Roadmap dispositions

**Building:**
- **Bethany's board-pack digest** (parked #24): Stage 4 or Stage 5. Cron: 2nd Wed + preceding Mon. Payload: prev-month processed, MTD current, YoY, P&L slot when financials land. Safety events section removed. New surface `board_pack_digest`, born pilot per ADR-0047. Likely ADR-0045 addendum, not fresh ADR.
- **Trailer/yard list feature** (parked #23): Stages 4/5. Ties into `container_rental_sites` and `site_inventory_snapshots`. Yard visibility across Woodland/Eugene post-Stockton-7/11.
- **Compliance-admin ledger** (parked #25): post-cutover (8/1+). ADR-0050 proposal draft in §2.2. Owner-per-item schema from compliance split.

**Deferred / pending clarification:**
- **Dispatch ↔ Outlook integration** (parked #26): pending Morena's confirmation of what's actually in `DR3.Dispatch@svdp.us`. Bill initially wanted full integration + June/July backfill; scoped back after clarifying program hauls come via MyMRC portal (ADR-0038 covers) and only non-program probably comes via dispatch email (uncertain — Morena email in §5).
- **COR signer title** (Q-5): waits on MRC confirmation externally.

**Skip / not building:**
- **Processor-facing bonus standing view** (parked #22): Skip.
- **Safety events tracking** (parked #27): Skip. Safety stays informal. Board digest's injuries/safety slot drops.
- **Payment-confirmation tracking** (parked #20): not tracked in Vision. GP owns all downstream AR/payments/disputes/credits.

**Informational, no decision:**
- **Stockton wind-down flexibility** (parked #28): internal provenance only per hard rule #1.
- **Contract-loss data contingency** (parked #29): ADR-0038 mirrors + raw payloads already provide independent Vision-owned MyMRC copy.

## §2 — ADRs to draft

### §2.1 — ADR-0049 (proposed): Woodland workbook → Vision sync bridge to cutover

**Status**: Proposed, awaiting Bill review before Claude Code build.
**Date**: 2026-07-08
**Related**: ADR-0030 (accuracy source), ADR-0037 (loads/inventory model), ADR-0038 (parallel transport pattern), ADR-0039 (becomes Leg C), ADR-0046 (parallel Graph transport), ADR-0047 (cutover flip), ADR-0048 (shares parser)

**Context**

Vision's daily production report (ADR-0030) currently bases numbers on Vision-captured data, which lags Janette's authoritative Woodland daily-log spreadsheet during pre-cutover window. 7/8 (today) through 8/1 (cutover), spreadsheet is source of truth. This ADR replaces the rollout-gate patch (Q-0047-1) with a structural fix.

Beyond fixing ADR-0030 accuracy, sync enables:
- ADR-0039's 3-way audit to have a third leg (workbook mirror) during shadow-billing
- Stage 3 shadow-billing parity to compare Vision-generated invoices against workbook-derived reality
- ADR-0048's June backfill promotion to run against actual workbook shape (not fixtures)

**Decisions**

**D1 — Scope**: Full daily log mirror. Every sheet Janette maintains flows into Vision.

**D2 — Cadence**: 10-min polling business hours (6 AM – 8 PM PT, Mon-Fri). Graph delta query for change detection. Outside business hours: no polling.

**D3 — Conflict rule**: Workbook wins pre-cutover. Vision-captured data that disagrees gets overwritten. Audit log records every overwrite. Post-cutover direction flips.

**D4 — Storage source**: Kelsey's personal OneDrive at `svdplanecounty-my.sharepoint.com/personal/kelsey_ruhland_svdp_us/`. File stays where it is; Kelsey remains SVdP employee through and after 8/1.

**D5 — Monthly file rollover**: Pattern `<MONTH> <YEAR> DAILY LOG WOODLAND.xlsm`. Sync auto-discovers current month's file each poll. Parser handles possibly-empty file on 1st of new month.

**D6 — Access mechanism**: `Files.Read.All` app permission on existing dr3-vision Graph app. Tenant-wide OneDrive read scope. Sharing to `dr3-vision@svdp.us` failed (shared mailbox has no OneDrive); delegated auth is fragile; tenant-wide is only permission that stays functional. Acceptable given SVdP is single small tenant and Vision is already trusted with `Mail.Send` at tenant scope.

**D7 — Cutover trigger**: Manual admin flip in `/admin/rollout`, on new surface `workbook_sync`. Flip requires Rick's parity signoff in audit ledger (soft-gate: UI warns if not present but allows override). R2 archival fires atomically.

**D8 — R2 archival**: `archiveWorkbooksToR2()` runs as part of cutover flip. Copies all monthly `.xlsm` files that were syncing to `workbooks/{site}/{yearMonth}.xlsm`. Immutable, forever retention.

**D9 — Site parameterization**: `workbook_sources` config table with `site_id`, `share_url`, `naming_pattern`, `is_syncing`, `last_polled_at`. Woodland ships day 1. Eugene added as config row when Rick confirms.

**D10 — Historical backfill**: June + July via ADR-0048's promotion pipeline (already built, waiting on D4 files). Sync-side backfill for August+ unnecessary — sync starts live on 8/1.

**D11 — Mid-edit tolerance**: Rows with required cells empty are skipped on current poll, retried on next. No error, no alert — eventual consistency.

**D12 — Parser sharing**: Same parser as ADR-0048. Parser finalized once Kelsey's actual `.xlsm` is in hand.

**Consequences**

*Positive:*
- Daily production report becomes accurate day sync goes live
- ADR-0039 audit gains Leg C during shadow-billing
- Stage 3 parity becomes real automated comparison
- Post-cutover archival ensures workbook data survives Kelsey's role transitions
- Parser finalized once, reused twice

*Negative:*
- Tenant-wide `Files.Read.All` is broader permission than typical
- Kelsey's OneDrive as source means account issues could break sync — bounded by her staying employed
- Requires `Files.Read.All` grant to land before shipping; tenant-admin gated on IT

**Test plan**

- Poll finds current month's file, delta-queries, no full re-download when unchanged
- Poll skips outside business hours
- Mid-edit rows skipped, retried, eventually consistent
- Workbook write overwrites Vision-captured record with audit entry
- Monthly rollover: sync switches to August's file on 8/1 without config change
- Cutover flip: sync stops, R2 archival fires, downstream Vision continues reading own data
- Post-flip sync is no-op
- Missing `Files.Read.All`: fail-soft, log + ntfy, no crash

**Migration**: `20260709_workbook_sync` adds `workbook_sources` and `workbook_sync_runs` tables (mymrc-shape run ledger).

**Runbook**: `docs/operator/workbook-sync.md` — enable, check status, cutover flip.

### §2.2 — ADR-0050 (proposed, post-cutover): Compliance-admin ledger

**Status**: Proposed, post-cutover build. Not pre-8/1.
**Date**: 2026-07-08
**Related**: ADR-0034 (Kelsey Q5 source), ADR-0045 (parallel task ledger pattern)

**Context**

Kelsey's survey Q5 described DR3's compliance surface as broad evidence ledger — COIs, bed-bug training/plans/signage, permits, scale inspections, fire inspections, vendor desk audits, closure plans (Woodland AND closing CA site 2026), HazMat plan. Each item has owner, renewal cadence, expiration, evidence, expiration alerting.

Bill inherits permits/legal/COIs on 8/1 (Kelsey rolls off); site managers inherit floor-level items. Without first-class Vision module, that inheritance lands as folder of spreadsheets + calendar reminders.

**Proposed decisions (post-cutover D-review)**

- Table: `compliance_items(id, kind, title, owner_user_id, site_id, cadence_pattern, expires_at, next_review_at, evidence_r2_key?, notes)`
- Kind enum: `coi`, `permit`, `bed_bug_program`, `inspection`, `vendor_audit`, `closure_plan`, `hazmat_plan`, `training`, `signage`, `other`
- Ownership: per-item, mapping to compliance split from this session (Bill = permits/legal/COIs; site managers = floor-level for their site)
- Alerts: 90/30/7-day windows before expiration, routed via `notifyStaff()` to specific owner
- Evidence storage: R2 under `compliance/{site}/{kind}/{itemId}/`; matches ADR-0046 attachment pattern
- Handoff-friendly: import CSV format lets Kelsey dump existing tracker before 8/1

**D-items for post-cutover review**

- D1: Kelsey's tracker format (import shape)
- D2: alerting cadence tuning per compliance kind
- D3: closure plan special-case (legal review dependencies)
- D4: whether Bethany's board digest surfaces upcoming compliance items

## §3 — ADR amendments needed

**ADR-0030** (daily production report): Post-acceptance note — grandfathered under rollout gate through cutover per Q-0047-1. ADR-0049 workbook sync structurally fixes accuracy question this grandfathering was necessary for. Post-cutover revisit optional.

**ADR-0028/0029** (amendment lifecycle mail): Post-acceptance note — permanent grandfather per Q-0047-2. Signature-chain treatment. Not rerouted through `notifyStaff()`.

**ADR-0037 D6** (running balance): Schema amendment — `site_inventory_snapshots` adds `program_units` and `non_program_units`. Validation `program + non_program === total` at insert/update. Historical rows migrate as `pool_attribution='legacy'` with all counts attributed to program pool. Balance function accepts measured pool split when present, falls back to legacy otherwise.

**ADR-0045** (task ledger / digest routing): Addendum — new surface `board_pack_digest`. Cron: 2nd Wed of month + Mon preceding. Recipients: Bethany + Bill (mandatory). Payload: units processed prev month, MTD current, YoY, safety events section drops (per §1.8 skip), P&L placeholder. First live send: 2026-08-10.

**ADR-0046** (AP mailbox) — significant amendment:

- §C1 scope expansion: from "DR3 vendor invoices" to ALL Woodland + Eugene invoices
- §C5 approver list expansion: 2 → 5 (Morena, Rick, Janette, Bill, Kelsey-until-8/1). `ap_approvers` gains `active_until` column. Daily job removes expired.
- §C5 approver visibility: all see all, first-action-wins. Site tag OPTIONAL at approval time via dropdown, not at intake.
- §C5 decision routing: goes to original internal SVdP forwarder (from intake message From field), not fixed allowlist. Sender validation §D2 tenant-wide `@svdp.us` still applies at intake.
- §C10 attachment handling: decision email includes signed PDF of approved item.
  - PDF attachments signed directly
  - Body-only originals: capture as PDF via headless Chrome first, then sign
  - Signature: visible stamp only ("Approved by [Approver] on [Timestamp] via DR3-Vision"). No crypto. Matches bonus PDF pattern.

**ADR-0047** (rollout gate): Post-acceptance note — Q-0047 resolutions. Q-0047-1 & Q-0047-2 permanent grandfather. Q-0047-3 single `ap_notify` surface both AP email kinds.

## §4 — Stakeholder-questions registry updates

**Morena (new)**: What actually arrives at `DR3.Dispatch@svdp.us`? Non-program haul schedules only, or coordination for both programs, or additional MRC comms? Email drafted §5. Waiting on response before dispatch integration ADR drafted.

**Rick (new)**: Does Eugene have shared daily-log workbook Vision should sync? If yes, name + OneDrive/SharePoint location. Determines whether ADR-0049 adds second `workbook_sources` row day 1 or later.

**Kelsey (unchanged, 7 items — walkthroughs before 8/1)**:
- Commodity → invoice-block mapping (B10-5, priority)
- `saved_units` semantics (B10-2)
- `%` column on Steel/Biomass/WTE
- DAY6 `×5` quirk
- `event units` validity as inbound type
- MRC contact map + Re-TRAC / CalRecycle filing mechanics
- VBA modules in daily log (Alt+F11)

**MRC (external)**: COR signer title (Q-5). Bill asks MRC to confirm "Transportation Manager" or supply correct title.

**IT (new)**: Two Graph permission asks batched (approvals mailbox + Files.Read.All). Email drafted §5.

## §5 — Emails drafted (not sent — Bill review before send)

Both drafted with two variants (warm/full-context, brief/direct). Bill picks a variant and sends.

### §5.1 — Email → SVdP IT

**Subject (v1)**: DR3-Vision — Two Microsoft Graph permissions (batched)
**Subject (v2)**: DR3-Vision Graph permissions — 2 asks

**Content asks**:
1. Shared mailbox `approvals-dr3@svdp.us` provisioned + Graph app extended with `Mail.ReadWrite` scoped via ApplicationAccessPolicy
2. `Files.Read.All` application permission granted to existing dr3-vision Graph app

Both require tenant-admin consent. Timing: this week; sprint ends 8/1.

### §5.2 — Email → Morena

**Subject (v1)**: Quick scoping question — DR3.Dispatch@svdp.us
**Subject (v2)**: DR3.Dispatch@svdp.us — what arrives there?

**Content asks**:
- What kinds of emails currently arrive at `DR3.Dispatch@svdp.us`?
- Non-program haul schedules? Holds/cancellations/moved loads? General MRC coordination? Program hauls too or only through MyMRC?
- Forward 2-3 recent examples of each type she sees

## §6 — Next actions for Bill (this week)

**Highest priority (blocker for Stage-1 flips):**

1. Confirm `RESTIC_PASSWORD` filed in 1Password (P1-4). Vision's 1Password integration can automate this check going forward — Claude building that into a future handoff.

**Prep work (unblocks other things):**

2. Send IT email (§5.1). Two variants — pick whichever fits.
3. Send Morena email (§5.2).
4. Share Janette's `JUNE 2026 DAILY LOG WOODLAND.xlsm` + Kelsey's Terex spreadsheet + Eugene's Jun 24–30 daily log so ADR-0048's promotion can run and ADR-0049's parser can be finalized against real shape.

**Kelsey window (protect this — hard 8/1 deadline):**

5. Schedule 7 Kelsey walkthroughs (§4) before 8/1. Front-load commodity → invoice-block mapping (feeds ADR-0041) and MRC contact map / CalRecycle mechanics (feeds P6).

**Communication:**

6. E-Rick note (Stage 0 exit item) — send before Stage 1 pre-flight.

**Not urgent this week:**

7. Q-5 COR signer title confirmation with MRC — alongside next scheduled MRC contact.
8. Compliance ledger and dispatch integration ADRs both post-Morena and post-cutover.

## §7 — Explicitly SKIP registry

Items deliberately not built, not deferred:

- Processor-facing bonus standing view (parked #22 from 07-04 handoff)
- Safety events tracking (parked #27 from 07-04 handoff; board digest's injuries/safety section also drops)
- Payment-confirmation tracking in Vision (parked #20; GP owns entire downstream AR/payments/disputes)

## §8 — Session close

All 26 decisions documented above. Build queue changes:

- **Ships pre-8/1**: ADR-0037 pool split schema update, ADR-0046 expansion, ADR-0049 workbook sync (dependent on IT permissions), ADR-0045 board pack digest addendum, trailer/yard list feature, ADR-0048 June backfill promotion (dependent on Bill's files)
- **Ships post-8/1**: ADR-0050 compliance ledger
- **Pending stakeholder input**: dispatch integration (Morena), Eugene workbook (Rick), Kelsey capture items (7)

No new blockers introduced. Existing blockers (P1-4 RESTIC, IT permissions, Kelsey walkthrough scheduling) all have clear action ownership.
