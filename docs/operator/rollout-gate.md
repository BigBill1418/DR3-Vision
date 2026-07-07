# Operator runbook — staff-output rollout gate (ADR-0047)

**What it is.** Every staff-facing output — email notifications and gated UI
surfaces — is now registered in `rollout_surfaces` with a per-site state of
`pilot` or `live`. In **pilot** (the default), notification output reroutes to
**admins only** (with a `[PILOT — would have sent to: …]` subject + a body
banner), and gated UI surfaces stay **admin-only**. Staff receive/see nothing
until an admin flips a surface **live** from the admin panel. This makes
"unfinalized output reaching staff" structurally impossible, not just
procedurally avoided (the 2026-07-06 incident).

## The admin panel

`https://dr3-vision.svdp.us/admin/rollout` (admin role only). Lists every
surface × site with its state, last-flip evidence, and a **Flip** button. A flip
requires a **criteria note** (the evidence that justifies the ramp) and is
audited + immediate. **Rollback = the inverse flip** (one admin action, no code,
no deploy).

## Seeded state (post-deploy)

Notification surfaces — **pilot** (per site): `alert_digest`, `task_reminders`,
`contact_intake_notify`, `invoice_approval_notify`, `cor_notify`, `ap_notify`.
Notification surfaces — **live** (grandfathered, established production):
`bonus_signature_chain`, `survey_sends`.
UI surfaces — **pilot** (admin-only per the ADR-0037 D7 template):
`workbench_manager_read`, `loads_events_or_tabs`, `equipment_entry`,
`equipment_trend`.

`invoice_approval_notify` and `cor_notify` have **no mail path built yet** — they
are registered ahead of time so that when ADR-0041/0042 add one, it is born
gated. `task_reminders` currently rides the `alert_digest` mail path (gated by
the digest's state); the standalone surface is registered for a future
independent reminder path.

## REQUIRED post-deploy operator steps

1. **Re-activate the muted alert roster.** The `alert_recipients` rows were
   muted (`active = false`) on prod the night of the incident. The gate keeps the
   digest in **pilot regardless**, so re-activating is safe — pilot ignores the
   roster and sends to admins; the roster only becomes the recipient list once
   `alert_digest` is flipped live. Re-activate with the admin recipient tooling
   (or, if doing it directly, set `active = true` on the intended rows). Do this
   so the roster is correct for the eventual `alert_digest` live flip; it does
   **not** page staff in the meantime.

2. **Confirm the bootstrap findings auto-resolved.** Migration
   `20260713b_bootstrap_resolve` runs in the migrate init-container and resolves
   the open bootstrap findings (Eugene `c4_billing_basis` + `m2_missing_snapshot`,
   plus any third) with cause `bootstrap_suppression` + a provenance note. Verify
   in the audit surface that they show **resolved / bootstrap_suppression** and no
   staff-visible bootstrap findings remain.

3. **Review pilot digests daily** (§8 Stage 0). The digest now arrives to admins
   with the would-have-sent header. Ramp `alert_digest` to live only after
   ≥5 consecutive clean reviewed pilot digests + ≥1 true finding handled
   end-to-end (§8 Stage 4).

## Ramping a surface (per the staged activation plan, ADR-0047 §8)

Flip the surface to **live** in the admin panel and record the criteria
evidence. Examples:
- **Workbench manager read** (`workbench_manager_read`) → Stage 2 (Woodland
  managers get Workbench READ).
- **Equipment** — flip `equipment_entry` when Terex capture ramps (Stage 2);
  keep `equipment_trend` in pilot until the trend has data (trend stays admin
  even when entry is live).
- **Alert digest** (`alert_digest`) → Stage 4 (staff-facing comms ramp).

Every stage's exit criteria gate its flips — schedule pressure changes the
calendar, never the criteria (§8 standing rule 1). Any Sev-worthy surprise → flip
the affected surface back to pilot first, diagnose second (§8 standing rule 3).

## Bootstrap gating (ADR-0039 Amendment 1)

A missing-counterpart audit check (`c4_billing_basis`, `m1_missing_close`,
`m2_missing_snapshot`, and any future one) only emits findings once its **leg**
has ever had data for the site, OR an admin-set `go_live_date` has passed. Set a
per-(site, leg) go-live override by inserting a row into `audit_bootstrap_gates`
(`leg` ∈ `billing` | `close` | `snapshot`). Suppressed evaluations are counted
per-check into `audit_runs.suppressed_bootstrap` (visible in the admin audit
page) — never silent.
