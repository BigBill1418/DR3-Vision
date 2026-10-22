# 2026-08-18 — Retire the sheets: four floor/Terex captures + finish reconciliation with data-derived variance

**Session context (Bill × Claude, 2026-08-18):**

The document-absorption build (ADR-0104, shipped 2026-08-15) put the outbound weights into Vision — 831 loads, 1,699 commodity rows, 5,619,037 lb, joinable to `mymrc_outbound_mirror` on `external_materials_id`. **This handoff finishes the job in both directions:** four floor/Terex captures that each let a spreadsheet be switched off, and the reconciliation completion Bill asked to fold in.

**The governing objective, stated by Bill and threaded through every item:** *no more sheets.* Each capture below exists so Vision holds what a sheet currently holds, so the sheet can be retired. The sheets are temporary shadow copies until cutover. Do not build anything that assumes a sheet stays.

**Bill's discipline instruction:** *"don't overcomplicate this — clean, clear, usable by the team… just make it bulletproof and reliable."* Every item here reuses machinery that already exists (the load-photo system, the same-day void, the Terex daily-entry table, the reconcile read module). Nothing new is invented. If an item starts growing a new abstraction, stop — it's the wrong shape.

**Standing instruction:** re-read `CHANGELOG.md` + `docs/OPEN-ITEMS.md` + `docs/plans/2026-08-15-full-document-absorption-build.md` on current `main` first; verify every premise against live code/DB. Premises have died on checking all month — several this week (831 not 1,085 loads; the invoice-date column holding non-dates). Assume the same here and measure.

Two items touch money/pay (manager count correction; the reconciliation) — highest test rigor there.

---

## ITEM 1 — Up to three photos per load (extends existing photo capability)

Loads already support photos (BOL / weight-ticket / door-open, with `load-photo-guard.ts`, the offline-queue photo path, and the ADR-0078 auth-classification fixes). **Extend, do not rebuild.**

- Allow **up to 3 photos total** per load. **One required** (unchanged current behavior); photos 2 and 3 optional.
- **Generic, unnamed** — a plain "add another photo" affordance, no slot labels.
- Reuses the existing capture → queue → upload path (including the ADR-0078 offline idempotency and the 401-vs-403 photo-guard fix). A second/third photo is the same write, not a new pipeline.
- The load's freshness/`updated_at` composite must include the newest photo (the changelog already notes `GREATEST(updated_at, newest stack, newest photo)` — a 2nd/3rd photo must participate so the row doesn't look stale).
- **Acceptance:** an operator adds up to 3 photos, 1 required and enforced; offline capture queues all of them idempotently; nothing else about the load flow changes.

## ITEM 2 — Managers can correct an operator's count, current + previous day (money-adjacent)

Today: same-day **operator self-void** exists (ADR-0084 + Am.1 "widen to site"). What's missing is a **manager correcting the operator's entry**, across **today and yesterday**.

- **Who:** a manager (`requireManagerForSite`) edits a count an **operator** entered. Not self-service by the operator beyond what already ships.
- **Window:** **current day and previous day only.** Not older.
- **Edit in place**, audited: the correction records who changed it, when, from what value to what value, tied to the original operator's entry. **No approval gate** (Bill's decision).
- **Never a hard delete** — the prior value survives in the audit trail (the ADR-0084 soft-void discipline; a corrected count is a new authoritative value with the old one retained, not overwritten in place at the data layer).
- Because counts feed pay, the audit row is the control: a manager changing a processor's number must always be answerable ("who moved this, when, from what"). Enforce the who/when/from/to at the storage layer, not just the UI.
- **"Day" is Pacific** (`currentPacificDayWindow` / the ADR-0089 helpers) — previous-day means the prior Pacific day, not a UTC or device-clock day.
- **Acceptance:** a manager edits an operator's today count (audited, prior value retained); a manager edits yesterday's (same); an edit two days back is refused; the audit row carries who/when/from/to; a non-manager cannot.

## ITEM 3 — Terex prior-day entry, bounded to the current month (fixes the ADR-0079 D4 wall)

ADR-0079 D4 shipped Terex daily throughput as **same-day only** — *"a prior day is REFUSED, and the amendment workflow could not be reused."* Bill needs to go back to a different day. Build the prior-day path the original deliberately deferred.

- **Window:** a manager can enter or edit a Terex day for **any date in the current calendar month** (Pacific). Not prior months. "Current month" is a bounded, auditable window — not unlimited history.
- **Discipline:** same as Item 2 — **audited (who/when/why logged), no approval gate.** A `reason`/note field is captured on a prior-day change (the "why"), stored with the audit row. Same-day entry stays as-is (free, ADR-0079).
- Reuses the `equipment_daily_throughput` table and its `(equipment_id, throughput_date)` uniqueness — a prior-day write is an upsert into an existing/absent day within the month window, not a new table.
- **Do not weaken** `run_hours NOT NULL` or the `throughput_date` uniqueness that ADR-0079 established (§D reasons: conflation risk). The month-bound is a predicate on the write path, not a schema change.
- **Acceptance:** a manager enters Terex figures for an earlier day this month (audited, reason recorded); editing an existing day this month works; a date in a prior month is refused; same-day entry is unchanged; uniqueness and NOT NULL hold.

## ITEM 4 — Terex Start/End hours; run-hours auto-derived and locked (matches the sheet)

The Terex sheet records **Start Hours** and **End Hours** (the changelog shows a real half-entered row: "End Hours 2665.95 with Start Hours blank"). Vision currently captures a single hand-entered `run_hours`. Move Vision to the sheet's model so the sheet is redundant.

- Capture **Start Hours and End Hours, both required.** These are the meter/clock readings the operator reads off the machine.
- **run-hours = End − Start, auto-derived and LOCKED** — not hand-editable. This replaces the current hand-entered `run_hours`.
- **Validation:** `End > Start` (Bill: the machine never runs overnight, so `End ≤ Start` is a keying error → refuse with a clear message). The derived run-hours must still satisfy the existing ADR-0079 bound `0 < run_hours ≤ 24`; a derived value outside that is refused.
- **Migration:** add `start_hours` and `end_hours` (Decimal, matching the meter precision — check the sheet's actual decimals; the outlier `2665.95` and `5698.4` suggest 2dp meter readings, not 24h clock times — **verify against live bytes which they are: cumulative hour-meter readings vs. clock times.** This changes the math: if they are cumulative hour-meter readings, End−Start is the run duration directly; if clock times, same subtraction but different domain. Confirm before building — this is exactly the kind of premise that has died on checking.) Keep `run_hours` as the derived, stored, locked column so everything downstream (throughput/hr) is unchanged.
- Existing rows have `run_hours` but no start/end — leave them; new/edited entries capture start/end and derive. Do not backfill fabricated start/end (same principle as ADR-0079 refusing to fabricate history).
- **Acceptance:** an operator enters Start and End; run-hours computes and locks; End ≤ Start is refused; a derived run-hours > 24 or ≤ 0 is refused; the meter-vs-clock question was resolved against real data and recorded in the ADR.

## ITEM 5 — Finish the reconciliation read view (verify what shipped)

The build plan §12 specified `outbound-reconcile.ts` + a read-only page: per-month, version-pinned (ADR-0077), mirror loads vs. loads-with-absorbed-weight, join on `external_materials_id`, **no verdict**. Bill wants reconciliation completed.

- **First, verify what actually shipped** — does the reconcile module and page exist and render live, version-pinned, showing weight coverage per month? Report green/red. If it only partially shipped, finish it to the §12 contract.
- The page states coverage plainly (covered/uncovered load counts, summed weight, commodity breakdown) for the pinned winning `doc_source_version_id`. Expect a large uncovered count — the workbook covers Woodland Jan–Jun 2026 only (~3,590 mirror loads are outside that and will show uncovered; that is correct, not a bug — label it so no one reads it as data loss).
- This is the surface Item 6 adds variance flagging to.

## ITEM 6 — Data-derived variance thresholds, editable, live (Bill's reconciliation ask)

Bill: ship variance flagging with thresholds **derived from the actual data**, on **both weight and dollar** — *"if the data supports it."* That hedge is load-bearing: **the dollar side only ships if the invoice data actually joins.**

**Step A — measure, before flagging anything.** Against the absorbed data:
- **Weight variance:** for loads where an absorbed weight and the mirror's expected/reported figure both exist, measure the real distribution of the discrepancy — median, spread, percentiles, where the genuine outliers begin. Report the numbers.
- **Dollar variance:** **first determine whether `Woodland Invoices tracking.xlsx` (doc_source `e0101cb5`, currently staged) actually joins** to the outbound loads on a real key (invoice→load/commodity). The build plan flags this file as staged and its "Invoice Date column does not hold dates" (§A1.5) — so its shape is already known to be surprising. **If a clean join exists**, measure dollar-variance distribution the same way. **If it does not join cleanly, ship weight-variance only and report that dollar reconciliation needs a join key that does not yet exist** — do not fabricate a dollar match. The data gets a veto.

**Step B — ship data-derived thresholds as EDITABLE DEFAULTS.**
- Set the initial flag line at the **statistical outlier point the measurement found** (e.g. beyond the Nth percentile, or > k× the median absolute deviation — pick what the distribution actually justifies and state the reasoning in the ADR).
- Store thresholds in a **config table**, seeded with the derived defaults, **editable by Bill/Rick/Janette** without a deploy (the pattern from the quota `min_misses` column). Weight threshold and, if it shipped, dollar threshold are separate config values.
- The reconcile page now **flags** loads exceeding the threshold — but the flag is presented as *"exceeds the current variance threshold of X% (editable)"*, **not** as a verdict that a dispute exists. This respects AK-4c: the system surfaces a data-derived outlier; the human decides if it's a real dispute. A flag is a "look at this," not an "error."
- **No alerting/email in this item** — the flags live on the reconcile page only. (An alert channel is a later, separate decision — do not add one here; that would cross into the mismatch-verdict territory AK-4c reserves for Bill/Rick/Janette.)

**Step C — the honesty rails.**
- Version-pinned per ADR-0077 (flag only within the winning revision; a re-absorption must not double-count or silently re-baseline the thresholds).
- A load with no absorbed weight is **"not covered,"** never "0 variance" and never flagged — absence is not agreement (the "not recorded ≠ zero" discipline).
- Thresholds are defaults derived from *current* data; the ADR records the measured distribution they came from, so when Rick/Janette retune, they know what the starting numbers meant.

**Acceptance:** the measured weight-variance distribution is reported and a derived, editable threshold flags outliers on the reconcile page (not as a verdict); the dollar side either ships the same way (if the invoice join is real) or is explicitly reported as blocked on a missing join key; thresholds are editable without a deploy; uncovered loads are never flagged; everything is version-pinned.

---

## Actions for Claude Code

1. Re-read CHANGELOG + OPEN-ITEMS + the 2026-08-15 absorption plan on main. Verify each item's surface against live code before building.
2. **Item 1:** extend load photos to 3 (1 required), generic, reusing the existing capture/queue/guard path; include new photos in the freshness composite.
3. **Item 2:** manager corrects operator counts, today + yesterday (Pacific), in place, audited who/when/from/to, no approval, soft-void discipline (prior value retained).
4. **Item 3:** Terex prior-day entry bounded to the current month, audited with a reason note, no approval; reuse `equipment_daily_throughput`; don't weaken NOT NULL / uniqueness.
5. **Item 4:** Terex Start + End hours required, run-hours = End−Start auto-derived + locked, End>Start enforced, derived value within 0<h≤24; **resolve meter-reading-vs-clock-time against live bytes first** and record it; don't backfill fabricated start/end.
6. **Item 5:** verify/finish the §12 reconcile read view; label the expected-large uncovered count as correct, not loss.
7. **Item 6:** measure weight (and, only if it joins, dollar) variance distributions; report the numbers; ship data-derived **editable** thresholds flagging outliers on the page (not verdicts, no alerts); version-pinned; uncovered ≠ flagged.
8. Falsification-grade tests, especially Items 2, 4, 6: a manager edit two days back is refused; End≤Start refused; a derived >24 refused; a variance flag does not fire on an uncovered load; the version pin actually excludes a superseded revision (write the test that fails naive first and quote its failure — a pin test that never failed proves nothing, per the §15 discipline).
9. Adversarial review; per item PR → CI → merge → deploy → verify live. Tag Bill with: the two Terex behaviors, the count-correction audit proof, the measured variance numbers + the thresholds derived from them, and a clear statement of whether dollar reconciliation shipped or is blocked on a join key.

**Do NOT:**
- Do NOT build a new abstraction where an existing one extends — photos, void, Terex table, reconcile module all already exist.
- Do NOT let a manager (Item 2) or prior-day Terex (Item 3) edit beyond its stated window.
- Do NOT allow a hand-edited run-hours once Start/End ship — it's derived and locked.
- Do NOT assume Terex hours are clock times vs. meter readings — measure and record.
- Do NOT ship dollar-variance flagging if the invoice data doesn't truly join — report the gap instead.
- Do NOT present a variance flag as a verdict, and do NOT add an alert/email channel — page-only, AK-4c reserves verdicts for Bill/Rick/Janette.
- Do NOT flag an uncovered load, or render absence as zero variance.
- Do NOT fabricate history (Terex start/end backfill, or a dollar join).
- Do NOT break the ADR-0077 version pin — flag within the winning revision only.

## Success criteria

- A load carries up to 3 photos (1 required); offline-safe.
- A manager corrects an operator's count for today and yesterday, audited who/when/from/to, no approval, prior value retained; older days refused.
- Terex accepts prior-day entries within the current month, audited with a reason; prior months refused; same-day unchanged.
- Terex captures Start + End; run-hours is derived and locked; End≤Start and out-of-bound derived values refused; meter-vs-clock resolved and recorded.
- The reconcile view renders live, version-pinned, uncovered labeled correctly.
- Weight-variance thresholds are data-derived, editable without deploy, and flag outliers as "look at this," not verdicts; dollar-variance ships the same way or is explicitly reported blocked on a join key.
- Every sheet these items shadow is now fully represented in Vision — each item names, in its PR, which sheet/column it retires.

## For Bill

Each of these turns off a reason a spreadsheet still exists: the photos and count-correction close the last floor gaps, the Terex start/end + prior-day make Vision hold exactly what the Terex sheet holds, and the variance flagging turns the absorbed weights into something that actually earns its keep. On Item 6 specifically — the thresholds will be real numbers measured from your own 831 loads, not a guess, but they ship *editable*, because a statistical outlier and a real billing dispute aren't the same thing and only you, Rick, and Janette can draw that line. Watch the first week of flags against real loads and move the numbers until they flag what you'd actually chase. And if the invoice file doesn't cleanly join, you'll get told that plainly rather than given a dollar number that isn't real — the weight reconciliation stands on its own either way.
