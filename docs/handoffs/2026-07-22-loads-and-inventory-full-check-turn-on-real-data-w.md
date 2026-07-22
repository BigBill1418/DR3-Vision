# 2026-07-22 — Loads & Inventory: full check + turn on real data flowing (manager-owned, paper-bootstrap, EOD inventory on Daily Production Report)

**Session context (Bill × Claude, 2026-07-22):**

Bill checked the Loads & Inventory surface and reports zeros across the board — no on-hand balance, no program/non-program split, no floor total. Combined with everything shipped in ADR-0037/0048/0055 (loads foundations, June backfill, recycling rates), the surface is fully built but functionally dead because no operational rows exist to display.

**Bill's directive:**

1. Investigate why the surface reads zero — is the June workbook backfill promoted, or is it stuck in staging (or never parsed)?
2. Get real data flowing NOW — even from paper totals, since operator iPad flow isn't in use yet.
3. Loads & Inventory should be **manager-controlled**, not admin-gated. Close the D7 gate for site managers.
4. **EOD inventory belongs on the Daily Production Report (ADR-0030)** once the numbers are verified accurate.

**Bill's operational framing questions (answered during planning):**

- **Do iPads need to go first?** No. Manager surfaces accept aggregate daily entry without load-level detail. iPads add a feeder later; they don't replace the manager surfaces.
- **Can we enter paper totals for now?** Yes, cleanly. Two viable patterns (anchor-daily and backfill-and-run) — both work without iPads and both survive when iPads come online.
- **Manager control not admin?** Yes. D7 activation gate + `/admin/processed-units` super-admin-only design both need adjustment for that.

**What this handoff delivers:**

1. Investigation checklist (§1) — verify current state before doing anything
2. Execution plan by phase (§2) — backfill promotion → manager gate close → paper-total workflow → EOD inventory on Daily Production Report
3. Manager access + delegation decisions (§3)
4. Daily Production Report EOD wire-up (§4)
5. Actions for Bill (§5)
6. Actions for Claude Code (§6)
7. Success criteria (§7)

Execution posture: **investigate first, then full green light through Phases 1–4.** Claude Code should report findings from §1 before designing §2 execution but does not wait for Bill approval to proceed once findings are documented.

---

## §1 — Investigation checklist (Phase 0)

Before executing any of the below, Claude Code confirms current state on production DB / dev-mirror:

### §1.1 — Workbook backfill state

**Question:** is the June Woodland workbook (SHA `1eeeccbde0db7824aaf859b4352c7ac5e28ccba9efa319adb0976e635a966295`, per prior conversation memory) in staging, or has promotion already run, or was it never uploaded?

- **Check A:** `SELECT id, sha256, uploaded_at, parsed_at, status FROM workbook_imports WHERE ...` — does a row exist for the corrected June workbook?
- **Check B:** if yes, are there staging rows in `workbook_daily_rows` / `workbook_processed_rows` / etc. tied to that importId? Row counts by target-table hint?
- **Check C:** any audit row from `promoteWorkbookImport` — has D1 promotion executed?
- **Check D:** operational tables — is `processed_units_daily` empty for June? `inbound_loads` empty? `outbound_materials`? `landfilled_units`? `consumer_dropoffs`?
- **Check E:** `site_inventory_snapshots` — is there a June 1 physical anchor?

**Expected outcome one of three states:**
- **State A:** workbook never uploaded/parsed → operational tables empty because no source. Fix: Bill uploads via `/admin/audit/workbook/upload`, parse creates staging, then promote.
- **State B:** parsed to staging but promotion never invoked → operational tables empty because Bill (or an admin) never clicked Promote. Fix: run `promoteWorkbookImport(importId, {scope: 'woodland', from: '2026-06-01', to: '2026-06-30'})`.
- **State C:** promotion RAN but produced zero rows OR failed silently → needs debug. This would be a surprise; ADR-0048 D1 audits every promotion.

Whichever state, document findings before proceeding.

### §1.2 — D7 activation gate state

**Question:** are the two Bill-owned ops gates for D7 actually closed?

- **P1-3 Restore drill:** `docs/handoffs/restore-drills.md` claims CLOSED 2026-07-06; OPEN-ITEMS.md and later handoffs still call it open. Which is authoritative? Resolve the contradiction — check `restore_drill_runs` table (or wherever drill executions are recorded) for a real completion audit.
- **P1-4 `RESTIC_PASSWORD` off-box:** confirm the secret is stored off-CHAD-HQ per the ops contract. Check `docs/operator/backup-restore.md` (or equivalent) for the runbook + verify Bill has the off-box copy referenced.
- Report the actual state of both gates to Bill in the Phase 0 findings.

### §1.3 — Currently in use vs. dormant

**Question:** are ANY operational rows landing today across any surface?

- Check `inbound_loads` — are operators using the iPad flow anywhere? Any rows from the last 30 days with `source='ipad'`?
- Check `consumer_dropoffs`, `outbound_materials`, `landfilled_units`, `processed_units_daily` — any rows from the last 30 days?
- Check `site_inventory_snapshots` — has anyone recorded a physical count?

**Expected:** likely all zero given Bill's report. Confirm.

### §1.4 — Daily Production Report state (ADR-0030)

**Question:** what does the current Daily Production Report contain? Does it have any inventory line already, or is that section not yet built?

- Read `docs/adr/0030-daily-production-report.md` head + tail (recently changed per state diff)
- Check the report generator (`src/lib/reports/daily-production/` or equivalent) for existing inventory hooks
- Identify where an EOD inventory block would insert cleanly

---

## §2 — Execution plan (Phases 1–4)

### Phase 1 — Backfill promotion (whatever the diagnosis says)

**If §1.1 finds State A** (never uploaded): coordinate with Bill to upload the June workbook (Woodland corrected version + Eugene's Jun 24–30 log if available). Then run parse, then promote. Bill has confirmed the corrected Woodland file (SHA `1eeeccbde0…`) is in file-drop; Eugene may need a separate upload from Kelsey or Rick.

**If §1.1 finds State B** (staged, not promoted): run `promoteWorkbookImport(importId, {site: 'woodland', from: '2026-06-01', to: '2026-06-30'})`. Verify:
- Every promoted row carries `source='import'`
- Audit rows written per target table with counts
- June 1 opening balance seeded as `site_inventory_snapshots` anchor
- June 30 balance == **3,977** (corrected close per PR #129 root cause; supersedes the ADR-0048-stated 4,062 which had the DAY23 Recology Healdsburg double-count)
- Then repeat for Eugene scope Jun 24–30 once its workbook is available

**If §1.1 finds State C** (silent failure): debug the promotion path. Add explicit logging, capture failure mode, report + fix.

**Deliverable:** Loads & Inventory surface reads real June-close numbers by end of Phase 1, verified against Rick's ledger figure of 3,977 (= 3,748 program + 229 non-program).

### Phase 2 — Close the D7 gate for managers

Per §1.2 findings:

- **If restore drill genuinely done:** update OPEN-ITEMS.md to reflect CLOSED, remove stale open references from subsequent handoffs, ensure the audit trail from the drill is preserved and discoverable.
- **If not done:** run the drill NOW — this is a small operational cost and unblocks manager access to their own floor numbers. Document per `restore-drills.md` conventions.
- **RESTIC_PASSWORD off-box confirmation:** Bill confirms with a keystroke; document confirmation in the operator runbook.

Once both gates close, flip the D7 role check in `src/lib/loads/record-guards.ts` (`assertLoadsInventoryActivated`) from admin-only to manager+. Site managers (Morena, Janette, Rick) then see Loads & Inventory on their own dashboard tile at `/dashboard/<site>/loads-inventory`.

**Deliverable:** Morena at Woodland, Janette at Woodland, Rick at Eugene can open Loads & Inventory and see their site's actual on-hand numbers (post-Phase-1 backfill).

### Phase 3 — Paper-bootstrap workflow (enable manager-driven aggregate entry without iPads)

**Design decision required** (§3.1 below): pick the ongoing capture model — anchor-daily vs. backfill-and-run.

Regardless of choice, the manager surfaces at `/dashboard/<site>/loads-inventory` should support the six input streams:

1. **Physical count** — program + non-program pool split (already supported per ADR-0037 §3, but currently admin-gated behind D7)
2. **Consumer drop-offs** — already supported (incentive / unpaid / illegal)
3. **Outbound materials** — already supported (renovation whole units subtract; baled/shredded weight-only)
4. **Landfilled units** — already supported (reason: bed-bug / soiled / water-logged / other)
5. **Verified inbound loads** — currently requires an operator-created load (iPad). See §3.2 for the paper-bootstrap adjustment.
6. **Daily close (processed units)** — currently super-admin-only at `/admin/processed-units`. See §3.3 for the manager-delegation decision.

Add operator-facing guidance to `docs/operator/loads-inventory-foundations.md` reflecting the paper-bootstrap flow: each morning enter a physical count, throughout the day enter events as they happen, EOD verify balance vs. anchor.

**Deliverable:** managers can operate Loads & Inventory from paper daily logs without any iPad involvement.

### Phase 4 — EOD inventory on Daily Production Report (ADR-0030)

Once Phase 1 backfills the historical baseline AND Phases 2–3 enable ongoing capture, wire EOD inventory into the daily production report.

Report addition — **new section: End-of-Day Inventory** (per site, per day):

- Program units on hand
- Non-program units on hand
- Total on hand
- Delta from yesterday's EOD (net change: inbound − outbound)
- Program / NP split % of total
- Days since last physical count (staleness indicator)
- Latest count date + counter

Wired to the same `computeRunningBalance` function used by the manager surface — single computation, no duplication. Report generator reads `site_inventory_snapshots` for the latest anchor + operational tables for deltas.

**Gate:** the EOD block should only render for sites where the running balance is trusted (`site_inventory_snapshots` has a `'measured'` anchor within the last N days — default N = 14). Otherwise render "Inventory pending physical count" with a warning band.

**Deliverable:** Daily Production Report includes EOD inventory the day after Phases 1–3 complete + at least one physical count has been recorded.

---

## §3 — Decisions Bill needs to make (surfaced during planning)

### §3.1 — Ongoing capture model: anchor-daily vs. backfill-and-run

**Anchor-daily:** manager enters physical count every morning. Balance always starts fresh from a known-good number. No dependence on inbound_loads accuracy. Requires morning discipline — someone counts before shift starts.

**Backfill-and-run:** Physical count is a periodic anchor (weekly? monthly?). Between counts, the balance runs on inbound + outbound math. Requires trust in the inbound stream, which requires manager verify discipline daily. More flexible but drifts over time.

**Recommendation for Woodland's current reality:** anchor-daily for the first month while capture flow stabilizes; move to weekly-anchor once numbers hold up against verified in/out.

Claude Code should stub both patterns in the runbook; Bill picks one operationally.

### §3.2 — Inbound loads without iPads

Three sub-options for the paper-bootstrap period:

- **(a) Skip inbound entry entirely** — rely on daily physical counts to catch reality. Balance drifts between counts.
- **(b) Manager enters daily aggregate inbound** — one synthesized `inbound_loads` row per day per site, aggregating that day's inbound. Verified with program/NP split. Loses per-load detail but preserves inflow math.
- **(c) Manager enters per-source aggregate inbound** — one row per day per source (e.g., Sleep Number Sacramento, Ikea Palo Alto). Retains source attribution for reporting. Slightly more work than (b).

Option (b) is the sweet spot for paper: preserves the inflow arithmetic without demanding operator-level detail.

Claude Code should implement option (b) as the manager path — a "Bulk daily inbound entry" affordance that creates a properly-formed synthesized `inbound_loads` row with `source='paper_bulk'` (new source enum value) + `total_units` + program/NP split. Preserves the schema, tags the provenance clearly, converts to per-load when iPads come online.

### §3.3 — Delegate daily close to managers?

**Current design:** `/admin/processed-units` is super-admin-only. Bill enters the daily close. Rationale: this is the number MRC bills from — highest-integrity surface.

**Question:** should managers (Morena at Woodland, Rick at Eugene) enter the daily close themselves, with Bill's role becoming review/close/lock?

**Option A** — Keep super-admin-only. Bill enters daily close based on manager reports. Simple but bottlenecked on Bill's availability.

**Option B** — Managers enter daily close on `/dashboard/<site>/processed-units-close` (new manager route, mirrors `/admin/processed-units`). Bill retains close-day-lock authority. Managers can amend before close; only Bill closes.

**Option C** — Managers enter AND close. Bill audits. Cheapest to Bill's time but weakens the money-safe boundary.

**Recommended:** Option B — managers enter, Bill closes-and-locks. Delegates the daily grunt work but preserves audit boundary. Adds one step to Bill's day (review + close) but removes the "wait for Bill" latency from managers.

### §3.4 — What about Kelsey's role in inventory?

Kelsey has been the compliance / MRC-facing SME. Post-8/8 transition, Rick becomes interim MRC point person (per user memory). Does inventory flow to Rick's compliance surfaces automatically once numbers are real?

Not strictly this handoff's scope — but flag that Phase 4's Daily Production Report becomes the surface where Rick sees inventory daily. If MRC compliance surfaces need inventory too, note it in a follow-up.

---

## §4 — Daily Production Report EOD inventory wire-up (design detail)

Extends ADR-0030. New section under the existing report structure:

```
============================================
End-of-Day Inventory — Woodland
============================================
Program units on hand:      3,748
Non-program units on hand:    229
Total on hand:              3,977

Change from yesterday:      -142 (net outbound)
Program / NP split:         94.2% / 5.8%

Latest physical count:      2026-07-22 (today)
Counter:                    Morena
```

Or, when the balance is stale:

```
============================================
End-of-Day Inventory — Woodland
============================================
⚠ Inventory pending physical count
Last measured anchor:       2026-06-30 (22 days ago)
Computed balance is drift-prone; verify with a floor count.
============================================
```

Implementation:

- Add `getEodInventorySnapshot(site, date)` in `src/lib/loads/eod-inventory.ts` (new module).
- Reuse `computeRunningBalance` from ADR-0037.
- Determine anchor freshness against a configurable `EOD_INVENTORY_STALE_DAYS` (default 14).
- Report generator calls it per site per day; renders either the healthy block or the stale warning.
- Fixture tests: healthy state (fresh anchor + recent transactions), stale state (no anchor within window), zero state (empty operational tables — pre-backfill).

---

## §5 — Actions for Bill

1. **Confirm the June Woodland workbook is in file-drop** and named the corrected version (SHA `1eeeccbde0…`, 759,720 bytes). Or upload if not present.

2. **Provide Eugene's Jun 24–30 daily log** — Rick or Kelsey likely has it. If not available, Phase 1 executes Woodland only; Eugene backfill remains open until the file arrives.

3. **Confirm restore-drill state** — is it actually closed per `restore-drills.md`, or is it still open per OPEN-ITEMS? Five-minute reconciliation.

4. **Confirm `RESTIC_PASSWORD` off-box** — one keystroke; unblocks D7 gate closure.

5. **Pick §3.1 ongoing capture model** (anchor-daily vs. backfill-and-run) — Claude Code implements both stubs; Bill picks operationally.

6. **Pick §3.3 daily-close delegation** — Options A/B/C above.

7. **Coordinate the on-site paper-total workflow rollout** with Morena, Janette, Rick — brief them on the new manager surface access + daily entry cadence.

---

## §6 — Actions for Claude Code (execution order)

**Full green light after Phase 0 investigation reports.** No stopping between Phases 1–4 unless a Phase-1 diagnostic reveals a bug requiring separate work.

1. **Phase 0 investigation** per §1. Report findings to Bill via handoff comment or ntfy summary. Include specific SQL / audit-row evidence.

2. **Phase 1 backfill promotion** per §2. Verify against Rick's 3,977 close. Ntfy on success (and on failure with the specific error).

3. **Phase 2 D7 gate close** per §2 (assuming §1.2 confirms both sub-gates are closable or already closed). Update `assertLoadsInventoryActivated` in `src/lib/loads/record-guards.ts`. Update runbook. Ntfy Morena / Janette / Rick that the surface is live for them (email + ntfy).

4. **Phase 3 paper-bootstrap workflow:**
   - Implement §3.2(b) "Bulk daily inbound entry" affordance on `/dashboard/<site>/loads-inventory`, with new `sources.name = 'paper_bulk'` synthesized entry (or `inbound_loads.source='paper_bulk'` enum) — pick whichever fits the existing schema cleanly
   - Implement §3.3 Option B "Managers enter daily close, Bill closes" — new route `/dashboard/<site>/processed-units-close` mirroring the admin surface, but without close-day authority; Bill's `/admin/processed-units` retains close-day + amendment
   - Update `docs/operator/loads-inventory-foundations.md` with the manager paper-daily workflow

5. **Phase 4 EOD inventory on Daily Production Report** per §4. Extend ADR-0030 with the new section spec.

6. **Runbook + operator guide updates:**
   - `docs/operator/loads-inventory-foundations.md` — manager access, paper daily workflow, ongoing capture model
   - `docs/operator/daily-production-report.md` — EOD inventory section, stale warning behavior
   - OPEN-ITEMS.md — reconcile the restore-drill contradiction; close D7 P1-3 and P1-4 explicitly

7. **Tests:**
   - Fixture tests for the Bulk daily inbound entry (program/NP split, source attribution)
   - Fixture tests for manager-enter, admin-close on daily close
   - Fixture tests for EOD inventory report (healthy / stale / zero states)
   - Regression: the D7 gate close doesn't break admin-only surfaces

**Do NOT:**
- Do NOT skip Phase 0 investigation. Diagnose before executing.
- Do NOT close the D7 gate without confirming BOTH sub-gates (restore drill + RESTIC off-box) are actually done.
- Do NOT promote the June workbook without verifying scope doesn't overlap live-entered data (ADR-0048 D1 refuses this by design; ensure the refusal path is tested).
- Do NOT auto-close daily production report inventory blocks with the healthy-state format if the anchor is stale — always render the warning band.
- Do NOT introduce a manager-facing daily close route that ALSO grants close-day-lock authority; keep the money-safe boundary intact per §3.3 Option B.

---

## §7 — Success criteria

**Phase 0 (investigate):**
- Findings documented per §1 items
- Bill has clear picture of state before Phase 1 executes

**Phase 1 (backfill):**
- Loads & Inventory surface reads Rick's known 3,977 June-close (program 3,748 / non-program 229) for Woodland
- Eugene June 24–30 promoted if workbook available; otherwise flagged as open
- Audit rows per target table with row counts
- Re-run is a no-op (idempotency confirmed)

**Phase 2 (manager access):**
- Restore-drill contradiction resolved
- RESTIC_PASSWORD off-box confirmed
- Morena, Janette, Rick can access `/dashboard/<site>/loads-inventory` and see numbers
- OPEN-ITEMS.md reflects closure of P1-3 and P1-4

**Phase 3 (paper-bootstrap flow):**
- Managers can enter daily physical count, drop-offs, outbound, landfilled from paper
- Managers can enter daily aggregate inbound via new "Bulk daily inbound entry" affordance
- Managers can enter daily processed close on new `/dashboard/<site>/processed-units-close`; Bill retains close-day authority
- Runbook updated with the operator workflow

**Phase 4 (report):**
- Daily Production Report includes End-of-Day Inventory section per site
- Fresh anchor renders the healthy block
- Stale anchor renders the warning band
- Zero state (pre-backfill) renders gracefully

**Overall:**
- Bill can open the Daily Production Report tomorrow morning and see actual EOD floor numbers for Woodland (and Eugene once its backfill is in)
- Morena, Janette, Rick own their site's inventory in Vision
- Bill's role shifts from "enter numbers" to "review + close + audit"
- The path forward when iPads come online is additive — no rework of the paper-bootstrap layer

---

## §8 — Session close

Loads & Inventory has been fully built (ADR-0037 + ADR-0048 + ADR-0055) but never lit up with real data because:
- The June workbook backfill promotion has never executed (or produced zero rows silently — Phase 0 clarifies which)
- The manager surface is admin-gated (D7 activation)
- The daily close is super-admin-only (`/admin/processed-units`)
- The operator iPad flow isn't in use

This handoff closes all four gaps together, with paper-total entry as the interim capture pattern until iPads come online. EOD inventory on the Daily Production Report is the visible outcome — once it shows real numbers, Vision has actually turned on for the floor.

No new blockers surface from this session. Everything is a matter of executing existing infrastructure + a small set of new manager surfaces that fit the existing patterns.




---

## Amendment A — 2026-07-22 evening (state reconciliation + Phase 2 superseded + Phase 5 added: remove outdoor storage from Vision)

**Context:** Between the original handoff push (2026-07-22 19:30 UTC) and this amendment, significant work landed in the repo that supersedes Phase 2 of the original plan. Bill also directed a new scope addition — remove outdoor storage from Vision entirely, per DR3's operating reality that units are never stored outside.

### §A.1 — State changes since original handoff (last ~4 hours)

**Loads & Inventory D7 GO-LIVE — SHIPPED 2026-07-22:**

- `loads_inventory` rollout flipped `pilot → live` for BOTH Woodland and Eugene at `/admin/rollout` (audited, attributed to Bill).
- Managers and operators are now activated at both sites.
- `assertLoadsInventoryActivated` reads this per-site surface at request time — immediate, no deploy needed.
- Reversible via inverse flip.
- **P1-3 restore drill: MET** (`d4917d0`, passed twice against real R2 snapshot).
- **P1-4 `RESTIC_PASSWORD` off-box: CONFIRMED** via Fleet 1Password item (SHA-256 matches on-box).
- **`OPEN-ITEMS.md` O-3 / `restore-drills.md` / ADR-0037 contradiction: RECONCILED — all now CLOSED.**

**MyMRC billing-field capture — SHIPPED 2026-07-22:**

- ADR-0057 D3 addendum: batched `getRecordWithFields` Aura POST replaces the racy per-record navigation-interception detail fetch.
- Prior transport captured ~0.4% of billing unit-counts. New transport: 200/200 SUCCESS at ~0.5 s per batch.
- MyMRC data now flows with real haul-level billing detail, not just record IDs.
- New: `src/lib/mymrc/record-fields-client.ts`, `src/lib/mymrc/enrich-details.ts`, `scripts/mymrc-enrich-details.mjs`.
- Impact on this handoff: Phase 4 EOD inventory report gains a downstream — Amendment 5 Phase 2 (Pacific Trucking haul cross-check) unblocks sooner than originally scoped.

**Bonus daily entry mattress footer — SHIPPED 2026-07-22 (out of scope for this handoff, noted for completeness).**

**Follow-up flagged:** `outbound.ts` `allocation_pct` semantics — nullable, does not affect the running balance, resolve before Kelsey's 8/1 → 8/8 departure. Not in scope here.

### §A.2 — Phase 2 SUPERSEDED

The original Phase 2 (§2 Phase 2 in the handoff body — "Close the D7 gate for managers") is **entirely superseded** by the shipped GO-LIVE. Claude Code does NOT need to:

- Modify `assertLoadsInventoryActivated` in `src/lib/loads/record-guards.ts` (per original §6 item 3)
- Reconcile the restore-drill contradiction (already done)
- Confirm `RESTIC_PASSWORD` off-box (already confirmed)
- Verify the D7 gate before proceeding to Phase 3 (gate is already closed via rollout)

Original §5 Actions for Bill items 3 and 4 (restore-drill and RESTIC confirmations) are also both **already complete**.

**What Claude Code DOES do at start of Phase 2 work window:**
- Verify the rollout surface shows `loads_inventory` = `live` at both `woodland` and `eugene` (single query, sanity check)
- If for any reason the flip has reverted, escalate to Bill — do NOT execute Phase 3 while the gate is closed
- Otherwise proceed directly to Phase 3

### §A.3 — Phase 0 investigation checklist simplification

With D7 already closed, some checks in §1 become vestigial:

- **§1.2 (D7 activation gate state):** SKIP. Both sub-gates confirmed closed today (see §A.1 above).
- **§1.1, §1.3, §1.4:** UNCHANGED — still needed for backfill promotion state, live capture state, and Daily Production Report state.

### §A.4 — Phase 5 (NEW) — Remove outdoor storage from Vision entirely

**Directive:** Bill (2026-07-22): *"we will also remove the units outdoor we are never allowed to store units outside. this can't be in the system."*

DR3's operating reality is that units are never stored outside — this is a compliance stance regardless of what the MRC contract's stated 5,000-unit outdoor allowance permits. The system should not offer to track outdoor storage, warn on outdoor caps, or let anyone enter a non-zero outdoor value. Cleanest removal is to drop the concept from the schema, UI, math, warnings, and docs.

#### §A.4.1 — What's in the system today (evidence)

From current state (see `docs/adr/0037-loads-inventory-foundations.md` L122 and `docs/QUESTIONS.md` L42 verbatim):

- `site_inventory_snapshots` carries **separate `indoor` / `outdoor` / `in_processing` fields** (with an implicit or stored `total`).
- ADR-0037 references "existing indoor/outdoor/in-processing fields unchanged" — these fields were carried forward from the pre-ADR-0037 schema, not created by it.
- **CA storage-limit warnings: 3,500 (warn) / 5,000 (hard)** — Claude Code must verify whether these are OUTDOOR-specific or TOTAL (the ADR line is ambiguous; the MRC contract's "5,000 units outdoor at Woodland" phrasing strongly suggests outdoor-specific but code-truth wins).
- **OR storage-limit: 6,000** — likely total (Eugene has no outdoor cap in the MRC contract per available docs; verify).
- **`docs/MRC-CONTRACTS.md` L43** references "5,000 units outdoor at Woodland" as the contracted allowance.

#### §A.4.2 — Pre-migration audit

Before dropping the column, run a one-off audit:

```sql
SELECT id, site_id, snapshot_date, indoor, outdoor, in_processing, total
FROM site_inventory_snapshots
WHERE outdoor IS NOT NULL AND outdoor > 0;
```

**If any rows return non-zero outdoor values** (unexpected but possible from early data entry):
- Fold each non-zero outdoor into `indoor` on the same row (`indoor = indoor + outdoor`; `outdoor = 0`)
- Write an audit row per updated snapshot documenting the fold (source: 'adr-0037-outdoor-removal')
- Then proceed with column drop

**If all outdoor values are null or zero:** no data fold required, straight to column drop.

Deliverable: audit output + fold audit rows if any.

#### §A.4.3 — Schema migration

Migration name suggestion: `20260723_remove_outdoor_from_site_inventory_snapshots`.

- Drop column `outdoor` from `site_inventory_snapshots`
- If `total` is a stored column: verify no existing row has `total != indoor + in_processing` after the fold (§A.4.2); if divergence exists, add a fix-up in the same migration
- If `total` is a derived column (view / computed): update the derivation to drop the outdoor addend

Migration MUST clean-replay on empty PG16. CI gate.

#### §A.4.4 — Code + type refactor

Claude Code performs a full ripgrep pass on the term `outdoor` (case-insensitive) across:

- `src/lib/loads/*` — running balance, physical count, snapshot handling
- `src/lib/reports/*` — any surface that reads or displays outdoor
- `src/app/**/*` — UI surfaces
- `prisma/schema.prisma` — model definition
- All test files — fixtures + assertions
- Any migration SQL

Removes:
- `outdoor` field from Prisma model + types
- Any `outdoor` field from Zod / validation schemas
- Any `total = indoor + outdoor + in_processing` calculations → `total = indoor + in_processing`
- Any UI input capturing outdoor
- Any UI display of outdoor
- Any test fixture using non-zero outdoor

Keeps:
- `indoor` field (unchanged)
- `in_processing` field (unchanged — this is units currently being processed, different concept)
- `total` field (recomputed without outdoor)
- Program / non-program pool split logic (per ADR-0037 §3 — unchanged, orthogonal to indoor/outdoor)

#### §A.4.5 — Storage-limit warnings

Claude Code investigates the actual semantics of the CA 3,500/5,000 and OR 6,000 warnings in code:

- If **outdoor-specific**: remove entirely. DR3 never stores outside; the cap is moot; the warning would fire on 0 unless someone enters a non-zero outdoor (which after §A.4.4 becomes impossible).
- If **total-based**: preserve them. Woodland's total capacity has real-world implications regardless of indoor-vs-outdoor split. Same for Eugene.
- If **indoor-specific**: preserve. Indoor capacity is DR3's real operating constraint.

Bill's directive is to remove the outdoor concept — but if the storage-limit warning is protecting a real total-capacity boundary that happens to have been named after outdoor in old contract language, the warning stays with its underlying threshold reconsidered.

Deliverable: an evidence-based decision documented in the migration or a post-acceptance ADR-0037 addendum, one of:
- "Outdoor-specific warning removed; no CA total cap enforced"
- "Warning re-scoped to CA total capacity; threshold X preserved as total cap"

**Recommendation for Bill's review:** Woodland's real operating cap is likely the floor square footage times units-per-square-foot for indoor storage. That's the number MRC would audit us on if it ever came up. If Claude Code finds the 3,500/5,000 is outdoor-specific, the warning goes away entirely — Bill can reintroduce a total-based cap later if operationally warranted, but no automated warning is misleading.

#### §A.4.6 — Documentation updates

- **`docs/adr/0037-loads-inventory-foundations.md`** — remove L122 reference to "indoor/outdoor/in-processing fields unchanged"; replace with "indoor + in-processing fields, following ADR-0037 addendum (2026-07-22) removing outdoor from Vision per DR3 operational compliance."
- **`docs/MRC-CONTRACTS.md`** — annotate the "5,000 units outdoor at Woodland" line: "*Contracted allowance not exercised: DR3 does not use outdoor storage. Vision does not track outdoor units per ADR-0037 addendum (2026-07-22).*"
- **`docs/QUESTIONS.md`** — update L42 to reflect the current split (indoor/in_processing/total), removing outdoor from the described model
- **`docs/operator/loads-inventory-foundations.md`** — physical count entry now captures indoor + in_processing (+ implicit total); update any prose about outdoor
- **New audit log entry / ADR-0037 addendum** — one paragraph noting the removal decision + directive attribution + migration reference

#### §A.4.7 — Testing

- Unit tests: any `outdoor` fixture removed from unit-level tests; running-balance tests updated to sum `indoor + in_processing`
- Integration test: after migration replay on empty DB, physical count entry accepts `indoor` + `in_processing` only and produces the correct `total`
- Regression: the balance computation continues to match Rick's June close of 3,977 after the removal (assuming Phase 1 backfill precedes Phase 5)

### §A.5 — Updated Actions for Bill

Actions dropped (already complete per §A.1):

- ~~Confirm restore-drill state~~ — DONE
- ~~Confirm `RESTIC_PASSWORD` off-box~~ — DONE

Actions remaining from §5 (unchanged):

1. Confirm June Woodland workbook in file-drop (SHA `1eeeccbde0…`)
2. Provide Eugene's Jun 24–30 daily log (or flag as pending)
3. Pick §3.1 ongoing capture model (anchor-daily vs. backfill-and-run) — recommend anchor-daily for first month
4. Pick §3.3 daily-close delegation — recommend Option B (managers enter, you close)
5. Coordinate paper-workflow rollout with Morena, Janette, Rick

Actions added for Phase 5:

6. Approve the storage-limit warning outcome once Claude Code reports whether the 3,500/5,000/6,000 caps are outdoor-specific or total-based — one keystroke reply after their investigation

### §A.6 — Updated Actions for Claude Code (execution order)

Original §6 items 1, 2 unchanged (Phase 0 investigation with §A.3 simplification, then Phase 1 backfill promotion).

**Item 3 — REMOVED:** Phase 2 D7 gate close. Superseded by GO-LIVE per §A.2.

Original §6 items 4, 5 renumbered as 3, 4 (Phase 3 paper-bootstrap workflow, Phase 4 EOD inventory on Daily Production Report).

**NEW Item 5 — Phase 5: Remove outdoor storage from Vision** per §A.4 above.

Ordering rationale: Phase 5 executes AFTER Phase 1 backfill (so the pre-migration audit runs against the fully-populated `site_inventory_snapshots` including the June 1 anchor row). Phase 5 executes BEFORE Phase 4 EOD inventory on Daily Production Report (so the report code is written against the post-removal schema — no need to remove references later).

Recommended sequence: **Phase 0 → Phase 1 → Phase 3 → Phase 5 → Phase 4**

Original §6 items 6, 7 (runbook updates + tests) unchanged, with the additions per §A.4.6 and §A.4.7.

### §A.7 — Updated success criteria

Phase 2 items removed from §7.

**New Phase 5 success criteria:**
- Pre-migration audit output confirms all outdoor values are null/zero (or fold audit rows written if any non-zero)
- `outdoor` column dropped from `site_inventory_snapshots`
- Prisma model + types updated; no build error references `outdoor`
- All UI surfaces capturing or displaying outdoor removed
- CA / OR storage-limit warnings correctly classified (outdoor-specific removed; total or indoor preserved) with evidence
- Docs updated per §A.4.6
- Migration clean-replays on empty PG16
- Post-Phase-5 running balance still produces Rick's 3,977 June close for Woodland

### §A.8 — Session close (amended)

The original handoff planned a manager-access unblock that shipped independently between planning and push. Phase 2 is retired. Phase 5 adds a compliance-driven schema cleanup that matches DR3's operational reality (no outdoor storage).

Net scope of PR #162 as amended:
- Phase 0: investigation (workbook + operational tables + report state)
- Phase 1: June backfill promotion → 3,977 close verified
- Phase 3: paper-bootstrap workflow (manager surfaces for daily aggregate entry; delegation of daily close per §3.3 Option B)
- Phase 5: outdoor storage removed from Vision
- Phase 4: EOD inventory on Daily Production Report (last, so it's built against the post-outdoor-removal schema)

Same green-light execution posture. Claude Code investigates first, then runs through Phase 1 → 3 → 5 → 4 without stopping.
