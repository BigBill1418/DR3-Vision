# 2026-08-07 — Floor & iPad: bulletproof reliability first, then four operator features (JT feedback)

**Session context (Bill × Claude, 2026-08-07):**

Four pieces of floor feedback from JT (Janette). Bill's directive: one combined handoff, **iPad reliability as Phase 1** so every feature lands on a solid connection layer, then the four features. Full multi-agent execution — keep pushing through the whole plan, test everything entering production, do not stop until complete.

**This handoff was written against verified repo state (`2026-08-07T15:11Z`, 200 docs), and three premises were corrected during scoping — do not restore the wrong ones:**

1. **`processed_units_daily` does NOT have a sole writer.** The CHANGELOG corrects an earlier "workbook-sync is sole writer" claim in place: **three paths write it under a precedence rule** (`source='mymrc' AND closed_at IS NULL` wins). Any phase that adds to inventory (saves, dropoffs) must respect that precedence, never assume a lock.
2. **Bonus counts are edited through an AMENDMENT WORKFLOW, not a plain soft-void.** Prior-day changes return `409 requires_amendment` → batch modal → ≥20-char justification → approver email → one transaction (`src/app/bonus/DailyEntryGrid.tsx`, `RequestEditModal`/batch modal, `/api/bonus/amendments`). This exists because bonus = payroll. Do not build a parallel delete/void path that bypasses it.
3. **The `equipment_events` soft-void is a DIFFERENT mechanism** (Terex maintenance events, ADR-0044) — it is NOT the model for editing operator counts. Do not cargo-cult it into the bonus/iPad path.

**Standing instruction, with force:** before each phase, re-read `CHANGELOG.md` + `docs/OPEN-ITEMS.md` on current `main` and verify the phase's target surface against live code. This month multiple premises died on checking; two of this handoff's did. Where handoff and shipped code disagree, **shipped code wins — report, don't revert.**

Two phases touch **money/pay** (Phase 3 saves, Phase 4 edits) and one touches **inventory/billing** (Phase 5 dropoffs). Those get the highest care and the most tests.

---

## PHASE 1 — iPad reliability foundation (everything else sits on this)

JT: *"we need to make sure the connection isn't dropping … error-free and bulletproof for the iPad and operator connectivity."* This is the foundation. Build and prove it before the feature phases write through it, because Phases 3–5 all submit operator data and a flaky layer under a pay/inventory write is how you get double-counts and lost entries.

**Requirements:**

- **Idempotent submits.** Every operator write (count entry, load action, dropoff) carries a client-generated idempotency key; the server dedupes on it. A double-tap, a retried request, or a replayed offline-queue entry must land **exactly once**. This directly fixes the first half of JT's item 3 ("we accidentally entered the count twice") at the mechanism level, not just via a delete button.
- **Offline queue with honest replay.** Entries created offline queue locally and replay when the connection returns. Reuse the existing pattern where an offline entry **carries its target day and REFUSES to silently retarget to today** (that guard already exists for one path — generalize it, do not weaken it). A replayed entry that no longer makes sense (day mismatch, superseded) surfaces for operator resolution, never silently writes or silently drops.
- **Connection-state UI.** The operator can always see whether they're online, offline-queuing, or syncing. A dropped connection is **visible**, not silent — the whole point of JT's ask. Show queued-count and last-sync.
- **No lost work.** A submit in flight when the connection drops is queued, not lost. The operator gets confirmation only on a server-acknowledged write.
- **Bulletproofing audit.** Enumerate the current iPad write paths (`/operator/[site]/…` surfaces — queue, inbound, count) and for each: confirm idempotency, offline behavior, retry, and failure surfacing. Report any path that can double-write, lose an entry, or fail silently — those are the bugs JT is describing. Fix them.

**Acceptance:** a scripted double-submit lands once; an offline entry replays exactly once to the correct day; a mid-submit disconnect loses nothing; the operator always sees connection state. Tests pin each.

---

## PHASE 2 — Load claim + self-serve handoff

JT: *"Whoever started the load has to be the one to close the load … need to keep it open to somebody to close it in case 1st driver goes to lunch."*

The load lifecycle exists (`/operator/[site]/load/[id]`, `inbound_loads`, statuses submitted→arrived→in_progress→verified). Add **claim + handoff**:

- Starting a load **claims** it — stamps the starting operator as the default closer.
- **Self-serve takeover (Bill's decision):** any operator can take over an in-progress load. No manager required — the lunch-break case must not strand a load.
- **Takeover re-stamps honestly.** The new operator's id replaces the claim; the change is audited (who took over, when, from whom). **Never a silent overwrite, never a false claim** — the codebase's hard rule (an append-only claim table must never carry a claim a person didn't make; the recent `mergeEquipment` actor-context work exists for exactly this reason). The close is attributed to whoever actually closed it.
- The current claimer is visible on the load so a second operator knows who has it before taking over.

**Acceptance:** operator A starts a load (claimed by A); operator B takes it over (audit shows B took it from A); B closes it (close attributed to B); no false claim written; the original claim history survives in the audit log.

---

## PHASE 3 — "Saves" column in bonus daily entry (PAY + INVENTORY)

JT: *"add a space for saves — they also get paid for every mattress saved to sell — a dedicated 'saves' field beside processed."* Bill: **saves is a new column in the SAME bonus daily entry, same amendment rules, pays at the processing rate, AND becomes resale inventory.**

- **New per-processor `saves` column** beside the existing mattress/processed count in `DailyEntryGrid.tsx`. Same grid, same row per processor.
- **Pays at the same rate and the same way as regular processing.** Saves flow into the bonus calculation exactly as processed units do — reuse `calculateDailyBonusCents` (which now correctly THROWS on a non-number `units` — keep that guard; feed it real Decimals, not type-lies). A save is a paid unit.
- **Same amendment rules.** Because saves live in the bonus entry, they inherit the amendment workflow automatically — a prior-day saves correction goes through `409 requires_amendment` + justification, same as counts. Do not exempt saves from it.
- **Saves also feed resale inventory.** A saved mattress is resale stock. This write must **respect the `processed_units_daily` precedence rule** (Correction 1) — it adds to inventory without violating the `source`/`closed_at` precedence, and does not double-count against processed. Verify the inventory contribution against the running balance; a save adds resale stock, a process removes a unit from the floor — confirm the arithmetic doesn't count one mattress twice.
- **Signature/footer totals** update to include saves so the signed total can never diverge from the displayed total (the `SignatureDb`/`DecimalLike` truthful-typing work applies — saves must be a real Decimal end to end, not a number cast).

**Acceptance:** a processor's saves entry pays at the processing rate; a prior-day saves edit routes through the amendment workflow; saves contribute to resale inventory under the precedence rule without double-counting; the signed bonus total includes saves and matches the display. Money and inventory both pinned by tests.

---

## PHASE 4 — Same-day count correction on the iPad

JT: *"We should be able to edit counts — if we accidentally entered the count twice, we should be able to remove one."* Bill: **iPad operators fix SAME-day only; prior-day is a manager/office job through the existing amendment workflow.**

- **Same-day:** an operator can edit or void a count they entered **today**, on the iPad, directly. This is the in-the-moment slip fix. It is audited (edit/void writes an audit row; never a hard delete — the value's history survives).
- **Prior-day: NOT on the iPad.** A prior-day change returns the existing `409 requires_amendment` and is handled by a manager/office through the amendment batch modal + justification. The iPad does not offer prior-day editing at all — do not build it there.
- **This composes with Phase 1 idempotency.** The primary defense against "entered twice" is Phase 1 (the double-submit can't land twice). Phase 4 is the correction for a genuine operator mistake (wrong number, or a real duplicate that predates the idempotency key). Both exist; they are different defenses.
- Respect the day boundary with the existing Pacific-day guard (`assertCurrentPacificDay` / `currentPacificDayWindow`) — "same day" is Pacific, not UTC, and not the device clock.

**Acceptance:** an operator voids a same-day double-entry on the iPad (audited, not hard-deleted); a prior-day edit attempt on the iPad is refused and routed to the amendment workflow; "today" is computed in Pacific.

---

## PHASE 5 — Public / Incentive drop-off button on the iPad

JT: *"a tile or static button on the iPad; hitting it prompts Public Drop Off or Incentive Drop, then asks for total units and a photo; contributes to daily inbound and inventory."* Bill clarified: **both types are identical except the label — units + photo only. NO money recorded, NO name/PII. Incentive's $3 payout is NOT tracked here.**

- **iPad button** → prompt **Public** vs **Incentive** → enter **total units** → **capture a photo (REQUIRED — no dropoff without it)** → submit. Feeds daily inbound + inventory.
- **Reuse the existing dropoff service + inventory wiring** (`ConsumerDropoff` model, dropoffs service, manager API already exist and are wired to inventory). Do NOT rebuild the pipeline.
- **CRITICAL — do NOT populate `incentive_amount_cents` or `consumer_name`.** Those fields exist on the model for a different, richer incentive-payout/CIP-PII use case. Bill explicitly does not want money or PII captured on this iPad flow. The type is a **label** (Public vs Incentive) plus units plus photo — nothing else. Leaving those fields unused is correct; do not "helpfully" default the $3. If the model requires a non-null there, store the label distinction without money/identity — confirm the schema allows a label-only dropoff and, if it forces an amount, treat that as a finding to report, not a reason to record money Bill didn't ask for.
- **Photo storage** follows the established attachment pattern (R2, same as receipts/absorbed docs). Required means the submit is blocked without it.
- **Inventory contribution respects the precedence rule** (Correction 1) — a dropoff adds to the day's inbound/inventory the same disciplined way, no double-count.
- Runs through Phase 1 reliability (idempotent, offline-queued, photo included in the queued payload).

**Acceptance:** an operator logs a Public and an Incentive dropoff, each units + required photo; both feed daily inbound/inventory; no money and no name is written for either; a dropoff without a photo is refused.

---

## Execution instructions for Claude Code (multi-agent, run to completion)

**Bill's directive: keep pushing through this plan with a full multi-agent workflow, test all code entering production, and do not stop until complete.**

1. **Re-read CHANGELOG + OPEN-ITEMS on main.** Verify each phase's target surface. Honor the three corrections above.
2. **Phase 1 FIRST and completely** — reliability is the foundation; do not start the feature phases until idempotency + offline + connection-state are built and their tests are green. The feature phases write through this layer.
3. **Then Phases 2→5.** They are largely independent surfaces and suit parallel agents, but **all of them depend on Phase 1** — parallelize 2–5 among agents only after Phase 1 lands. Phases 3 and 4 both touch the bonus grid; if run by separate agents, coordinate on `DailyEntryGrid.tsx` to avoid a merge collision (saves column + same-day void touch the same component).
4. **Money/inventory phases get the most tests.** Phase 3 (pay + inventory), Phase 4 (pay corrections), Phase 5 (inventory) each need: the happy path, the double-count falsification, the precedence-rule interaction, and the amendment-workflow boundary (3, 4). A test that only passes because a mock filtered the hard case is a failure — run the falsification (this codebase has been bitten twice by green-because-the-mock-lied; assert against real Decimals and real precedence).
5. **Adversarial review before each merge**, the same discipline that caught the Terex triple-count and the freshness-guard blindness. Then per phase: PR → CI → merge → deploy → verify live.
6. **Report at each phase boundary** — what shipped, what was verified live, any premise that died on checking. Then continue to the next phase without waiting.
7. **Tag Bill at completion** with the full PR list and live-verification evidence for all five phases: idempotency proof (Phase 1), a takeover audit trail (Phase 2), a saves pay+inventory reconciliation (Phase 3), a same-day-void + prior-day-refusal pair (Phase 4), and a photo-required dropoff feeding inventory with no money/PII (Phase 5).

**Do NOT:**
- Do NOT start feature phases before Phase 1 reliability is proven.
- Do NOT assume `processed_units_daily` has a sole writer — respect the 3-writer precedence rule.
- Do NOT bypass the bonus amendment workflow for prior-day edits; do NOT put prior-day editing on the iPad.
- Do NOT build a parallel void path modeled on `equipment_events` — that's a different system.
- Do NOT record money (`incentive_amount_cents`) or PII (`consumer_name`) on the dropoff flow.
- Do NOT write a false claim on load takeover — re-stamp honestly, audited.
- Do NOT double-count inventory in saves (Phase 3) or dropoffs (Phase 5).
- Do NOT trust a green test that a mock could have faked — run the falsification against real types.

## Success criteria (all five, live)

- iPad submits are idempotent, offline-safe, and connection state is always visible; no path double-writes or loses an entry silently.
- A load can be taken over by any operator with an honest, audited re-stamp; the close is truthfully attributed.
- Saves pays at the processing rate through the bonus grid, inherits the amendment rules, feeds resale inventory under the precedence rule, and the signed total includes it — no double-count.
- Same-day count corrections work on the iPad (audited, no hard delete); prior-day is refused there and routed to the amendment workflow; "today" is Pacific.
- Public/Incentive dropoffs capture units + required photo, feed inbound/inventory, and record no money and no PII.
- Every money- and inventory-touching path is pinned by a falsification-grade test.

## For Bill

Phase 1 is the one that pays JT's "bulletproof" ask directly — once it's in, a dropped connection can't cost a count and a double-tap can't double-pay anyone. The four features then land on that. Two things worth knowing: saves touches payroll *and* inventory, so it's the most-tested phase and the one to eyeball first when it's live; and the dropoff flow deliberately records no money even for Incentive, per your call — if you later want the $3 tracked, that's a separate, deliberate addition, not a default we slipped in.
