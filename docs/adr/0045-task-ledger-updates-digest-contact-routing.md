# ADR-0045 — P5: ops task ledger + meeting notes, DR3 Updates digest, contact-form routing

**Status:** Accepted (2026-07-04, approved by Bill)
**Date:** 2026-07-04
**Relates to:** mission record §2.1(6)(7)(8)/§6-P5; survey build-inputs §D (Morena: one place for notes/follow-ups — "if someone is out it is hard to understand the full picture"), §E (Bethany's hard board cadence: processed prev-month + MTD due **every 2nd Wednesday AND the Monday preceding it**); open register (dispatch inbox overlaps but is NOT this ADR)
**Series:** P5, after 0044

## Context

Three of Kelsey's residual functions: weekly meeting notes + task follow-ups
(today: email/text/memory), the DR3 Updates digest (**Morena owns the send** —
locked), and website contact-form routing (**tours → Rick** — locked). All three
are thin surfaces over existing machinery: audit-logged tables, the M365 mail
path, the daily-report cron tick for schedule checks.

## Decisions

### D1 — `ops_notes` + `ops_tasks` (the ledger)

```
ops_notes(id, site_id?, note_date @db.Date, title?, body, author_user_id, …audit)
ops_tasks(id, site_id?, title, body?, assignee_user_id?, due_date @db.Date?,
    status enum(open, done, dropped), source enum(manual, meeting, contact_form),
    note_id? FK, created_by, completed_at?, completed_by?, …audit)
```

`site_id` nullable = org-wide items (Bill/Morena cross-site follow-ups; visible
per hard-rule-#2 reach rules — site rows site-scoped, null rows admin/all_sites).
Tasks can be born from a note (meeting → action items in one motion), from the
contact intake (D3), or manually. **Reminders are in-app + digest, never push**
(hard rule #5): overdue/due-today tasks surface on the dashboard tile and ride
the existing ADR-0043 daily digest email as a second section (same recipients
mechanism, still findings-and-tasks-only — a quiet day sends nothing).

### D2 — DR3 Updates digest: Vision drafts, Morena sends

`update_digests(id, period_start, period_end, body_md, status enum(draft,
finalized), generated_by, finalized_by?, …audit)`. Vision auto-generates a
DRAFT (weekly, riding the existing daily-report tick's date logic): production
totals per site (from closes), inbound/outbound movement, open findings count,
notable equipment events (ADR-0044), completed tasks. Morena edits the markdown
in a simple review surface, marks it finalized, and **sends it herself** through
her own mail — Vision renders copy-ready HTML + a "copy to clipboard" affordance
and records finalized state, but never sends this digest (the locked disposition:
Morena owns the send; Vision never impersonates her).

**Board-cadence generator (Bethany's deadline, survey §E):** on every 2nd
Wednesday and the Monday preceding it (pure date function, TDD the calendar
matrix), Vision generates a board-pack DRAFT: processed prev-month + MTD per
site, YoY same-month comparison where history exists, big known cost bumps
(equipment `cost` events over a threshold). Same draft/finalize/human-sends
model — this is a P5 *generation* feature, not a send feature.

### D3 — Contact-form intake + routing

```
contact_intakes(id, received_at, topic String, name?, email?, phone?, message,
    routed_to_email, task_id? FK, source_form String, …audit)
contact_routes(id, topic_match String, route_to_email, active, …audit)
```

A public, token-guarded POST endpoint `/api/intake/contact` (shared-secret
header — the WordPress form plugin posts to it; wiring the WP side is an
operator/webhook action documented in the runbook, NOT Vision code). Routing:
first active `contact_routes` match on topic (seeded: `tour* → rick.albritton@`,
default → morena.gomez@ pending the dispatch-inbox register decision); creates an
`ops_task` (source=contact_form) + notifies the routed person via
`sendSystemEmail` (this one IS sent by Vision — it's a system notification, not
Morena's digest). PII note: name/email/phone are visitor PII — excluded from
exports, retained per a documented window (default 2 years, config), never
logged (row ids in logs only, the hardening discipline). Rate-limited + honeypot
field (public endpoint hygiene); middleware exemption + `public-paths.test.ts`
case per the standing lesson.

### D4 — Observability

Intake accepts/rejects logged (no PII), routing decision logged (route id, not
address), digest generation + finalization audited, task transitions audited.
Intake endpoint failure or unroutable topic pages nothing — it lands in the
default route's tasks (a lost lead is a task, not an outage); the endpoint being
DOWN is caught by normal app health.

## Out of scope

Dispatch inbox / dispatch↔Outlook integration (open register — own decision) ·
processor bonus-standing view (separate quick-win green-light) · trailer/yard
list (P4/P5 window per register, but its own small proposal) · any
Vision-sends-as-Morena path (locked out) · WP form plugin configuration (ops
runbook action).

## Consequences

Five small additive tables; the "information spread in too many places" pain
(Morena Q3) gets one home with audit trails; Bethany's board deadline becomes a
generated draft instead of a scramble; tours stop depending on whoever reads the
inbox first. Everything human-sent stays human-sent.

## Test plan (summary)

Task/note lifecycle + reach rules (site vs org-wide × role matrix) · digest
draft composition from fixtures · board-cadence date function (2nd-Wednesday +
preceding-Monday matrix incl. month edges) · intake: auth, honeypot, rate limit,
routing precedence, task+notify creation, PII log-absence test · digest tick
idempotence · migration clean-replay (CI).
