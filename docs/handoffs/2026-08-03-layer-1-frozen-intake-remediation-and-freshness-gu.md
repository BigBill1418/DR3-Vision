# 2026-07-31 — Layer 1: frozen intake remediation + freshness guard that actually works

**Session context (Bill × Claude, 2026-07-31):**

This is the centerpiece of the data-integrity campaign. Woodland's floor reads **−3,083** because the **inbound feed froze on 2026-07-22** while the processing feed kept running (and last night's `552e21c` un-froze nine days of processing all at once, making the drift visible in one step). The July Certificate of Recycling pulls from this number and is due now — that is the live external exposure.

Grounded entirely in `docs/2026-07-30-negative-inventory-diagnosis.md` (read-only prod measurement). Claude Code must re-read that diagnosis in full before acting — it carries the exact identifiers, line numbers, and `[M]`/`[D]`/`[I]` evidence labels.

**This handoff has two halves that ship together, deliberately.** Fixing the frozen feed without fixing the guard that failed to catch it would leave the silent-failure mode live — which is exactly how this happened. One package.

**Bill is running a separate verification+remediation script (`fix-woodland-inbound.sh`) himself** to recover the actual missing loads. That script and this handoff are complementary: the script does the one-time data recovery under his eye; this handoff makes the recurrence impossible and generalizes the fix. **Coordinate — do not double-run the backfill.** Check the state the script leaves before re-bridging (see §2.4).

---

## §1 — Root cause (measured, from the diagnosis)

- `onHand()` (`src/lib/inventory/running-balance.ts:~330`) computes `anchor + inbound + dropoffs − stripped − wholeUnitsSold − landfilled`. The function is **correct**; its inbound input is missing nine days.
- Delivered hauls only ever entered Vision through the ADR-0057 one-shot backfill cursor **`completed_hauls`**, which drained at `completed_at = 2026-07-22 02:07 AM PT` (`records_completed 8000 / estimated 6185`). A drained cursor is a no-op, so **it never ran again.** `[M]`
- All 7,174 `Delivered` mirror rows carry `last_seen_at = 2026-07-22`; the 71 `Confirmed` upcoming rows still refresh daily. Delivered hauls leave the active list view, so nothing re-reads them. `[M]`
- **The freshness guard cannot catch this** (`src/lib/mymrc/freshness.ts`, added `552e21c`): it measures `max(docking_appointment_date)` across the whole mirror. The future-dated `Confirmed` rows (max = 2026-08-07) hold that maximum in the future, so the guard reports **fresh** while the `Delivered` half is frozen at 2026-07-21. **A guard measuring a signal that cannot go stale even when the data does.** `[M]`

This is the same failure family as the AP empty-recipient-set and doc-ingestion "reports ok while absorbing nothing": a green light that does not mean healthy.

---

## §2 — Half A: remediation (recover the actual missing loads)

**Chosen approach: backfill, not physical count.** Bill's decision — recover the real 07-22→07-31 inbound loads so the July detail is auditable, rather than papering the hole with a fresh anchor that discards nine days of truth.

### §2.1 — Re-arm and re-run the `completed_hauls` backfill

The cursor is drained. Re-arm it to re-ingest the delivered-haul window **2026-07-22 → 2026-07-31** (Woodland), then run the inbound bridge over the same window. This is the ADR-0057 ingestion path, re-executed — not a new mechanism.

- Re-scrape first **only if** the delivered rows in `mymrc_hauls_mirror` are themselves incomplete for the window. The diagnosis shows the `Delivered` rows are *present* but frozen at `last_seen_at=2026-07-22` — so verify whether the underlying haul data for 07-22→07-31 is already mirrored (bridge-only) or absent (re-scrape then bridge). **This is the fork the verification query resolves; do not assume.**
- Idempotent: re-bridging an already-bridged load must not double-count. Confirm the bridge's dedup key (likely `mymrc_haul` id) rejects duplicates before running.

### §2.2 — Expected result (falsifiable)

Floor returns to roughly **+1,500** (1,597 anchor + ~5,600 recovered inbound − 5,716 stripped). `[I]` The diagnosis flags this as falsified if recovered hauls total materially less than ~5,000 units for the window — if so, **stop and report**, because it means intake loss upstream of the bridge, a bigger problem.

### §2.3 — Guard the COR until this completes

`src/lib/cor/prefill.ts:148` sets the filed figure from `balance.total`; `src/lib/cor/service.ts:238` refuses finalize on ledger disagreement. **Until inbound is backfilled and the floor is verified positive, the July Woodland COR must not be prefilled or finalized.** Add a hard block: COR prefill/finalize refuses when the site's inbound freshness check (Half B) is stale, with a message naming the frozen feed. A regulatory filing must never be derivable from a feed known to be frozen.

### §2.4 — Coordinate with Bill's script

Bill runs `fix-woodland-inbound.sh` (verify → dry-run → apply, transaction-wrapped). Before re-bridging, **check whether his run already recovered the window** — inspect `inbound_loads` for `arrived_at` in 07-22→07-31 and the `completed_hauls` cursor state. If already recovered, this half is verification-only: confirm the floor is positive and move to Half B. Do not re-run a backfill that already ran.

---

## §3 — Half B: a freshness guard that cannot be fooled (the campaign foundation)

This is the part that stops recurrence, and it generalizes beyond inbound.

### §3.1 — Fix the inbound/haul guard

`freshness.ts` must measure the **Delivered** signal, not the max-including-future. Specifically:

- Freshness of *delivered history* = age of `max(docking_appointment_date) FILTER (WHERE status='Delivered')` (equivalently `max(last_seen_at)` on delivered rows). This is the signal that actually froze.
- Freshness of *upcoming appointments* may still track `Confirmed` rows — but the two are **separate checks with separate meanings**, never collapsed into one max. A frozen delivered feed must trip the guard even while confirmed rows refresh.
- The guard's own documented assumption ("a healthy hauls feed reports a negative age and can never be stale") is **the bug** — it assumed one population. Replace it; note the correction inline so no one restores the old logic.

### §3.2 — Generalize: per-feed freshness with a "can't be fooled" contract

Every ingest feed gets an explicit freshness check with three properties:

1. **Measures real landed data** — the timestamp of the most recent *actually-ingested, terminal-state* record (delivered, processed, absorbed), not an appointment/schedule/future field.
2. **Immune to partial refresh** — a feed where one sub-population still updates while another freezes must report stale for the frozen population. No single global max that a live sub-feed can hold up.
3. **Fails loud** — stale = a surfaced alert (Bill's 06:00 digest + the relevant admin surface), not a silent internal state.

Feeds to cover: inbound/delivered hauls, `processed_units_daily`, the MyMRC scrape cursors, document ingestion. Each declares its "real landed data" signal and its tolerance (production feeds: a couple of business days; align with existing weekday-clock helpers, do not invent a new calendar).

### §3.3 — Wire freshness into `onHand()` and the floor tile

The diagnosis §3 names the design fault: `onHand()` renders a number from a one-sided ledger with no indication half its inputs are stale. Fix:

- `onHand()` / the floor tile surfaces an **inputs-stale banner** when any component feed is stale — the number is shown but flagged "inbound feed last updated 2026-07-21, N days stale — this figure is not reliable," rather than presenting a silently-wrong figure as fact.
- A negative on-hand specifically must be **loud** — it is a known "drifted ledger" state (the code already comments on it) but was never surfaced. Negative = banner + digest line, not a quiet clamp.

### §3.4 — The incident is the acceptance test

The fixed guard must fire on **exactly the condition that just slipped through**: delivered feed frozen at 2026-07-21 while confirmed rows are future-dated to 2026-08-07. Write that as a regression test with those two populations — green guard on that fixture is a test failure.

---

## §4 — Actions for Claude Code

1. Re-read `docs/2026-07-30-negative-inventory-diagnosis.md` in full. Re-read `CHANGELOG.md` + `docs/OPEN-ITEMS.md` on current `main` (standing instruction — premises die on checking; Bill's script may have already moved state).
2. **Coordinate with Bill's `fix-woodland-inbound.sh`** (§2.4) — determine whether the backfill already ran before doing anything mutating. Verify, don't assume.
3. **Half A** — if not already recovered: re-arm `completed_hauls`, re-scrape only if the mirror window is incomplete, bridge 07-22→07-31 Woodland, idempotent/no double-count. Verify floor ≈ +1,500; if recovered inbound < ~5,000 units, STOP and report (upstream loss).
4. **§2.3** — hard block on COR prefill/finalize when inbound freshness is stale.
5. **Half B** — fix `freshness.ts` to measure the Delivered signal (§3.1); generalize to per-feed checks with the three-property contract (§3.2); wire staleness + negative into `onHand`/floor tile as loud banners (§3.3); regression test on the exact incident fixture (§3.4).
6. Full adversarial error-test before pushing. Then PR → CI → merge → deploy → verify live.
7. Tag Bill with: the recovered floor number, the `completed_hauls` cursor state after, and proof the fixed guard fires on the incident fixture.

**Do NOT:**
- Do NOT double-run the backfill if Bill's script already recovered the window.
- Do NOT re-bridge in a way that double-counts — verify the dedup key first.
- Do NOT collapse delivered + confirmed freshness into one max — that is the original bug.
- Do NOT let COR prefill/finalize proceed against a stale inbound feed.
- Do NOT present a negative or stale-input on-hand as a plain number — it must be loud.
- Do NOT invent a new calendar for tolerances — reuse the weekday-clock helpers.

---

## §5 — Success criteria

- Woodland floor is positive and matches recovered reality (≈ +1,500, or the true figure the recovered loads produce).
- The `completed_hauls` window 07-22→07-31 is ingested, no double-counting.
- July Woodland COR cannot be prefilled/finalized while inbound is stale; can once recovered + verified.
- `freshness.ts` reports **stale** for a delivered feed frozen at 07-21 even with confirmed rows dated 08-07 — proven by regression test.
- Every ingest feed has a freshness check meeting the three-property contract; stale surfaces in the 06:00 digest.
- `onHand`/floor tile shows a loud banner on stale inputs or a negative balance — no silently-wrong figure.

---

## §6 — For Bill

Once this lands, the floor number is trustworthy again *and* it can't silently lie the same way twice — any feed that freezes trips the 6am digest instead of drifting for nine days. That's Layer 1 of the integrity campaign done: the foundation the completeness scan (Layer 2) and cross-system reconciliation (Layer 3) build on. Those two layers get their spec from Kelsey's narration — which is why capturing her this week runs in parallel with this.
