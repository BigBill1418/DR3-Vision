# 2026-08-12 — Batch: enable the quota digest (Fri 8pm, 3+ misses), renumber 4 ADR collisions, F-1, F-4, Q-2 finding

**Session context (Bill × Claude, 2026-08-12):**

A triaged batch of hanging items. One real feature change (the quota digest Bill has never received), one housekeeping sweep (ADR number collisions), two small correctness fixes (F-1, F-4), and one investigation-only task (Q-2). All scoped against verified repo state (`2026-08-12T15:12Z`, 241 docs).

**Standing instruction:** re-read `CHANGELOG.md` + `docs/OPEN-ITEMS.md` on current `main` first; verify every premise against live code/DB. Premises have died on checking repeatedly this month.

---

## PHASE 1 — The processor quota digest: enable it, 3+ misses, Friday 8pm PT, Mon–Fri window

**The problem Bill raised:** *"I have never seen it work or gotten anything whatsoever."* The diagnosis (ADR-0071 Amendment 1, 2026-08-11) is already correct and shipped: the monitor was never broken — `processor_quota_config.enabled` has been `false` since 2026-07-31 by design (at quota 75 with the 2-miss rule it flagged 13 of 18, a roster not an exception list), and until Amendment 1 a disabled run was byte-identical to an outage. **Amendment 1 already fixed the liveness half** (every config now evaluates and writes a `processor_quota_runs` heartbeat even while disabled; `enabled` gates only sending). Do not rebuild that.

**What remains are three narrow changes Bill has now decided. Verify each against the shipped code before changing it — Amendment 1 moved things.**

### D1 — Enable it
Flip `processor_quota_config.enabled = true` for Woodland. This is the only thing standing between the (now-correct) machinery and an actual email. It is a data change to the config row, plus verification the send path is reached — not a schema change.

### D2 — Change the flag rule from 2 misses to **3 or more**
Bill: *"flag anyone that went below for more than 2 days in a week"* → **3+ miss-days** flags. The current rule flags at **2**; at 2-in-a-5-day-week nearly everyone trips it (that is why 75 looked like a roster). Moving to **≥3** means a processor was under quota a majority of days worked — a real underperformer.

- The bar itself is unchanged: **75 units/day**, a miss is a worked day **strictly less than 75** (exactly 75 is MET), and **a day with no recorded production is never a miss** (the single most important rule — `bonus_daily_entries` uniqueness means absence = no production; do not interpret a missing row).
- Change only the miss-**count** threshold: **flag at misses ≥ 3** (was ≥ 2). Prefer to make this a **config value** (e.g. `processor_quota_config.min_misses`, default 3) rather than a literal, so it is retunable like the quota — but if the current code hardcodes `2`, at minimum change it to `3` and note whether a config column is worth adding.

### D3 — Reschedule: Friday 8:00 PM PT, reporting the **current Mon–Fri** week
The spec currently fires the cron **daily at 06:00 PT** and reports the most recent **complete Mon–Sun** week, sending Monday. Bill wants **Friday 8:00 PM PT**, reporting **that same week's Mon–Fri** (weekend excluded).

- **Window:** Monday 00:00 PT → Friday end-of-day PT of the **current** week (not the previous complete week). Use the existing Pacific-day helpers (`currentPacificDayWindow` / the ADR-0089 `pacificDayStartInstant` lineage) — do NOT introduce a new calendar.
- **Send time:** Friday 20:00 PT. **Keep the daily-fire, idempotent-per-week design** — do not convert to a single weekly cron. ADR-0071 §5 chose daily firing precisely so a redeploy/restart/M365 blip at the send moment self-heals instead of losing the week silently. So: fire daily (or at least keep the resilient cadence), and the route sends only on/after Friday 20:00 PT for the current Mon–Fri week, idempotent per `(site, week)` via the existing unique index on `processor_quota_logs`. A Saturday/Sunday/Monday catch-up run must still send the Friday week if the Friday send was missed, then no-op.
- **Idempotency key note:** the week key must now identify the **Mon–Fri current week**, consistently with the send window. Verify the `(site, week)` key derivation matches the new window so it can't send twice or skip.

### D4 — Verify the recipient list includes Bill's svdp address
Probe showed 3 recipient rows, addresses correct. **Confirm `bill.barnard@svdp.us` (or Bill's exact svdp address) is present and active** in `processor_quota_recipients`, alongside Morena and Janette. If absent, add it. This is the whole point — Bill must receive it.

### D5 — The honest data-timing caveat (report, don't silently ship)
Reporting **Mon–Fri at Friday 8pm** assumes **Friday's own production counts are fully entered by 20:00 PT Friday**. If processors' Friday `bonus_daily_entries` routinely land Saturday or Monday, Friday will read light and **false-flag** people who actually met quota. Before shipping, **check the live data**: do Friday entries typically exist by Friday evening, or do they arrive late? 
- If Friday data is reliably in by 8pm → ship Mon–Fri as specified.
- If Friday data routinely arrives late → **do not silently ship a false-flagging report.** Flag it to Bill with the evidence and recommend the safer variant (Friday 8pm reporting **Mon–Thu**, or the send moved later). Bill explicitly wants to be told if this is a risk rather than discover it via bad flags.

### Phase 1 acceptance
- `enabled = true` for Woodland; a real send path is exercised.
- Flag threshold is **≥3 misses**; 75 bar and "no-production-day is never a miss" unchanged.
- The digest sends **Friday 20:00 PT** for the **current Mon–Fri** week, idempotent per week, self-healing if the Friday moment is missed.
- Bill's svdp address is a confirmed active recipient.
- Suppression still writes a `processor_quota_logs` row when nobody flags (so "nobody flagged" ≠ "cron didn't run"); the Amendment-1 heartbeat is untouched.
- The D5 data-timing check was run and either cleared or escalated to Bill.

---

## PHASE 2 — Renumber the 4 real ADR collisions + fix cross-references

Seven ADR numbers are doubled. **Three are legitimate** (an amendment sharing its parent's number): `0067` (Am.8 + parent), `0069` (Am.1/Am.2 + parent), `0071` (Am.1 + parent). **Leave those alone.**

**Four are genuine collisions** — two *unrelated* decisions grabbed one number:

| Number | Decision A | Decision B |
|---|---|---|
| 0078 | ipad-reliability-idempotent-writes-and-honest-queue | terex-daily-throughput-is-captured-not-derived |
| 0087 | throughput-gap-watchdog | vlm-equipment-identity-normalization-and-decision-register |
| 0097 | a-citation-is-a-promise | a-page-that-heals-before-the-phone-buzzes |
| 0098 | a-citation-is-a-promise | a-page-that-heals-before-the-phone-buzzes |

Note 0097/0098 is tangled: "a-citation-is-a-promise" and "a-page-that-heals" **each exist at both 0097 and 0098**. Resolve to one canonical number each.

**Approach:**
- For each collision, keep the **earlier-decided / already-referenced** decision at its number and renumber the other to the **next free number** (verify free at execution — the max is ~0102, so the renumbered ones take 0103+). Determine "earlier" from the CHANGELOG dates / cross-reference direction, not guesswork; if genuinely ambiguous, keep the one more things already point at.
- **Fix every cross-reference** to a renumbered ADR across `docs/adr/*`, `docs/adr/README.md`, `docs/adr/PROMISES.md`, `CHANGELOG.md`, `docs/OPEN-ITEMS.md`, and any code comments. Grep the whole repo for the old `ADR-00XX` string in its renumbered sense — be careful not to rewrite references that legitimately mean the decision staying put.
- **Migration/table names are immutable.** If any renumbered ADR is referenced by a `_prisma_migrations` name (see F-4 below — `20260830_adr0078_...` is exactly this), **do NOT rename the migration**. Leave the DB alone; note the ADR-number/migration-name divergence in the ADR itself. Renaming a shipped migration is far more dangerous than a cosmetic number mismatch.
- Add a short note to `docs/adr/README.md` recording the renumbers so history is traceable.

**Optional guard (only if cheap):** the collisions come from parallel agents each taking "the next number" without a lock. If a lightweight check exists (a pre-commit that rejects a duplicate `docs/adr/NNNN-` prefix), add it. Do not build heavy infrastructure for this — a filename-collision check is enough. If it is not cheap, skip and note it.

---

## PHASE 3 — F-1: COR month-end headcount renders `—`

`src/lib/cor/prefill.ts` reads `processed_units_daily.employees_count` / `processors_count`, **NULL on all 987 prod rows** (never written by any of their four write paths), so the month-end headcount pre-fills as `—` on the Certificate. ADR-0076's `distinctProcessors` helper already computes the real figure from the payroll source in ~21 ms.

- Wire `distinctProcessors` (or the equivalent existing helper — verify it exists and its cost) into the COR headcount pre-fill.
- A month with genuinely no processor data must render **"not recorded"**, not `0` and not `—` (the "not recorded ≠ zero" discipline from ADR-0077).
- Test: a month with real payroll data shows the true headcount; an empty month shows "not recorded", never 0.

---

## PHASE 4 — F-4: relabel the stale migration row (do NOT touch the table)

Production `_prisma_migrations` carries a row named `20260830_adr0078_equipment_daily_throughput` — but that work is **ADR-0079's**, not 0078's (0078 is iPad reliability). It is harmless, but it misleads.

- **Do NOT delete or alter the table it created.** The open item is explicit: *"Harmless; do not 'fix' it by deleting the table."*
- The safe fix is **documentation-only**: record in ADR-0079 (and the migration's own comment if reachable) that the shipped migration name carries `adr0078` for historical reasons and refers to ADR-0079's `equipment_daily_throughput`. Renaming a shipped migration row risks a drift/checksum mismatch on the next `prisma migrate` — **do not rename it in the DB.** If Prisma tooling offers a safe, checksum-preserving rename, still prefer the documentation note unless certain.
- This interacts with Phase 2: if Phase 2 renumbers anything, the same "migration names are immutable" rule applies. Keep them consistent.

---

## PHASE 5 — Q-2: FINDING ONLY — locate the real commodity-reconciliation data (do NOT build)

**Finding that reframes this:** the file already absorbed as the "commodity audit tracker" (`commodity_audit_tracker`, 252 rows) is **NOT reconciliation data.** Its row-4 columns are `Audited | Initials | Date | 2nd Audit | Initials | Date` repeating per commodity band — **a sign-off log. No weight, no amount, no invoice number, no variance.** Layer B reconciliation cannot be built from it, independent of the (now-closed) Kelsey path.

**Task — investigation only, no build, no absorption, no schema change:**
- Determine whether a **different file exists** anywhere reachable (the `docs-dr3` shares, the file-drop history, the workbook set, Rick's spreadsheets) that carries the **actual reconciliation inputs**: per-commodity weights, dollar amounts, invoice numbers, and any variance/expected-vs-actual columns — the MyMRC-vs-vendor-invoice cross-check data.
- **Report what exists**: is there a real data file, is it partial, or does the reconciliation data live only in a process that was never a single file? Name the candidate file(s) and describe their actual columns.
- **Do not absorb or wire anything.** The decision on what to do next returns to Bill. This phase ends with a written finding.

---

## Actions for Claude Code

1. Re-read CHANGELOG + OPEN-ITEMS on main; verify Phase 1 premises against the Amendment-1 code (it moved things).
2. **Phase 1:** enable Woodland config; change flag threshold to ≥3 (prefer a config column); reschedule to Friday 20:00 PT reporting current Mon–Fri, keeping the resilient daily-fire/idempotent design; confirm Bill's svdp address is an active recipient; run the D5 Friday-data-timing check and clear-or-escalate.
3. **Phase 2:** renumber 0078/0087/0097/0098 collisions (keep the earlier/more-referenced, renumber the other to next free), fix all cross-refs, leave amendment-style shared numbers and all migration names alone; add a README note; add a filename-collision guard only if cheap.
4. **Phase 3:** wire the real headcount into COR pre-fill; empty month = "not recorded".
5. **Phase 4:** documentation-only relabel of the stale migration reference; do NOT touch the table.
6. **Phase 5:** investigation only — locate/describe the real commodity-reconciliation file; report; build nothing.
7. Falsification-grade tests where code changes (Phase 1 threshold + schedule + idempotency; Phase 3 headcount). Adversarial review. Per phase PR → CI → merge → deploy → verify live.
8. Tag Bill with: proof the quota digest will send Friday 8pm to his address (and the D5 timing finding), the renumber map, F-1 before/after, F-4 note, and the Q-2 finding.

**Do NOT:**
- Do NOT rebuild the Amendment-1 liveness/heartbeat — it is correct; only enable + rethreshold + reschedule.
- Do NOT convert the quota cron to a single weekly fire — keep the self-healing daily/idempotent design.
- Do NOT silently ship a Mon–Fri report if Friday data lands late — escalate per D5.
- Do NOT rename or delete any shipped migration (F-4, and Phase 2's migration-name rule).
- Do NOT renumber the legitimate amendment-style shared ADR numbers (0067/0069/0071).
- Do NOT absorb, wire, or build anything for Q-2 — finding only.
- Do NOT render an absent headcount as 0 — "not recorded".

## Success criteria

- Bill receives the processor quota digest **Friday 8:00 PM PT** at his svdp address, flagging only processors with **3+ sub-75 worked days** in the current Mon–Fri week, suppressed when nobody qualifies, self-healing if the Friday moment is missed — and the D5 data-timing risk was checked, not assumed.
- The four ADR collisions are renumbered with all cross-references fixed and no migration touched; legitimate shared numbers untouched.
- COR headcount shows the real number (or "not recorded"), never `—` or a false 0.
- The stale migration reference is documented, the table untouched.
- A written finding states whether real commodity-reconciliation data exists and where.
