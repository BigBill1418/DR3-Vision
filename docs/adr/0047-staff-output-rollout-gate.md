# ADR-0047 — Staff-output rollout gate: notifyStaff() chokepoint + per-surface/per-site pilot→live states (+ UI surface-audience flags)

**Status:** Accepted (2026-07-06 evening PT, approved by Bill — incident priority)
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

## Post-acceptance notes (built 2026-07-07)

Shipped as one incident session with the ADR-0039 A1 bootstrap gating. What
landed and where it diverged:

- **One table, two kinds.** `rollout_surfaces(kind ∈ notification|ui,
  surface_code, site_id?, rollout_state, flipped_by?, flipped_at?, criteria_note?,
  …)` with `@@unique([surface_code, site_id])`, rather than two parallel tables —
  the admin panel is one query, the notify + UI gates share one resolver
  (`src/lib/notify/rollout.ts`). Migration `20260713_rollout_gate`. FK columns are
  bare scalars (repo convention, mirrors ADR-0040); `flipped_by` is a bare
  audit-actor column (mirrors `alert_recipients.created_by`).
- **No NULL-site rows.** Every surface is seeded per site (Eugene + Woodland),
  avoiding the Postgres NULL-unique ambiguity. An **org-wide** notification (site
  = null, e.g. the AP module) resolves conservatively: `pilot` unless EVERY
  per-site row is `live`. The fail-safe direction.
- **`equipment_tab` split into `equipment_entry` + `equipment_trend`** (§8 Stage 2
  separation) so the trend view can stay admin in pilot even after event entry
  goes live.
- **The digest fires in pilot even with a muted roster.** The old
  "skip when no recipients" guard would have suppressed the pilot admin-validation
  send while the roster is muted; it now sends to admins in pilot and only
  short-circuits when there is genuinely no one to send to (live + empty roster).
- **§4.4 completeness sweep — unlisted outbound staff paths found.** Three
  `sendSystemEmail` importers were NOT in §4.4 and NOT in the grandfathered
  out-of-scope list (directive §3: report, do not guess):
  1. `src/lib/bonus/daily-report-notifications.ts` (ADR-0030 daily production
     report) — **grandfathered** (allowlisted) to avoid regressing a working,
     relied-upon production email on the incident-night deploy. → Q-0047-1.
  2. `src/lib/bonus/amendment-notifications.ts` (ADR-0028/0029 amendment lifecycle
     mail; mostly admin/Bill, one staff recipient on a decided notification) —
     **grandfathered** (allowlisted). → Q-0047-2.
  3. `src/lib/ap/approvals.ts` `sendDecisionEmail` (AP decision → Mary's GP
     filing) — the literal directive named only `ap/notify.ts`, but this is the
     same dormant AP module. **Routed through `notifyStaff(ap_notify)`** (born
     pilot), a coherent extension of "AP module staff notifications", NON-disruptive
     because the module is dormant. → Q-0047-3.
  See `docs/QUESTIONS.md` for Bill's disposition on all three; the grandfathered
  two convert to `notifyStaff()` when he decides.
- **Repo guard** is `src/lib/notify/__tests__/no-direct-mail.test.ts` — a
  fixture-free tree scan with an in-memory synthetic-import test-of-the-test and
  a test/fixture-exclusion test. The allowlist enumerates: transport core, notify
  layer, `src/lib/auth*` prefix, payroll delivery, and the four grandfathered
  senders.
- **Acceptance** (directive §6) covered by tests: (a)/(b) `bootstrap-gate.test.ts`
  (fresh-site suppress, first-data-row live); (c) `notify-staff.test.ts` (pilot →
  admins, staff receive nothing); (d) `flip.test.ts` (audited + immediate + note
  required); (e) `no-direct-mail.test.ts`; (f) migration `20260713b_bootstrap_resolve`.
  Plus the Pacific close-timing matrix, the amendment error-map, and the logo URL.

## Release-discipline rule (record here, in CLAUDE.md, and the PR template)

Any change adding or expanding staff-visible output (emails, ntfy, new recipient
rosters, new dashboards linked from emails) ships in **pilot** and is ramped only
by Bill from `/admin/rollout`. Recipient rosters named in directives/handoffs are
the EVENTUAL audience, never the day-one audience. New staff-facing output
inherits the gate by construction (register a `rollout_surfaces` row — born
pilot — and route through `notifyStaff()`; the repo test enforces the latter).

## Post-acceptance note — Q-0047 resolutions (planning rollup 2026-07-08 §1.2/§3)

Bill's dispositions on the three §4.4-sweep grandfathering questions:

- **Q-0047-1 (ADR-0030 daily production report):** permanent grandfather through
  cutover; revisit post-8/1 is optional. ADR-0049 (workbook sync) fixes the
  underlying accuracy problem structurally, so gating it became moot. It stays on
  the allowlist.
- **Q-0047-2 (ADR-0028/0029 amendment lifecycle mail):** **permanent grandfather.**
  Working production surface, not incident-implicated; keeps its signature-chain
  treatment and is not rerouted through `notifyStaff()`.
- **Q-0047-3 (AP mailbox emails):** both AP email kinds (the incoming-request alert
  AND the decision-back-to-accounting mail) flip together under the one `ap_notify`
  surface. Already routed through `notifyStaff('ap_notify')` (born pilot).

New surfaces registered since acceptance (all born pilot): `board_pack_digest`
(notification, org-wide — ADR-0045 §3 addendum) and `yard_list` (UI — rollup §1.8).
