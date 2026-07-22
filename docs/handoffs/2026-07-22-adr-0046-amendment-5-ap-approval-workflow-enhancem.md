# 2026-07-22 — ADR-0046 Amendment 5: AP approval workflow enhancements (structured input, auto-extraction, dual approval, variance detection, history search, equipment linking)

**Session context (Bill × Claude, 2026-07-21 evening → 2026-07-22):**

Kelsey submitted written feedback last week on the live AP module (`operator/ap-approvals.md`). Bill worked through it item-by-item this session. Every one of her four concerns turned into a shipable decision with a concrete design.

**Kelsey's core insight (verbatim):** *"If all invoices are approved without thought, the approval is completely performative."* Her whole feedback pack was a plea to build vetting friction into the workflow, not remove it. Amendment 5 formalizes that stance.

**Current state (as of 2026-07-21, before this amendment):**
- Approve/Reject/Hold/NOT-DR3 all require notes (shipped 2026-07-21 per CHANGELOG)
- Site tag required on decisions
- First-action-wins with atomic conditional-update
- 5-approver roster: Morena, Rick, Janette, Kelsey (until 8/8), Bill
- Vendor + amount fields are OPTIONAL on decide
- No historical comparison, no variance detection, no second-approval workflow, no equipment linking, no invoice search

**What this handoff delivers:**
1. Amendment 5 text (§1) — exact markdown to insert into `docs/adr/0046-vendor-invoice-approval-mailbox.md`
2. Consolidated schema deltas (§2)
3. Extraction pipeline detail (§3)
4. Actions for Bill (§4)
5. Actions for Claude Code (§5)
6. Success criteria (§6)

**Execution posture:** Full green light. Ship all four items + Phase 2 MyMRC cross-check as a single amendment. No phasing.

---

## §1 — Amendment 5 draft (Claude Code: append to `docs/adr/0046-vendor-invoice-approval-mailbox.md`)

```markdown
## Amendment 5 — Approver-side vetting friction + dual approval + variance detection + history + equipment linking (2026-07-22)

**Trigger:** Kelsey's post-live feedback on the AP module (delivered 2026-07-15, worked through with Bill 2026-07-21 → 2026-07-22). Her operating stance: performative approval is worse than no approval. This amendment installs structural friction on the Approve path so that every approval carries recorded vetting, and formalizes the second-eyes workflow that Kelsey used to perform manually.

**Scope:** Four decisions covering the approver-facing side of the module, plus one Phase-2 dependency on ADR-0057 for MyMRC cross-checking. Reject / Hold / NOT-DR3 dispositions are untouched except where explicitly noted.

### D-M5-1 — Structured decide input (replaces single freeform note)

**Approve requires four fields, all non-empty:**

| Field | Type | Notes |
|---|---|---|
| `vendor` | freeform text | Approver types the vendor name. Helper prompt above the field: *"Enter the vendor name carefully — check spelling and capitalization. This appears on the returned decision email and Mary's GP filing."* Vendor doesn't need to be pre-registered; Vision matches loosely to existing vendors via the baseline table (§D-M5-4) but accepts any text. |
| `explanation` | freeform text | Replaces today's single freeform "note". Prompt: *"What was this transaction for? Include any relevant context (site work, repair reason, event, etc.)."* Same non-empty gate as today. |
| `confirmed_amount_cents` | integer | Approver-confirmed dollar amount. Pre-filled from the auto-extraction pipeline (§D-M5-2) with a confidence badge. Approver can override. |
| `equipment_link_ids[]` | multi-select | Vehicles/equipment referenced by the invoice. Multi-select. Always shown. Approver picks one or more OR the explicit `Not equipment-related` option. Field is required with that explicit-none option available (§D-M5-6). |

**Reject / Hold / NOT-DR3** keep their existing single reason-field pattern — no vendor / explanation / amount / equipment required to reject a bogus invoice.

**Rationale:** Kelsey's example (Sunbelt Rentals mower charged to Stockton by mistake) — if the approver had to type "mower rental" and pick an equipment record from Stockton's fleet, they'd have paused at the equipment picker realizing no Stockton mower exists. The friction IS the vetting.

### D-M5-2 — Automatic amount extraction at intake (hybrid local + Claude API)

**Runs at intake** (during `runApPoll`, right after body sanitize + attachment persist), before the request appears in the AP queue. Result stored on the `ap_requests` row.

**Pipeline (hybrid, ordered):**

1. **Local text extraction** — pdf-parse on attached PDFs + heuristic scan of email body text. Regex patterns for common invoice totals: `Total(?: Due)?:?\s*\$?[\d,]+\.\d{2}`, `Amount Due:?\s*\$?[\d,]+\.\d{2}`, `Balance Due:?\s*\$?[\d,]+\.\d{2}`, `Grand Total:?\s*\$?[\d,]+\.\d{2}`. Also captures ALL candidate amounts in the document for later disambiguation.
2. **Confidence scoring:**
   - `HIGH`: exactly one distinct match on `Total`/`Amount Due`/`Balance Due`/`Grand Total`, agrees with any repeated `Total:` line
   - `MEDIUM`: single match on any pattern but multiple candidates exist in the doc; or single non-canonical pattern match
   - `LOW`: multiple `Total`-like matches disagree; or no canonical pattern found, only bare amounts extracted
   - `FAILED`: no dollar amounts extracted at all (scanned image with no OCR, empty body)
3. **Claude API fallback** — fires when local confidence is `LOW` or `FAILED`. Sends the sanitized body text + attachment text (extracted via pdf-parse; images sent as base64 up to size cap) to Claude with a structured extraction prompt: *"Extract the total invoice amount and vendor name. Return JSON with fields: amount_cents (integer), vendor (string), confidence (high|medium|low), reasoning (string)."* Uses the `anthropic` SDK via `~/.dr3-vision-secrets/anthropic.env` (new secret). Model: `claude-sonnet-4-6` for cost efficiency at DR3's invoice volume (~50-100/mo). Timeout 30s.
4. **Storage:** `ap_requests.extraction jsonb` field carries `{best_amount_cents, best_vendor, confidence: 'high'|'medium'|'low'|'failed', source: 'local'|'claude_api', candidates: [{amount_cents, source_hint}], attempted_at, model?, cost_cents?, error?}`.

**Failure mode:** if Claude API is unavailable OR local extraction fails outright, the request lands with `extraction.confidence = 'failed'` and `best_amount_cents = null`. Approver sees "Amount not extracted — please enter manually" and provides `confirmed_amount_cents` themselves. Approval still gates on all four required fields.

**Approver UX (in decide panel):**
- Best-guess amount pre-filled in the `confirmed_amount_cents` input
- Confidence badge next to the input:
  - `HIGH` → **green** ✓ badge, label *"Verified"*
  - `MEDIUM` → **yellow** ⚠ badge, label *"Please verify"*
  - `LOW` → **red** ⚠ badge, label *"Low confidence — verify against invoice"*
  - `FAILED` → no badge, input is blank, placeholder *"Enter amount from invoice"*
- Approver can always override the pre-filled value

**Cost budget:** at $0.05-0.20/invoice × ~50-100/mo (Claude API fallback path only, when local fails), total marginal cost is <$20/mo. Cost gets logged per-invoice for observability.

### D-M5-3 — $1,000 second-approval workflow

**Threshold:** `confirmed_amount_cents >= 100000` (i.e., $1,000 or more) triggers second approval.

**Applies to Approve only** — Reject / Hold / NOT-DR3 remain single-approver regardless of amount.

**Second approvers, by site tag:**
- Woodland → **Bill** (admin, always eligible)
- Eugene → **Shannon Rockwell** (must be provisioned as an active approver, may need admin role)
- NOT DR3 → **NOT APPLICABLE** — invoice returns to sender, no payment happens, no second approval needed

**State machine additions:**

Existing states: `pending | approved | rejected | quarantined` plus the informal `pending_review` (Hold — represented by columns, not a status). Adds:

```
pending_second_approval
  -- request has first approval + all four required fields
  -- awaiting second-approver decision
```

Transitions:

```
pending
  ├── Reject → rejected                                (any approver, unchanged)
  ├── Hold → pending (pending_review column set)      (any approver, unchanged)
  ├── NOT DR3 → rejected (with disposition=not_dr3)   (any approver, unchanged)
  ├── Approve with confirmed_amount < $1,000
  │     → approved                                     (any approver, single-action, unchanged)
  └── Approve with confirmed_amount >= $1,000
        → pending_second_approval                      (any approver except site's second approver)
        └── first_approver_id, first_approved_at, and all four field values stamped

pending_second_approval
  ├── Second-approver Approve → approved               (Bill for Woodland, Shannon for Eugene)
  └── Second-approver Reject → rejected                (with second_approver_note explaining override)
```

**First-approver == second-approver edge case:** if Bill (admin) is the first approver on a Woodland invoice above $1K, the second-approval step still applies but Bill can't fulfill it alone. Options considered:
- (a) Route to Shannon regardless
- (b) Route to a fallback admin (e.g., Bethany)
- (c) Allow Bill to self-fulfill with an explicit re-confirmation click

**Decision: (c)** — if first_approver_id == would-be second_approver_id, the pending_second_approval state still fires but the second-approval panel shows a re-confirmation UX ("You are both first and second approver on this invoice — please re-confirm the decision below.") with a 30-second minimum wait between clicks. Documented in the approver runbook.

**Notification:** ntfy `dr3-vision-system` fires the moment a request enters `pending_second_approval`, addressed to the site-appropriate second approver. The `ap-approvals` tile on `/` shows a distinct "awaiting 2nd approval" badge count for the second approvers. Existing `ap_notify` rollout gate still applies — in pilot, second-approval notifications reroute to admins with `[PILOT]` header.

**Decision email routing:** only fires on final `approved` state (i.e., after second approval, or after first approval for sub-$1K invoices). The stamped PDF now carries BOTH approver names + timestamps: *"Approved by [First] on [T1 PT] via DR3-Vision; second approval by [Second] on [T2 PT]"*. For sub-$1K invoices the stamp is unchanged.

**Second approver can override first approval by rejecting.** The rejection email to the original forwarder carries both the first-approver's context (vendor + explanation + amount + equipment + note) and the second-approver's rejection note explaining why it was overridden. First approver is CC'd on the rejection so they see the override.

**Existing "first-action-wins" contract** still holds for sub-$1K invoices — no behavior change for those. Above $1K, "first-vetted, second-confirmed" is the new contract.

### D-M5-4 — Vendor baseline + variance detection

**Baseline source: Bill-uploaded PDF AP report** (from GP or an equivalent history dump), one per site or combined. Uploaded via `/admin/file-drop` (existing surface). New parser + admin surface at `/admin/ap/baselines/import`:

1. Admin selects the uploaded PDF from file-drop
2. Vision runs pdf-parse tabular extraction + Claude API fallback on the whole document to normalize into rows: `{vendor_name, invoice_date, invoice_amount_cents, site}`
3. Preview UI shows extracted rows for admin approval before write
4. On confirm, populates `ap_vendor_baseline_history` (raw extracted rows) + rebuilds `ap_vendor_baselines` (aggregated per-vendor over trailing 12 months)

**Baseline aggregation logic:**

For each distinct `vendor_name` (normalized: trim, lowercase, collapse whitespace):
- Filter history to trailing 12 months from most recent invoice date
- Compute: `mean_amount_cents`, `median_amount_cents`, `min_amount_cents`, `max_amount_cents`, `stddev_amount_cents`, `invoice_count`
- Baseline is considered established when `invoice_count >= 3` in the window
- Vendors with fewer than 3 historical invoices are stored but NOT used for variance flagging (insufficient data)

**Variance thresholds:**
- **Global defaults:** $50 flat + 15% percentage (either trips fires the flag)
- **Per-vendor overrides:** admin can set stricter or looser bounds at `/admin/ap/baselines` (e.g., Clark Pest → $25 flat + 6.25%, matching Kelsey's example)
- **Effective logic:** flag fires when `abs(confirmed_amount - baseline_mean) > flat_threshold` OR `abs(confirmed_amount - baseline_mean) / baseline_mean > percent_threshold`. Either-trips (whichever's stricter fires first).

**Approver UX when variance fires:**

At Approve time, if the vendor matches an established baseline AND the current `confirmed_amount_cents` exceeds thresholds:

- **RED variance banner** appears above the Approve button:
  > *"⚠ VARIANCE FLAG — {vendor} usually bills ${baseline_mean:.2f} (avg from {invoice_count} invoices, last 12 months). This invoice is ${confirmed_amount:.2f}, a {variance_direction} of ${variance_abs:.2f} ({variance_pct:.1f}%). Recent history: [last 3 invoices with dates + amounts]"*
- **Approve button DISABLED** until approver clicks *"I've verified the variance"* explicit acknowledgment button
- Clicking the button:
  - Stamps `variance_acknowledged_by`, `variance_acknowledged_at`, and `variance_acknowledgment_note` (optional additional note the approver may add — e.g., "Confirmed with Morena, additional cockroach treatment this month")
  - Enables Approve button
- Variance acknowledgment is part of the audit trail and appears in the decision email + stamped PDF footer

**Below-threshold (or no baseline):** no variance banner, no acknowledgment gate. Approve flows normally.

**Baseline lifecycle:**
- Bill re-uploads AP report periodically (quarterly is a reasonable cadence) to refresh baselines with new production data
- Approved invoices in Vision (post-Amendment 5) also feed the baseline: on every `approved` state transition, insert a row into `ap_vendor_baseline_history` with `source='vision_approval'` — so baselines stay fresh even between Bill's re-uploads
- Rebuild of aggregated `ap_vendor_baselines` runs nightly (cron) OR on-demand from `/admin/ap/baselines` refresh button

### D-M5-5 — Invoice history search surface

New admin surface at `/admin/ap/history`, **scoped to admins + designated second approvers only** (Bill + Shannon in current config; the general approver roster Morena/Rick/Janette does NOT see this surface).

**Permission model:**
- New capability: `can_view_ap_history` — attached to admin role by default + granted explicitly to designated second approvers via `ap_second_approvers` config table
- Not attached to `ap_approvers` roster by default (avoids leaking historical AP data to shift operators)

**Data source:** union of `ap_requests` (Vision-recorded invoices) + `ap_vendor_baseline_history` (Bill-uploaded historical AP data). Distinguished by `source` column.

**Filters:**
- Vendor (typeahead search against unique vendor names from both sources)
- Date range
- Amount range (min/max)
- Site (Woodland / Eugene / NOT DR3)
- Approver (from `ap_requests` only)
- Source (Vision-approved / historical import)

**Row detail:** clicking a row opens a modal showing:
- All fields (vendor, amount, site, date, source)
- If Vision-approved: full decision context (approvers, notes, equipment links, stamped PDF link)
- If historical import: raw imported values

**Use cases (validated with Bill):**
- Second approver reviewing a $1K+ invoice can check the vendor's history before confirming
- Audit response to any board or Bethany question
- Rate renegotiation prep (vendor Y's charges over 24 months)
- Investigation of a specific approver's decision patterns

**Not exposed:** aggregate reports, cross-vendor summaries, or dashboards — those are follow-on work if ever needed.

### D-M5-6 — Equipment / vehicle linking

**Field on every Approve** — always shown, required with explicit `Not equipment-related` option (Bill's directive: *"forces a decision every time"*).

**Data source:** existing equipment/fleet records in Vision. Consolidated view over:
- Terex maintenance records (Terex assets are already tracked; see `docs/operator/fleet-observability-setup.md` + ADR-0030 references)
- Fleet vehicles (trucks, forklifts, balers) — inventory sources TBD by implementation; likely a `fleet_assets` table or existing equipment table

Implementer confirms exact source table(s) during migration design. Amendment 5 requires:
- Consolidated `equipment_view` (materialized view or join) with columns: `id`, `site_id`, `display_name`, `category` (vehicle | forklift | baler | terex | other), `is_active`
- If existing tables don't cover all categories, add missing tables (e.g., `fleet_vehicles` if not already present)

**UI:**
- Multi-select combobox on Approve panel
- Options filtered by the currently-selected site tag (Woodland site → only Woodland-tagged equipment; Eugene → Eugene equipment)
- Search by `display_name` (typeahead)
- Explicit `Not equipment-related` option always in the list as a distinct choice (mutually exclusive with actual equipment picks)
- At least one selection required (equipment(s) OR "Not equipment-related") to Approve

**Storage:** new join table `ap_equipment_links(request_id FK, equipment_id?, is_not_equipment_related boolean)`. Distinct rows per selected equipment; single row with `is_not_equipment_related=true` for the explicit-none case.

**Missing equipment (approver picks nothing that matches):** admin has to add missing equipment via existing fleet/equipment management surface; approver cannot inline-create equipment (avoids drive-by creation of noise records). If frequent, approver Holds the invoice with a note "waiting for asset X to be added to fleet."

### D-M5-7 — Phase 2: MyMRC haul cross-check (depends on ADR-0057 Phase 1 completion)

**Trigger:** once ADR-0057 Phase 1 lands (`mymrc_hauls_mirror` populated with real data from Bill's admin credentials), Vision can auto-cross-check invoice line items against MyMRC hauls.

**Use case (Kelsey's example verbatim):** *"invoices from Pacific Trucking are for inbound loads from Eureka. I make sure these loads are recorded in MyMRC before approving them."*

**Behavior:**

At intake (part of the extraction pipeline in §D-M5-2), also extract any `H-####` haul references from the invoice body/attachments. Store in `ap_requests.extracted_haul_numbers` (text[] column).

At approve time in the UI, for each extracted haul number:
- Query `mymrc_hauls_mirror` by `external_name` (haul number)
- **GREEN indicator** if the haul is found — display "H-1234 → matches: [date] [source] [units]"
- **YELLOW indicator** if the haul is NOT found — display "H-1234 → not in MyMRC — verify with dispatch before approving"

Not a hard block — approver sees context, decides. Consistent with the amendment's overall philosophy: friction that vets, not blocks.

**Implementation gate:** cannot ship until `mymrc_hauls_mirror` has real data (i.e., after ADR-0057 Phase 1 backfill completes). Schema hook (`ap_requests.extracted_haul_numbers`) ships in Phase 1 of Amendment 5; wire-up ships in Phase 2 once the mirror is populated.

### Schema deltas (consolidated)

**`ap_requests` — new columns:**

```
vendor_freeform         text       -- D-M5-1 (replaces optional `vendor` at decide)
explanation             text       -- D-M5-1 (replaces optional `note` at decide for Approve; Reject/Hold/NOT-DR3 keep decision_note)
extraction              jsonb      -- D-M5-2 (extraction result: best_amount_cents, best_vendor, confidence, source, candidates, cost_cents, model, attempted_at, error)
confirmed_amount_cents  int        -- D-M5-1 (approver-confirmed, replaces optional `amount_cents` at decide)
extracted_haul_numbers  text[]     -- D-M5-7 (Phase 2 schema hook; Phase 1 stores nothing here)

-- Second approval state:
first_approver_id       text?      -- D-M5-3
first_approved_at       timestamp? -- D-M5-3
second_approver_id      text?      -- D-M5-3
second_approved_at      timestamp? -- D-M5-3
second_approver_note    text?      -- D-M5-3 (populated only on second-approver override/reject)

-- Variance flag state:
variance_flag_state     enum       -- 'not_applicable' | 'below_threshold' | 'above_threshold' | 'acknowledged'
variance_acknowledged_by      text?
variance_acknowledged_at      timestamp?
variance_acknowledgment_note  text?

-- Status enum extension:
status  -- add: pending_second_approval  (between pending and approved)
```

**New tables:**

```
ap_vendor_baseline_history (
  id text PK,
  vendor_name text,
  vendor_name_normalized text,      -- lowered, trimmed, whitespace-collapsed
  invoice_date date,
  invoice_amount_cents int,
  site_id text?,
  source enum('bill_upload','vision_approval'),
  imported_at timestamp,
  imported_by text?
)

ap_vendor_baselines (               -- computed, refreshed nightly + on-demand
  vendor_name_normalized text PK,
  vendor_display_name text,
  invoice_count int,
  mean_amount_cents int,
  median_amount_cents int,
  min_amount_cents int,
  max_amount_cents int,
  stddev_amount_cents int?,
  computed_at timestamp,
  variance_flat_override_cents int?,      -- admin per-vendor override
  variance_percent_override numeric?      -- admin per-vendor override
)

ap_equipment_links (
  id text PK,
  request_id text FK,
  equipment_id text FK?,                  -- nullable when is_not_equipment_related
  is_not_equipment_related bool,          -- mutually exclusive with equipment_id
  created_at timestamp
)

ap_second_approvers (
  id text PK,
  user_id text FK,
  site_id text,                           -- 'woodland' | 'eugene' (NOT DR3 has no second approver)
  active bool,
  active_from timestamp,
  active_until timestamp?,
  created_at timestamp
)
```

**Existing table adjustments:**
- `ap_requests.vendor` → deprecate; migrate any existing values to `vendor_freeform` via one-time migration
- `ap_requests.amount_cents` → deprecate; migrate to `confirmed_amount_cents`
- `ap_requests.decision_note` → keep for Reject/Hold/NOT-DR3 dispositions; Approve now uses `explanation` instead
- `equipment` (or equivalent existing table) → add `site_id` if not already present, add `is_active` if not already present

**New capabilities / config:**
- `can_view_ap_history` — admin role by default + granted via `ap_second_approvers`
- `~/.dr3-vision-secrets/anthropic.env` — API key for Claude extraction fallback
- New env var `AP_EXTRACTION_CLAUDE_MODEL` (default `claude-sonnet-4-6`)
- New env var `AP_EXTRACTION_CLAUDE_TIMEOUT_MS` (default `30000`)

### Rollout + test plan

**Phase 1 (this amendment):**
- Migration + all Amendment 5 schema changes
- Extraction pipeline (D-M5-2) with fixture tests: HIGH/MEDIUM/LOW/FAILED cases, Claude API fallback with mock, image attachment path
- Structured decide UI (D-M5-1) with tests: all-four-fields-required, equipment multi-select with explicit-none, vendor helper prompt
- Second-approval workflow (D-M5-3) with tests: state machine transitions, notification firing, first==second edge case, override rejection routing
- Variance detection (D-M5-4) with tests: baseline computation over trailing 12 months, either-trips flag logic, acknowledgment gate, per-vendor override precedence
- Baseline import surface (D-M5-4) with fixture PDF from Bill (uploaded to file-drop)
- History search surface (D-M5-5) with permission gate tests
- Equipment linking (D-M5-6) with site-filtered dropdown tests
- Amendment 5 schema hook `extracted_haul_numbers` ships (empty behavior)
- Migration clean-replay CI gate

**Phase 2 (gated on ADR-0057 completion):**
- Wire haul-number extraction in the pipeline (D-M5-2 extension)
- Wire cross-check against `mymrc_hauls_mirror` at decide time (D-M5-7)
- Fixture tests with mocked mirror data (green + yellow indicator cases)

**Rollout:**
- Phase 1 deploys to prod. `ap_notify` rollout gate still governs decision email routing.
- Approver runbook updated (`docs/operator/ap-approvals.md`)
- Bill uploads the initial AP report to file-drop; admin runs the baseline import via `/admin/ap/baselines/import`
- First real invoice under Amendment 5 flow triggers a monitored watch — Bill/Bethany verify structured decide fields render correctly, extraction produces sane confidence badges, variance flag fires appropriately, second-approval routing lands where expected

**Rollback:** revert the app image; Amendment 5 schema is additive (new columns nullable, new tables independent), so the old flow degrades to the pre-Amendment-5 behavior on the same schema. Data written under Amendment 5 (structured fields) remains visible in the DB even after rollback for post-incident forensics.

**Watch metrics:**
- Extraction confidence distribution (proportion HIGH / MEDIUM / LOW / FAILED across a week — informs when to increase Claude fallback aggressiveness)
- Second-approval hop rate (% of Approves crossing the $1K threshold)
- Variance flag fire rate (% of Approves where variance fires)
- Variance acknowledgment note fill rate (% where approver adds context vs. bare click)
- Second-approver rejection rate (signal for whether the second layer is catching real issues)
```

---

## §2 — Consolidated schema deltas (dev reference, extracted from §1)

Listed above in the "Schema deltas" subsection inside the amendment. Migration name suggestion: `20260722_ap_amendment_5_structured_decide_dual_approval_variance_history_equipment`. Clean-replay tested per §D-M5-4 rollout plan.

## §3 — Extraction pipeline detail (dev reference)

Location: extend `src/lib/ap/` with new module `src/lib/ap/extraction/`. Files:

- `pipeline.ts` — orchestrator (`extractFromRequest(request): Promise<ExtractionResult>`)
- `local-parser.ts` — pdf-parse + regex heuristics
- `claude-fallback.ts` — Anthropic API integration (conditional on confidence)
- `types.ts` — `ExtractionResult` shape
- `__fixtures__/` — invoice fixtures for each confidence tier + edge cases (scanned image, plain-text email, multi-page PDF)

Runs during `runApPoll` after body sanitize + attachment persist, before request insert (or before the request appears in the queue — either lands `extraction` on the row atomically or fires the failure path with `extraction.error` populated). Never blocks the poll from completing; a failed extraction just means `confidence=failed` for that request.

Claude API secrets in `~/.dr3-vision-secrets/anthropic.env`:
```
ANTHROPIC_API_KEY=<key>
```
Mounted to the app service where the pipeline runs. Absent → Claude fallback disabled entirely; low-confidence local extraction lands as-is (approver enters manually).

## §4 — Actions for Bill

1. **Upload initial AP report to `/admin/file-drop`** — one PDF or several, covering both Woodland + Eugene, trailing 12+ months of AP transactions. Bill triggers the baseline import after Amendment 5 lands.

2. **Provision Shannon Rockwell as a second approver:**
   - Insert row into `ap_second_approvers` with `user_id=<Shannon>`, `site_id='eugene'`, `active=true`
   - Verify Shannon has a Vision user account (or provision one)
   - Add `can_view_ap_history` capability to her user

3. **Provide Anthropic API key** for extraction fallback (`~/.dr3-vision-secrets/anthropic.env` on CHAD-HQ):
   ```bash
   ssh 10.99.0.2
   umask 077
   tee ~/.dr3-vision-secrets/anthropic.env <<'EOF'
   ANTHROPIC_API_KEY=<key>
   EOF
   chmod 600 ~/.dr3-vision-secrets/anthropic.env
   ```

4. **Review first invoices under Amendment 5 flow** — monitor extraction confidence badges, second-approval routing, variance flag firing during the first week.

5. **Communicate the workflow change to approvers** — Morena, Rick, Janette should know: (a) Approve now requires four fields, (b) variance flag will occasionally block until acknowledged, (c) any invoice ≥ $1,000 goes to Bill (Woodland) or Shannon (Eugene) for second approval.

## §5 — Actions for Claude Code (execution order)

Full green light per Bill. Ship all four items + Phase 2 schema hook as a single amendment.

1. **Append Amendment 5** (§1 content) to `docs/adr/0046-vendor-invoice-approval-mailbox.md`. Preserve existing amendments 1-4 unchanged.

2. **Migration** — `20260722_ap_amendment_5_structured_decide_dual_approval_variance_history_equipment`:
   - All new columns + tables per Amendment 5 "Schema deltas" section
   - Deprecate (not drop) `ap_requests.vendor` + `ap_requests.amount_cents`; add migration to backfill existing rows into new columns where present
   - Verify clean-replay on empty PG16
   - CI gate on migration clean-replay

3. **Extraction pipeline** — `src/lib/ap/extraction/` per §3. Fixture tests for HIGH/MEDIUM/LOW/FAILED tiers + Claude API mock.

4. **Structured decide UI** — restructure the AP decide panel (currently in `src/app/(dashboard)/dashboard/ops/ap/` or equivalent):
   - Add vendor freeform field with helper prompt
   - Add explanation field (replacing note for Approve; Reject/Hold/NOT-DR3 keep note)
   - Add confirmed_amount input pre-filled from extraction with confidence badge
   - Add equipment multi-select with site-filtered options + explicit "Not equipment-related"
   - Variance flag banner with block-until-acknowledged UX
   - All four fields required to Approve

5. **Second-approval workflow:**
   - State machine in `src/lib/ap/state.ts` (or equivalent)
   - `pending_second_approval` status handling
   - Notification to site-appropriate second approver
   - First-approver == second-approver edge case (self-fulfillment with re-confirmation UX)
   - Decision email with both approver names on the stamp
   - Second-approver rejection routing (CC first approver)

6. **Baseline management:**
   - `/admin/ap/baselines/import` — PDF report ingestion via file-drop link
   - Extraction pipeline extended to tabular data (pdf-parse + Claude API for structure)
   - Preview UI + admin confirm before write
   - `ap_vendor_baselines` aggregation logic (mean, count, thresholds)
   - Nightly rebuild cron + on-demand refresh button
   - `/admin/ap/baselines` — per-vendor override management surface

7. **History search surface** — `/admin/ap/history` with `can_view_ap_history` gate, union query over `ap_requests` + `ap_vendor_baseline_history`, filters per §D-M5-5.

8. **Equipment linking** — `ap_equipment_links` table + site-filtered dropdown from consolidated equipment view (confirm exact source tables during implementation; add missing tables if needed).

9. **Schema hook for haul cross-check** — `ap_requests.extracted_haul_numbers text[]` migrates in Phase 1 but stays empty (no extraction logic yet). Wire-up in Phase 2 depends on ADR-0057 completion.

10. **Runbook update** — `docs/operator/ap-approvals.md` reflects Amendment 5 flow: structured fields, second-approval routing, variance behavior, equipment linking, history search access.

11. **Tests per §D-M5-4 rollout plan.**

**Do NOT:**
- Do NOT drop `ap_requests.vendor` or `ap_requests.amount_cents` — deprecate only. Historical data lives in them.
- Do NOT wire the haul cross-check now — Phase 2 gate on ADR-0057 completion.
- Do NOT allow inline equipment creation from the approver panel — asset registry is admin-managed.
- Do NOT collapse Reject/Hold/NOT-DR3 into the new structured pattern — they keep single reason fields.
- Do NOT auto-approve or auto-fill any field without explicit approver confirmation. Extraction pre-fills; approver still confirms.

## §6 — Success criteria

**Ship (Phase 1):**
- Amendment 5 appended to ADR-0046 verbatim
- Migration clean-replays; extended columns nullable + backfill preserves existing data
- All four Amendment 5 items live in prod
- First real invoice through the new flow validates end-to-end (extraction → structured decide → variance flag as applicable → second approval as applicable → stamped decision email with both approvers)
- `/admin/ap/history` accessible to admins + Bill + Shannon
- `/admin/ap/baselines/import` accepts Bill's uploaded PDF and produces a baseline table

**Ship (Phase 2, gated):**
- Once ADR-0057 Phase 1 lands + `mymrc_hauls_mirror` has data
- Haul cross-check wired into decide UI with green/yellow indicators
- Fixture tests with mocked mirror data pass

**Ongoing (post-ship):**
- Extraction confidence distribution monitored — informs whether to make Claude API fallback more aggressive
- Second-approval hop rate reasonable (not 100% — that would mean the $1K threshold is too low)
- Variance flag fire rate reasonable (not 0% — either baselines aren't populated OR data is uniformly steady; investigate)
- Bill's first re-upload of the AP report refreshes baselines cleanly

---

## §7 — Session close

Kelsey's feedback delivered a coherent set of workflow enhancements. Every item ships together as a single ADR-0046 amendment. Phase 2 MyMRC cross-check waits on ADR-0057 (already in-flight as of 2026-07-21). Bill's AP report upload + Shannon's provisioning + Anthropic key are the operator handoffs; everything else is Claude Code.

**No new blockers surface from this session.** The Amendment 5 work is decoupled from the MyMRC ingestion work (they share the future Phase 2 dependency but Phase 1 of each can proceed independently).
