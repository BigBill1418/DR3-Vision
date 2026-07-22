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
