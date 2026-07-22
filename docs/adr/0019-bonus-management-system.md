# ADR-0019: Bonus Management System

**Date:** 2026-06-05
**Status:** Accepted
**Supersedes:** N/A (extends ADR-0011)

## Context

DR3 Woodland operates a daily mattress-handling bonus for processors on the deconstruction line. This is the primary motivator for line throughput. Until now, bonuses have been tracked on paper and an Excel spreadsheet (`Bonus_Spread_Sheet_2026.xlsx`), with manual calculation, manual signature, and manual delivery to SVdP payroll.

This system has three failure modes that have justified bringing it inside DR3-Vision:

1. **The spreadsheet's formula is wrong** — see §1 below. Historical payouts have been ~$0.25/day per processor low at high-throughput days.
2. **No system of record** — bonus history lives in personal email threads and printed signatures. A processor disputing a past month has no canonical source.
3. **Manual delivery breaks** — PDFs are forgotten, signatures get out-of-order, payroll receives inconsistent formats.

This ADR specifies the system that replaces all three with a code-enforced workflow.

**Scope:** Woodland only in V2. Eugene has no equivalent bonus structure today; Rick (Eugene manager) gets a 403 on `/bonus` routes. The schema is site-scoped so Eugene can be enabled in V2.1+ without migration.

## Decision summary

The Bonus Management System is the **first active tile** on the new Vision Dashboard (ADR-0020). It ships as a top-priority Sprint 2 deliverable, ahead of the V2.1 backlog. All twelve design decisions below are locked.

### 1. Formula correction

The corrected formula:

- Processors qualify for the bonus at **50 or more mattresses handled in one day**
- Mattresses 51 through 74: **$0.50 per mattress**
- Mattresses 75 and up: **$0.75 per mattress**

Modeled as the existing two-threshold additive shape, with the high threshold corrected:

```
daily_bonus = MAX(units − 50, 0) × $0.50 + MAX(units − 74, 0) × $0.25
```

The off-by-one correction is on `threshold_high`: was 75, now **74**. Walk-throughs:

| Units handled | Formula                   | Total                            |
| ------------- | ------------------------- | -------------------------------- |
| 50            | (0 × 0.50) + (0 × 0.25)   | $0.00 (qualifying day, no bonus) |
| 51            | (1 × 0.50) + (0 × 0.25)   | $0.50                            |
| 74            | (24 × 0.50) + (0 × 0.25)  | $12.00                           |
| 75            | (25 × 0.50) + (1 × 0.25)  | $12.75 (1 mattress earns $0.75)  |
| 100           | (50 × 0.50) + (26 × 0.25) | $31.50                           |

ADR-0011 is updated by reference. The existing `processor_bonus_rules.csv` seed row for Woodland is corrected in-place because no historical bonus rows exist in DR3-Vision yet (the portal isn't built). The 2026 spreadsheet's prior incorrect calculations are not retroactively reconciled — that's last-year payroll and outside DR3-Vision's scope.

### 2. EOD enforcement (ntfy)

> **Revised 2026-06-17:** the alert now fires only when a site has **zero**
> bonus entries for the day — see the revision note below. The original
> "any active employee missing an entry" rule (struck through) was too noisy:
> not every processor has a bonus every day (different position, day off), so
> a partial day is normal and must not page.

If a bonus-enabled site has **no entries at all** by the **5:00 PM Pacific Time**
cron run, ntfy fires once to the `dr3-vision-system` topic with fingerprint
`bonus-entry-missing:<site>:<YYYY-MM-DD>`. A day with at least one entry — even a
single processor — does not page. Weekends, site holidays, and sites with no
active employees are skipped. Strict — a late entry the next morning does not
retroactively suppress the alert (ntfy has no un-send); it falls under a
different day's fingerprint.

The fingerprint guarantees one alert per missed day. Cooldown is moot because the fingerprint already de-duplicates.

> **~~Original rule (superseded 2026-06-17):~~** _~~If Janette has not entered
> the day's counts by 5:00 PM PT, ntfy fires; the alert body named the count of
> active employees without an entry, so a partial day paged.~~_

### 3. PDF delivery (M365 Graph)

Once both signatures land, the PDF generates automatically and is emailed to `payroll@svdp.us` via the **Microsoft Graph API** (`POST /users/{from-mailbox}/sendMail`). Intra-tenant delivery avoids the spam-filter complications a third-party SMTP service would introduce. See ADR-0021 for the integration design.

**From mailbox:** `dr3-vision@svdp.us` — purpose-built service mailbox, makes the source obvious in payroll's inbox, easy to filter. Mailbox creation is an operator-side residual (see `docs/operator/m365-mail-send-setup.md`).

**App registration:** the existing DR3-Vision Entra app registration (created in ADR-0016) gains a new `Mail.Send` application permission, admin-consented once. No second app.

### 4. Daily entry: who can key

Daily mattress counts can be entered by:

- **Janette** (Woodland facility manager) — primary
- **Morena** (California operations manager) — if Janette is unavailable
- **Bill** (administrator) — if both are unavailable

The `bonus_daily_entries.entered_by_user_id` column captures the actual keyer. The audit log records the action with full before/after JSON.

### 5. Monthly signature override

The standard signing flow:

1. Janette signs first (facility manager attestation)
2. Morena signs second (operations manager attestation)
3. On second signature: state transitions to `signed`, PDF generates, email queues

**Asymmetric override authority:**

- **Janette's signature** can be provided by **Bill or Morena** if she's unavailable
- **Morena's signature** can be provided by **Bill only** (facility manager doesn't outrank ops manager in this attestation chain)

**Override is always available** — no grace period gating. Any authorized person can sign whenever the month is in `pending_signatures` or `partially_signed`.

Override events are documented on the PDF (attestation block reads "Signed by Bill Barnard, admin, on behalf of Janette Thomas, unavailable"). The original assigned signer's name is preserved in the PDF for clarity.

### 5a. Signature-request emails (addendum 2026-06-06)

Signers must be **actively prompted by email** when their input is required — they
should not have to remember to check the portal at month-end.

Two prompts, keyed on the state-machine transitions (so overrides and amendment
re-signs are handled automatically — the prompt follows the _unsigned slot_, not a
hardcoded person):

1. **Month closes → first signer prompted.** When a month transitions
   `draft → pending_signatures` (the month-end auto-close, §2 / T-106
   `closeMonthsDueForSignature`, and the amendment path `amended → pending_signatures`),
   email the **facility-manager slot's signer** (Janette): "The {Month YYYY} Woodland
   bonus report is ready for your signature."

2. **First signature lands → second signer prompted.** When a month transitions
   `pending_signatures → partially_signed`, email the signer of the **still-unsigned
   slot** (normally Morena, the operations-manager slot; if a slot was filled out of
   order via override, the prompt targets whichever slot remains): "Janette has signed
   the {Month YYYY} Woodland bonus report; your signature is needed."

Recipients are **resolved dynamically from the `users` table**, never hardcoded:
the facility-manager slot → the active `manager` whose `primary_site_id` is Woodland;
the operations-manager slot → the active `manager` whose `primary_site_id` is null
(both-sites). Bill (admin) is not auto-prompted but may sign at any time via override.

**Channel:** Microsoft Graph email (ADR-0021), reusing the same `sendSystemEmail`
helper as the payroll delivery — **not** ntfy (ntfy is Bill's incident channel per
ADR-0037; routine signer nudges to named staff belong in email). Each email links
directly to the month page (`/bonus/months/[id]` — a tier-1 click target) and is
**fail-open** (a mail outage never blocks signing; it logs + audits
`actor_label = 'system:signature-request'`). Delivery fires once at the moment of
transition (not on a poll), so no de-dup state is needed; reminder re-sends are out of
scope for V2. Implemented in T-125.

A manual **"Month complete — ready to sign"** button on `/bonus` (shown only while
the month is `draft`) lets an operator close the current month on demand rather
than waiting for the month-end auto-close cron. It drives the same
`draft → pending_signatures` transition and the same signature-request prompt.

### 6. Amendment workflow

Once a month is `signed` and the PDF has been emailed to payroll, the data is locked. Corrections require an **admin-only amendment** (Bill only).

Amendment workflow:

1. Bill unlocks the signed month (state: `signed` → `amended`)
2. Both signatures are cleared; daily entries become editable again
3. Edits are made (audit log captures every change)
4. State returns to `pending_signatures`
5. Both signatures must be re-collected (Janette + Morena, with overrides allowed as in §5)
6. New PDF generates, marked "**Amended**" in the title block, with a notice line: "_This document supersedes a prior version emailed to payroll on [date]_"
7. New PDF is auto-sent to payroll@svdp.us

The original signed version is preserved in the audit log and in R2 (the original PDF is never deleted). Payroll's email archive retains the original as well; the amended PDF is the new source of truth from its delivery date forward.

### 7. Daily entry granularity

One number per active employee per day. Optional freeform note field for HR annotations ("left early — sick", "covered for \_\_\_", etc.). Notes do not affect bonus math. Half-days, partial shifts, and hours-worked are out of scope — those belong in the payroll system.

The entry UI is a daily grid: column 1 is employee name (ordered alphabetically by `is_active=true`), column 2 is numeric input (integer, 0–999 valid range, soft-warning above 200), column 3 is the optional note field.

Live totals tick at the top of the page (today's per-employee bonus, today's grand total). The bonus is computed from `processor_bonus_rules` for the current effective date, so a future rule change is automatically reflected without code.

### 8. Historical visibility

Full read-only browsing:

- **Past months** — daily grid, monthly totals per employee, both signatures with timestamps, PDF download link
- **Per-employee cross-month view** — "show me Maria's bonus history" — last 12 months, year-to-date, optionally arbitrary date range
- **Annual aggregate** — per-employee year-to-date totals, exportable as CSV for SVdP internal use (not for payroll — payroll has the PDFs)

All visibility is **site-scoped**. Rick (Eugene manager) cannot see Woodland's bonus data. Morena, Janette, and Bill see Woodland data.

### 9. Employee identity

#### 9a. Rehires

**Same employee record reactivated.** When a deactivated name is re-added, the UI prompts: "An inactive employee with this name exists (Maria Lopez, deactivated 2026-03-15). Reactivate this record, or create a new one?" — Janette's choice. Default is reactivate. Annual totals roll up continuously across employment gaps.

#### 9b. Name changes

**Retroactive display.** When Janette changes "Maria Lopez" to "Maria Garcia", all in-portal views show "Maria Garcia" everywhere (including past months). The employee detail view shows a "Previously known as: Maria Lopez (changed 2026-08-15)" badge.

The old name is preserved in:

- The audit log (the before/after JSON of the update)
- A `previous_names` JSONB column on `bonus_employees` (array of `{name, changed_at}`)

PDFs already emailed to payroll are immutable in payroll's archive — we do not reissue past PDFs because a name changed.

#### 9c. Employee ID stability

The `bonus_employees.id` UUID is stable across name changes and rehires. The PDF displays the name as it currently is in the system at sign time. An amended PDF (per §6) reflects the current name as of amendment date.

### 10. PDF branding

**Co-branded.** Both DR3 and SVdP logos appear in the PDF:

- **Header:** DR3 Vision logo (DR3 green, top-left) | Title block "DR3 Woodland — Monthly Processor Bonus Report" centered | SVdP seal (top-right)
- **Body:** Per-employee table (name, days qualified, total mattresses handled, total bonus), monthly grand total
- **Signature block:** Two signature areas with attestation language ("I certify the above bonus calculations are accurate and authorize payment"), signed name + role + timestamp + IP + user-agent
- **Footer:** "St. Vincent de Paul Society of Lane County · DR3 Operations" wordmark, document ID (`bonus-<site>-<YYYY-MM>-<short-uuid>`), generated timestamp

Layout uses DR3 brand colors throughout (green #00524C primary, chartreuse #EFFE8B for accent). Inter typography.

Generated via Playwright `page.pdf()` against a server-rendered HTML page at `/internal/bonus-pdf/{month-id}` (not publicly accessible — internal route, served only to the PDF generator). Playwright base image is already in the production Dockerfile (T-015).

### 11. Retention

All bonus records — daily entries, signed months, generated PDFs in R2 — retained **indefinitely**. No pruning. Matches the audit log posture (ADR-0007) and the project's overall "no pruning" rule.

This is independent of payroll record retention. SVdP payroll has its own retention rules through its payroll system; DR3-Vision maintains its own permanent record so reconstructing a payment history doesn't depend on payroll's archive.

### 12. Sprint shape

**Multi-agent Sprint 2.** Standalone deliverable, hard cutover. Ships before all other V2.1 work. Replaces the current `/` "coming soon" landing with the Vision Dashboard (ADR-0020). See `docs/SPRINT-2-PLAN.md`.

## Schema

New tables:

```
bonus_employees
  id, site_id, full_name, previous_names JSONB,
  is_active, user_id (optional FK to users — most processors are NOT system users),
  notes, created_at, updated_at, deleted_at

bonus_daily_entries
  id, bonus_employee_id, bonus_month_id, entry_date,
  mattress_count, note,
  entered_by_user_id, entered_at
  UNIQUE (bonus_employee_id, entry_date)

bonus_months
  id, site_id, month_start, month_end,
  state (enum: draft | pending_signatures | partially_signed | signed | paid | amended),

  janette_signed_by_user_id, janette_signed_at, janette_signed_ip,
    janette_signed_user_agent, janette_override_actor_id,

  morena_signed_by_user_id, morena_signed_at, morena_signed_ip,
    morena_signed_user_agent, morena_override_actor_id,

  pdf_storage_key, pdf_generated_at,
  payroll_sent_at, payroll_message_id,

  amended_from_month_id, amendment_reason, amended_by_user_id, amended_at,

  total_payout_cents,
  created_at, updated_at
  UNIQUE (site_id, month_start)
```

Full Prisma DSL in `prisma/schema.prisma.bonus.patch`.

The existing `processor_bonus_rules` table (from Sprint 1) drives the calculation engine. Its Woodland row is corrected in-place to `threshold_high=74, rate_high=0.25` via the migration in T-101.

## Routes

- `/bonus` — daily entry grid (default view, current month)
- `/bonus/employees` — employee management (Janette CRUD)
- `/bonus/months` — month list with filter (current, signed, amended, etc.)
- `/bonus/months/[id]` — month detail with signature buttons + state machine
- `/bonus/months/[id]/pdf` — download/preview the PDF
- `/bonus/employee/[id]` — per-employee historical view (cross-month aggregation)
- `/bonus/annual` — annual aggregate view
- `/internal/bonus-pdf/[month-id]` — server-rendered HTML used as PDF source (gated to internal calls only)

All routes gated to:

- `manager` role with `primary_site_code = woodland` (Janette)
- `manager` role with `primary_site_code = null` (Morena — both sites)
- `admin` role (Bill, Kelsey)

Rick (Eugene manager) gets 403. Operators (PIN users) cannot reach `/bonus` — operators authenticate via PIN, not Entra SSO, and the route group requires Entra session.

## Alternatives considered

- **Standalone application separate from DR3-Vision.** Rejected. Would duplicate Entra auth, ntfy, R2, audit log, branding, fleet deployment. Single application is operationally simpler.
- **Build into the existing `processing_sessions` (V2.1) workflow.** Rejected. Bonus is a payroll instrument; processing_sessions is an operational tracking instrument. Conflating them confuses retention rules and access scoping.
- **Daily entry by each processor self-reporting via iPad.** Rejected. Processors are PIN-authenticated; bonus needs full identity (Entra SSO) and dual sign-off; self-reporting creates incentive misalignment.
- **No EOD enforcement.** Rejected. The data MUST be current at EOD per Bill — late data compromises payroll cycle reliability.
- **Cryptographic signatures (PKI).** Rejected as theater for this use case. Two SVdP employees attesting via authenticated session + captured IP/UA is sufficient; the PDF is the canonical record once delivered.

## Consequences

- M365 Graph integration is now load-bearing. If Microsoft's API has an outage, PDF delivery queues until it recovers (sendMail call is retried with backoff; failure publishes to `dr3-vision-system` ntfy).
- The mailbox `dr3-vision@svdp.us` becomes a critical asset. Its credentials are tied to the Entra app registration, not a user-mailbox password. Rotation procedures documented in ADR-0021.
- The existing Entra app registration carries both SSO (`User.Read`) and email (`Mail.Send`) permissions. A future audit of permission scope should note these are the minimum set; nothing else is added.
- The Vision Dashboard (ADR-0020) becomes the new authenticated entry point. The current "coming soon" placeholder is removed in T-115.
- Eugene's future bonus configuration (if ever introduced) requires only: new `processor_bonus_rules` row + lifting the Rick 403 gate. No schema changes.

## References

- ADR-0011 (Processor Form / bonus formula shape — predecessor)
- ADR-0016 (Entra ID SSO — auth foundation)
- ADR-0007 (Audit log — append-only retention)
- ADR-0020 (Vision Dashboard tile landing)
- ADR-0021 (M365 Graph mail-send)
- ADR-0022 (Fleet observability wire-in)
- `docs/SPRINT-2-PLAN.md` (ticket breakdown)
- `Bonus_Spread_Sheet_2026.xlsx` (in transcripts, source of the formula correction)

## Post-acceptance amendment — 8pm entry deadline (later shift, 2026-07-21)

The team moved to a later work shift. The bonus-entry deadline (ADR-0019 §2,
the "no entries for the site" end-of-day check) moves from **17:00 PT to 20:00
PT** — "the bonus is to be entered by 8pm at the latest; after that we get the
notification that it is late."

- `scripts/bonus-eod-check.mjs` `FIRE_HOUR_PT` 17 → 20. The daemon still fires
  once per Pacific day, per-site, DST-correct via the offset-reprobe
  `nextFireInstant` (no hardcoded UTC offset), and pages `dr3-vision-system`
  only when a bonus-enabled site has **zero** entries for the day (partial days
  never page — the 2026-06-17 §2 revision stands).
- The pure decision logic (`src/lib/bonus/eod-check.ts` `evaluateEod`) is
  unchanged — only the fire hour moved.
- **Signing escalation tiers (07:10 / 07:30 / 08:30 auto-sign / 09:00 PT,
  `bonus-escalation-check.mjs`) are NOT affected.** Those govern SIGNING the
  chain the morning after a period close — a distinct concern from entry. This
  amendment deliberately does not touch them.

The paired per-site "report on save" change lives in ADR-0030's amendment.
