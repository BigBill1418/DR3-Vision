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
model — this is a P5 _generation_ feature, not a send feature.

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

## Post-acceptance implementation notes (2026-07-05)

Built in worktree `feat/adr-0045-ledger` alongside the parallel ADR-0044 build.
Deviations and decisions worth recording:

1. **`update_digests.kind` enum added (not in the D2 illustrative DDL).** Both the
   weekly Updates digest and the board pack live in one table; a `kind`
   (`weekly` | `board_pack`) plus the unique `(kind, period_start)` gives each
   generator its own per-period idempotency. A re-fire is a no-op so a human's
   edits are never clobbered — this is why the board pack fires on BOTH the 2nd
   Wednesday and the preceding Monday yet only ever produces one draft per month
   (both dates map to the same `period_start` = first-of-previous-month).

2. **Equipment events (D2) — absent-table fallback (ADR-0039 leg-fetcher precedent).**
   The ADR-0044 `equipment_events` table is a sibling build not present in this
   worktree, so `src/lib/ops/equipment-provider.ts` defines an injectable
   `EquipmentProvider` interface and ships `absentEquipmentProvider` (returns
   nothing, `available: false`) as the default the digest fire uses. The composer
   prints an honest "equipment events unavailable" line instead of crashing.
   **MERGE-WIRING:** after ADR-0044 lands, implement a `prismaEquipmentProvider` and
   pass it into `runUpdateDigestFire` / `generateBoardPackDraft` — a one-line swap
   (marked in the provider file).

3. **Schema coordination.** One contiguous end-block `// ADR-0045 — ops ledger +
intake`. Sibling-owned FK columns (`site_id`, audit-actor columns) are bare
   scalars with DB-level constraints created in the migration (ADR-0040/0041/0042
   precedent); only the two intra-block relations carry Prisma relations. This keeps
   the shared `Site`/`User` models untouched (no back-relation fields), so the
   0044/0045 merge is conflict-free on those models.

4. **The daily digest gate changed (ADR-0043 extension).** `runAlertDigestFire` now
   also gathers overdue/due-today tasks and sends when findings OR due tasks exist.
   The tasks section is **site-scoped only** (org-wide follow-ups surface on the
   dashboard tile, never duplicated across both sites' emails).

5. **Intake is genuinely public (fail-CLOSED), unlike the internal crons.** The WP
   plugin POSTs over the public tunnel, so `/api/intake/` is a real public exemption
   guarded by the `x-intake-token` shared secret (absent env → 503, never open) +
   honeypot + per-IP rate limit — not a `cf-connecting-ip` 404. Contrast the M365
   mail path, which is fail-OPEN: a missing OUTBOUND-mail secret must not break the
   app, but a missing INBOUND-auth secret must never open a public write path.

6. **The Updates digest + board pack have no send path.** `update-digest.ts` imports
   no mail transport and calls no send helper; a companion test scans the source and
   fails on any such reference. The D3 intake notification is the only email Vision
   itself sends.

## §3 addendum — board-pack digest becomes a sent notification surface (planning rollup 2026-07-08 §1.8)

D2 built the board-pack as a DRAFT-only generator (human sends). Bethany's hard
board cadence + the §1.8 disposition promote it to an **actual sent digest**, born
pilot per ADR-0047. This addendum adds a send path **alongside** the existing draft
generator (the draft in `update_digests` is untouched).

- **New surface `board_pack_digest`** — org-wide, registered in
  `src/lib/notify/rollout.ts` (`NOTIFY_SURFACE.BOARD_PACK_DIGEST`), seeded per site,
  **born pilot** (resolves `pilot` unless BOTH sites are live — the org-wide
  fail-safe). All sends go through `notifyStaff('board_pack_digest', site: null)`;
  in pilot they reroute to admins for content+targeting validation.
- **Recipients:** `board_pack_recipients` roster (mirrors `ap_decision_recipients`).
  Bethany + Bill mandatory; seeded with Bill's login + a documented Bethany
  PLACEHOLDER address (`docs/operator/board-pack-digest.md`) until her real address
  lands.
- **Schedule:** 2nd Wednesday of the month + the Monday preceding it (Pacific),
  reusing `isBoardPackDay` from `src/lib/ops/digest-calendar.ts`. A thin daily
  `board-pack-digest` cron fires 07:00 PT and POSTs `/api/internal/board-pack/send`;
  the route decides whether today is a board-pack day. Idempotency: a
  `board_pack_send_log` row keyed on `period_start` (first-of-previous-month) makes
  the 2nd-Wed + preceding-Mon double-trigger — and any restart re-fire — a single
  send per month (mirrors `alert_digest_log`).
- **Payload** (`src/lib/board-pack/digest.ts`): prev-month processed units
  (`processed_units_daily`), MTD current, YoY (same month prior year, via the
  `time.ts` UTC-Y/M/D invariants), a P&L PLACEHOLDER line ("Financials: pending GP
  integration"), and **no safety/injuries section** (dropped per §1.8). Rendered in
  the SVdP-branded email shell (same masthead + self-hosted public logo as the daily
  production report).
- **First LIVE send target: 2026-08-10** — but it ships PILOT and is ramped only by
  Bill from `/admin/rollout`.

## Amendment — 2026-07-16 (operator: ops ledger to live; email link; assign to an admin)

Operator directive ("flip the ops ledger to live … a link for the team to
access the ops ledger in the emails … the ability to assign a task to a
particular admin — ready for live use"). The ledger tile was already `active`
(manager+) and its reminders already ride the LIVE `alert_digest` surface, so
"live" is confirmed, not a new flip. Two functional additions:

- **Always-on ledger link in the digest.** Every daily digest now carries an
  "Open the ops ledger" button in the footer (previously only rendered when
  due tasks existed), so the team can reach the ledger from any digest email.
- **Assign a task to a particular admin.** `ops_tasks.assignee_user_id`
  already existed; now surfaced end-to-end: the create form and a per-row
  control offer the active-admin roster (`listAssignableAdmins`), the POST/
  PATCH routes validate the assignee is an active admin
  (`assertAssignableAdmin` → 422) and audit reassignment (`reassignTask`),
  and the queue shows the owner (`@Name`). Scope is `role='admin'` per the
  request; a non-admin/unknown id is refused.
