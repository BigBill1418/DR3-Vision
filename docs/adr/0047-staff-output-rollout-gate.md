# ADR-0047 — Staff-output rollout gate: notifyStaff() chokepoint + per-surface/per-site pilot→live states (+ UI surface-audience flags)

**Status:** PROPOSED — awaiting operator review (Bill; incident directive 2026-07-07 §4 + §8 Stage-0)
**Date:** 2026-07-07 (incident-priority)

## Context

2026-07-06 incident: the ADR-0043 digest emailed a site manager two true-but-
useless bootstrap findings the day the feature merged. Root cause #2: staff-
facing output had no staging step. Directive: unfinalized surfaces reaching
staff must be **structurally impossible**.

## Decisions (directive §4, restated as build contract)

1. **`notifyStaff()` is the only path to non-admin recipients.** New
   `src/lib/notify/` policy layer wraps email (and any future staff ntfy —
   none exist; ntfy stays Bill-only). Feature code importing the raw mail
   sender fails a repo test (allowlist: the policy layer, auth flows, and the
   EXISTING pre-gate senders grandfathered per §4.4's out-of-scope list).
2. **`notification_surfaces` registry + `rollout_state` per surface × site**:
   `pilot | live`. Pilot ⇒ output reroutes to admins with a
   `[PILOT — would have sent to: …]` header (validates content AND targeting).
   Live requires an explicit admin flip — audited, per surface per site, with
   criteria evidence noted in the flip (directive §8 standing rule 2).
3. **Default pilot, always** — the registry seed AND every future migration
   creating a surface. New staff-facing output inherits the gate by
   construction.
4. **Surfaces under the gate now** (seeding per §4.4): 0043 alert digest
   (pilot — incident surface) · 0045 task reminders (pilot) · 0045 contact-
   intake routing notifications (pilot) · 0041 invoice-approval notifications
   (pilot) · 0042 COR notifications if any (pilot) · 0046 AP notifications
   (born pilot). OUT: bonus signature-chain (live — established production),
   survey sends (live — per-invite Bill-gated by design), Updates/board-pack
   (no mail path by construction). Any unlisted outbound path found during
   build ⇒ STOP and ask (directive §3 of the execution order).
5. **UI surface-audience flags (§8 Stage-0 extension).** Same
   rollout_state mechanism, applied to dashboard surface visibility per site,
   using the ADR-0037 D7 admin-only gate as the template:
   `ui_surfaces` rows for — Workbench (manager read), loads-inventory
   events/OR-counts tabs, Terex/equipment tab (trend + entry separable per
   §8 Stage 2). Pilot ⇒ admin-only (current D7 behavior); live ⇒ the surface's
   designed audience. Admin flip page lists every surface × site with state +
   flip history.
6. **Release-discipline rule** recorded here, in CLAUDE.md, and the PR
   template: staff-visible output ships pilot; rosters in directives name the
   EVENTUAL audience, never day-one.

## Acceptance = directive §6 (a)–(e) as tests; consequences

One registry, one chokepoint, one admin page; every future feature pays a
one-row cost to exist and cannot skip staging. Rollback of any ramp = flip to
pilot, no code.
