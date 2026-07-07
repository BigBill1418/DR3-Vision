# INCIDENT + DIRECTIVE: Staged-Rollout Policy for All Staff-Facing Output (ADR-0047 + amendments to 0039/0043)

**Date:** 2026-07-06 · **Severity:** trust-damaging, not data-damaging · **Ordered by:** Bill

## 1. Incident

The morning of 2026-07-06, the ADR-0043 daily alert digest emailed Rick Albritton (Eugene site manager) two open findings: `c4_billing_basis` (critical — "no billing leg for window") and `m2_missing_snapshot` (medium — "no physical snapshot on record"). **Both are bootstrap artifacts**: Eugene's billing leg cannot exist yet (first generated invoice is mid-July; no retro-import for Eugene) and no physical snapshot has ever been entered into a week-old feature. The comparators evaluated correctly; the findings are true and useless, and a critical-red flag landed on a site manager with zero framing.

## 2. Root causes — both are release-discipline failures, not engine bugs

1. **No bootstrap gating on missing-counterpart checks.** C4/M1/M2-class checks fire the moment a site exists, even for legs that have never contained data. The retro-audit design knew the billing leg starts empty; suppression was never specified.
2. **No pilot staging on staff-facing output.** ADR-0043's recipient rosters (Morena/Janette/Rick) went live the day the feature merged. Recipient ramp was never made a Bill-gated step. The forward handoff named live rosters directly — the directive itself lacked a staging requirement. **Standing failure mode: unfinalized surfaces reaching staff is unacceptable and must become structurally impossible, not procedurally avoided.**

## 3. Immediate hotfix (amend ADR-0039/0043; code today)

1. **Leg-liveness bootstrap gating.** Any check whose premise is "leg has no data for window" (c4_billing_basis, m1_missing_close, m2_missing_snapshot, and any future missing-counterpart check) MUST NOT emit findings for a site until (a) that leg has EVER contained data for that site, OR (b) a per-site/per-leg `go_live_date` (admin-editable config) has passed. Suppressed evaluations are still written to the run ledger with status `suppressed_bootstrap` — visible in admin, never silent (ADR-0038 lesson applies to suppression too).
2. **Existing bootstrap findings auto-resolve** with cause `bootstrap_suppression` + provenance note. Never deleted; the findings ledger stays honest. (Operator note: Rick's two findings stay OPEN until this lands — do not hand-classify them.)
3. **Comparator logic untouched.** The checks are correct.

## 4. Systemic fix — ADR-0047: central notification policy gate

1. **One chokepoint.** A `notifyStaff()` policy layer wraps ALL outbound staff-facing email/ntfy. Direct `sendSystemEmail` to non-admin recipients from feature code is forbidden; policy layer is the only path. Enforced by (a) a registered-surface pattern — every staff-facing output declares a `notification_surface` row — and (b) a repo test that fails if any feature module imports the raw mail sender (allowlist: the policy layer itself, auth flows).
2. **Per-surface × per-site `rollout_state`: `pilot` | `live`.** In `pilot`, ALL output for that surface routes to admins only, with a `[PILOT — would have sent to: …]` header showing intended recipients so Bill can validate content AND targeting before ramp. `live` requires an explicit admin flip (audited, per surface per site).
3. **Default is pilot. Always.** Migrations that create a surface seed `pilot`. New ADRs adding staff-facing output inherit the gate automatically by construction — this is the "structurally impossible" requirement.
4. **Bring every existing surface under the gate now**, seeded to `pilot` except where noted: 0043 alert digest (pilot — the incident surface); 0045 task/follow-up reminders (pilot); 0045 contact-intake routing notifications (pilot); 0041 invoice-approval notifications (pilot); 0042 COR ready-to-sign notification if any (pilot); 0046 AP-approval notifications when built (born pilot). Explicitly OUT of scope: bonus signature-chain notifications (long-established, in production use — seed `live`), survey invite/reminder sends (Bill-approval-gated per invite by design, seed `live`), and the 0045 Updates/board-pack digests (no mail path by construction — the stronger guarantee stands).
5. **Release-discipline rule (record in ADR-0047, CLAUDE.md, and the PR template):** any change adding or expanding staff-visible output — emails, ntfy, new recipient rosters, new dashboards linked from emails — ships in pilot and is ramped only by Bill from the admin panel. Recipient rosters in directives/handoffs name the *eventual* audience; they are never the day-one audience.

## 5. Sequencing & contingency

Hotfix (§3) + policy gate (§4) are one working session; deploy today. **Contingency if not deployed before the next 02:30 sweep + morning send:** manually point the 0043 digest roster to Bill-only (operator locates the recipient/roster table and updates; restore via admin after the gate lands). Tomorrow's digest to staff with the same two findings would compound the trust damage — treat the deploy as today's priority over all other build work, including ADR-0046 drafting.

## 6. Acceptance

(a) Sweep on a fresh site emits zero staff-visible findings and ledger shows `suppressed_bootstrap` rows; (b) flipping a leg's first data row live starts real evaluation with no code change; (c) in pilot, digest arrives to admin with the would-have-sent header and staff receive nothing (test asserts empty staff mailbox); (d) ramp flip is audited and immediate; (e) repo test fails on any new direct mail-sender import; (f) Rick's two findings show auto-resolved with `bootstrap_suppression` provenance.

## 7. Human follow-up (Bill)

Two-line note to Rick today: the flags were startup artifacts of the new audit system comparing against records that don't exist yet — his numbers are fine; the system won't email staff again until it's been validated. This preserves the audit's credibility for the moment it flags something real.



---

## 8. STAGED ACTIVATION PLAN — controlled ramp of built capability (Bill-gated, one flip at a time)

**Principle:** the build being done does not make it live. Each surface reaches each audience through an explicit Bill flip (ADR-0047 `rollout_state`), only after the prior stage's validation criteria pass. One new workflow per person per stage wherever possible. Rollback for any stage = flip back to pilot, one admin action, no code.

**Where §8 needs code:** ADR-0047 gates *notifications*; UI-surface visibility needs the same treatment where noted below — extend the rollout_state concept to per-site **surface audience flags** for dashboard tabs (the ADR-0037 D7 gate is the template). Small build; listed as Stage-0 work.

### Stage 0 — this week (wk of 7/6): admin-only, foundations true
- ADR-0047 gate + bootstrap suppression deployed (incident fix). **All surfaces pilot.** Bill reviews pilot digests daily.
- Extend audience gating to UI surfaces per above (Workbench manager-read flag, events/OR-counts tabs, Terex tab).
- Ops gates CLOSED: restore drill + off-box backup (the standing D7 blocker — nothing ramps to managers before this).
- MyMRC profile enabled → audit legs fill (admin-visible only). June workbook retro-imported. DR3# counter aligned to Janette's real current number.
- Rick populates `account_haul_rates` + `container_rental_sites` (data entry under `can_manage_rates`; not a workflow ramp).
- Staff email (drafted) goes out — the map of what's coming. Rick's two-line bootstrap-artifact note (§7) sent.
- **Exit criteria:** 2 consecutive pilot digests with zero bootstrap noise; ops gates closed; DR3# verified; MyMRC sync green ≥3 consecutive runs.

### Stage 1 — wk of 7/13: capture layer, Woodland only
- **Woodland iPad go-live** (operators get exactly one surface: the operator flow; supervised test load + offline ride-out first, straight cutover per locked decision).
- **Janette** flips live on the minimum manager set: Schedule-a-load, verify gate, daily close (processed units + categories). NOT Workbench, NOT alerts, NOT Terex.
- Janette runs Vision daily close **in parallel with her spreadsheet** (she maintains it anyway); Kelsey cross-checks both.
- **Exit criteria:** 3 consecutive clean closes where Vision ties Janette's spreadsheet (or every variance is triaged bug-vs-business-rule and resolved); operator flow needs no floor intervention for 2 consecutive days.

### Stage 2 — wk of 7/20: Eugene capture + Workbench to managers
- **Eugene iPads + Rick's** minimum manager set (same as Janette's Stage 1; Eugene's lighter volume makes this a smaller lift).
- **Woodland managers (Janette, Morena) get Workbench READ** — findings visible in-app; digest emails remain pilot. Kelsey adopts the Workbench as her primary audit tool for the remainder of her validation window — her usage IS the P1 acceptance test.
- Terex capture flips for Morena/Janette (equipment_events entry only; trend views stay admin until data exists).
- **Exit criteria:** Eugene mirrors Stage-1 criteria; Kelsey signs off that Workbench findings match her manual audit for one full week.

### Stage 3 — 7/16 through EOM: money in SHADOW (default; Bill may override)
- **July is a shadow-billing month: the spreadsheet invoice remains the invoice of record.** Vision generates the mid-month set (~7/16) and EOM set; Rick compares line-by-line (mission §4 parity checklist is the instrument). Rick exercises the approval workflow on the shadow invoices — validating the workflow without it carrying money.
- **July COR** (~8/1): Vision generates; Rick validates the 4,062-style inventory tie and headcount against his manual count; signs whichever he trusts, variance filed as a finding either way.
- **Exit criteria (→ Vision becomes invoice of record for August):** mid-month AND EOM parity clean or fully triaged; Rick states — in writing, in the ledger — that he'd have signed the Vision set.

### Stage 4 — wk of 7/27: staff-facing communications ramp
- **Alert digest → live** for Morena/Janette/Rick only after ≥5 consecutive reviewed pilot digests with zero noise AND ≥1 true finding handled end-to-end in pilot.
- Task-ledger reminders live for leads; contact-intake routing live (tours→Rick); Morena begins sending the Updates digest from Vision's draft.
- **Exit criteria:** one week of live digests with no confused-recipient escalations.

### Stage 5 — 8/1: cutover
- Vision is system of record: August invoices native; Woodland daily-log spreadsheet **retired after July EOM parity passes** (Eugene's retires after its own EOM cycle); Terex trend views + remaining P4/P5 audiences live.
- **ADR-0046 AP mailbox ramps independently** of 8/1 — born pilot when built; goes live when IT consent lands + Bill validates the first real quarantine/request cycle. If IT lags, the interim is accounting emailing Morena/Janette directly (the pre-Vision workflow with the new approvers) — the cutover does not wait on Graph consent.

### Standing rules
1. No stage starts before the prior stage's exit criteria are met — schedule pressure changes the calendar, never the criteria.
2. Every flip is audited with the criteria evidence noted in the flip.
3. Any Sev-worthy surprise at any stage → the affected surface back to pilot first, diagnose second.
4. Kelsey's availability ends 8/1 — Stages 1–3 are the window where her cross-checks are possible; if a stage slips past her, its validation falls back to parity artifacts + retro-audit, which is weaker. Protect her window.
