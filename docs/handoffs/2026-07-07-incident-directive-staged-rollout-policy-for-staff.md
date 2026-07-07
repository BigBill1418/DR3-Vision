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
