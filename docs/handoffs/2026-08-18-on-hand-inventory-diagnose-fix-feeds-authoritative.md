# 2026-08-18 — On-hand inventory is chronically wrong: diagnose live, fix the feeds, make the physical count authoritative, and make a wrong number impossible to show silently

**Session context (Bill × Claude, 2026-08-18) — SHIP-TODAY priority:**

Bill: on-hand inventory is *constantly* wrong, **especially on the production report**, and it goes **negative / impossibly low** on **both sites**. This is the single most recurring failure in the system (the July −5,401 floor, the −2,439-program gap, the "1,900 units no feed explains"). Bill's chosen direction: **fix the feeds AND make the physical count an authoritative reset.** A physical count happens **today at EOD**, so the count is the clean same-day floor on top of the feed fixes.

**The diagnosis (from the changelog, to be CONFIRMED against live DB before any fix):** the balance formula `End = Start(anchor) + Inbound − Stripped − WholeUnitsSold − Landfilled` is arithmetically sound. The number breaks because an **input lies**, and there are four structural reasons one does:

1. **Inbound is chronically under-fed** — the floor is negative because real processing (Stripped) is subtracted from **incomplete intake**. Named live suspects: 22 hauls stuck `Confirmed` (dated 08-04+), the ~2,319 undated-haul defect, or a stripped over-count.
2. **The anchor is a single point of catastrophic failure** — "a mistyped count does not produce a wrong count, it silently moves the entire floor."
3. **New input kinds arrive untaught** — "`onHand` already sums drop-off units into the program pool with no `kind` filter, so the new kinds arrive with no aggregation taught about them."
4. **The production report likely computes on-hand through a DIFFERENT path than canonical `onHand`.** The report's number comes from `src/lib/loads/eod-inventory.ts` (`getEodInventorySnapshot`), while the canonical balance is `src/lib/inventory/running-balance.ts` (`onHand`). **Two modules = two chances to disagree**, and Bill says the report specifically is worst. This is the prime suspect for "especially on the production report."

**Non-negotiable discipline:** every fix this month that shipped on an *assumed* diagnosis was wrong on checking (the backlog was already cleared, the container field didn't exist, the merge direction was backwards, the loads weren't 1,085 they were 831). So: **Phase 0 diagnoses against the LIVE DB and REPORTS the numbers before any fix is written.** The diagnosis gates and shapes the fix. If live data contradicts this handoff, live data wins — adapt the fix, report the divergence.

**Standing instruction:** re-read `CHANGELOG.md` + `docs/OPEN-ITEMS.md` + the negative-inventory diagnosis (`docs/2026-07-30-negative-inventory-diagnosis.md`) on current `main` first.

---

## PHASE 0 — Diagnose against the live database, REPORT before fixing (read-only)

For **both** Woodland and Eugene, measure and report:

- **Current computed on-hand** (program / non-program / total), via BOTH `onHand` (running-balance.ts) AND `getEodInventorySnapshot` (eod-inventory.ts). **Do they agree?** If they diverge, that divergence is a top finding — quantify it.
- **Each feed's contribution and last-fed date:** anchor (value + date + age), Inbound (sum + most-recent delivered date), Stripped, WholeUnitsSold, Landfilled. Show the arithmetic that produces the current number so the lie is visible.
- **Inbound health:** how many hauls are `Confirmed` not `Delivered` (and their date range); the undated-haul count; whether the delivery-date re-keying (ADR-0089) is actually feeding both sites or just Woodland.
- **Anchor health:** each site's current anchor value, when it was last set, and `daysSinceAnchor`. Is Eugene's anchor stale or never established?
- **The `kind`-filter question:** does `onHand` correctly aggregate every current intake kind (dropoff/incentive, saves-exclusion, paper_bulk, bridged inbound), or is a kind being summed wrong / double / not at all? Enumerate every kind that reaches the pool and confirm each is handled.
- **Which number the production report actually renders**, traced to source.

**Output: a written diagnosis, per site, naming which input is lying and by how much.** Everything below targets what this finds. Do NOT write a fix before this is reported.

## PHASE 1 — Fix the feeds the diagnosis proves are broken

Targeted by Phase 0. Likely (confirm each against the finding):

- **Inbound under-feed:** if hauls are stuck `Confirmed` or undated and belong on the floor, run the ADR-0089 delivery-date recovery path (`fix-woodland-inbound.sh` lineage — re-detail sweep → delta → gated re-bridge, idempotent, falsification-gated). Apply to **whichever site(s) the diagnosis shows under-fed**, not just Woodland. If Eugene's inbound is unfed by design (no MyMRC mirror), state that plainly — its floor then depends entirely on the anchor + manual entry, which makes Phase 3 the real fix for Eugene.
- **The `kind`-aggregation gap:** if Phase 0 finds a kind summed wrong, fix `onHand` so every intake kind is explicitly handled — a `kind` a reader doesn't recognize must **fail loud, not sum silently into the program pool**. The lesson from dropoffs arriving untaught: an unknown kind is an error, not a default-add.
- **Stripped over-count / double-count:** if the diagnosis shows Stripped exceeds what's plausible, trace it (the six-duplicate-loads pattern from Aug 10, or a processed double-write). Fix at the source, audited.
- Do NOT fabricate inbound to make the floor positive. Recover real hauls or leave the gap visible for the Phase 3 reset to resolve. A positive number that's invented is worse than a negative number that's honest.

## PHASE 2 — One number, one source of truth (the production-report fix)

If Phase 0 confirms `eod-inventory.ts` and `running-balance.ts` compute on-hand differently:

- **Unify them.** The production report must render the **same** on-hand that the canonical balance produces — either by having `getEodInventorySnapshot` call `onHand`, or by proving they're already equivalent and adding a test that keeps them equivalent. Two independent computations of the same number is the defect; collapse it to one.
- Add a **regression test asserting the report's number equals `onHand`** for the same site/day, so they can never silently diverge again.
- If they already agree, state that with evidence and move on — don't refactor for its own sake (Bill: don't overcomplicate).

## PHASE 3 — The physical count is authoritative (tonight's EOD reset)

The count happening **today at EOD** is the clean same-day floor. Make it a trustworthy reset, not just another data point.

- Tonight's physical count **establishes a new authoritative anchor** for each site that counts, via the existing `reconcilePhysicalCount` (records `reconciled_delta = physical − computed` with an audit row — keep that; the delta is the evidence of how far the ledger had drifted).
- **After the count, on-hand = the counted number**, and the running balance computes forward from it. The prior drift is closed by the reset and recorded as the delta, not silently erased.
- **Guard the anchor write** (this is structural fault #2 and it must not bite tonight): reuse the ADR-0072 tiered anchor-overwrite guardrail — a count that overwrites an existing anchor shows current-vs-new + delta and requires confirmation; a >20% swing holds for manager approval. Tonight's reset is exactly the "overwrite the anchor" case that guardrail exists for. Confirm it's wired to this path.
- **Pacific-day correctness:** the anchor's `snapshot_at` / `daysSinceAnchor` handling was fixed once (the July off-by-one where a `@db.Date` key got re-shifted through Pacific and printed a day early / tripped the stale band early). **Verify that fix still holds** so tonight's count doesn't land on the wrong day. Regression test if not already pinned.
- If only one site counts tonight, reset that site; the other stays on its (Phase-1-repaired) computed floor and gets its own count later. Report which site is on which basis.

## PHASE 4 — A wrong on-hand can never be shown silently again (the anti-recurrence guardrail)

This is what turns "constantly problems" into "problems that announce themselves." The disease is that on-hand renders a confident number even when its inputs are stale or impossible.

- **A negative on-hand is impossible in reality** — the building cannot hold −2,439 units. So a negative computed on-hand is a **known-bad state** and must render **loudly** on the production report: not the negative number as if it were fact, but a banner — *"On-hand is computing negative (−N). This means intake data is incomplete — most recent inbound is X days old. This figure is not reliable."* Show the diagnostic, not the lie.
- **A stale inbound feed** (most-recent delivered haul older than a tolerance, aligned to the ADR-0089 freshness work) surfaces the same way on the report — the number is shown but flagged with *why* it's suspect.
- These are **display/report guardrails**, not new computation — the number is still computed once (Phase 2); it's the *presentation* that stops lying. Reuse the freshness signal that already exists (`freshness.ts` / the ADR-0089 delivered-signal work); don't build a second freshness system.
- The banner appears on the **production report** (Bill's stated pain point) and the floor on-hand tile.

---

## Actions for Claude Code

1. Re-read CHANGELOG + OPEN-ITEMS + the negative-inventory diagnosis on main.
2. **Phase 0:** live read-only diagnosis, both sites, per the checklist. **Report the numbers before writing any fix.** Name which input lies, by how much, and whether the two on-hand modules agree.
3. **Phase 1:** fix the feeds the diagnosis proves broken — inbound recovery on the under-fed site(s), `kind`-aggregation (unknown kind fails loud), stripped over-count if present. Never fabricate inbound.
4. **Phase 2:** unify the report's on-hand with canonical `onHand` (or prove equivalence), pinned by a regression test.
5. **Phase 3:** wire tonight's EOD physical count as the authoritative anchor reset via `reconcilePhysicalCount`, guarded by the ADR-0072 tiered overwrite guardrail, Pacific-day-correct, audited delta retained.
6. **Phase 4:** negative and stale-feed on-hand render as loud "not reliable" banners on the production report + floor tile, reusing the existing freshness signal — the number never displays silently as fact when it's known-bad.
7. Falsification-grade tests: the report number equals `onHand`; a negative on-hand triggers the banner (assert it does NOT render the bare number as fact); an unknown intake `kind` throws rather than summing; the anchor-overwrite guardrail fires on tonight's reset; the Pacific-day anchor date is correct. Each test must fail against the pre-fix code first — a test that never went red proves nothing (the §15 discipline).
8. Adversarial review; per phase PR → CI → merge → deploy → verify live. **Tag Bill at Phase 0 completion with the diagnosis** (he wants to see which feed is lying), and again at completion with: both sites' on-hand now, the report-vs-onHand equivalence proof, confirmation the EOD reset path is armed and guarded, and the banner firing on a negative.

**Do NOT:**
- Do NOT write any fix before Phase 0's live diagnosis is reported.
- Do NOT fabricate inbound to force a positive floor — recover real hauls or leave the gap for the physical-count reset.
- Do NOT let an unrecognized intake `kind` sum silently — it must fail loud.
- Do NOT leave two independent on-hand computations — collapse to one, test-pinned.
- Do NOT let tonight's physical count overwrite the anchor without the ADR-0072 guardrail.
- Do NOT display a negative or stale on-hand as if it were fact — banner it.
- Do NOT build a second freshness system — reuse the ADR-0089 signal.
- Do NOT overcomplicate — if the two modules already agree, prove it and move on.

## Success criteria

- A written per-site diagnosis names which input was lying and by how much, and whether the report and canonical on-hand agreed.
- The under-fed feed(s) are recovered from real data; unknown `kind`s fail loud; any stripped over-count is fixed at source.
- The production report and `onHand` render the **same** number, test-pinned to stay equal.
- Tonight's physical count resets each counting site to an authoritative, guarded, audited anchor; on-hand computes forward from it.
- A negative or stale on-hand shows a loud "not reliable — here's why" banner on the production report and floor tile, never a silent wrong number.
- Both sites' production-report on-hand is correct (or honestly flagged) by end of day.

## For Bill

The reason this has been "constantly problems" is structural: the formula is fine, but it renders a confident number no matter how starved its inputs are, and the report computes it a second way so it can be wrong even when the core is right. This fixes all four layers — recover the starved inbound, make the report and the core agree, let tonight's count be the authoritative reset, and make a negative on-hand physically incapable of showing as fact (it becomes a "this is broken, here's why" banner instead). After tonight's count, both floors read a number you can trust, and the next time a feed hiccups the report will *say so* instead of quietly lying. The Phase 0 diagnosis comes to you first — you'll see exactly which feed was starving the number before anything gets changed.
