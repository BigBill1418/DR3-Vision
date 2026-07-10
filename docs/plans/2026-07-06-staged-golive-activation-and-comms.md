# Staged Go-Live Activation & Communication Plan

**Date:** 2026-07-06 (evening PT) · **Owner:** Bill · **Author:** Terry (research/architect session)
**Status:** DRAFT for Bill's review · **Drives:** ADR-0047 rollout gate flips + ADR-0037 D7 activation gates
**Operationalizes:** `docs/handoffs/2026-07-07-incident-directive-staged-rollout-policy-for-staff.md` §8 (Stages 0–5, exit criteria already decided) and §7 (Rick note)

> **This plan does not re-plan.** §8 decided the stages, the audiences, and the exit criteria. This document turns each stage into (1) the exact ADR-0047 flips to execute, (2) the operator actions with runbook links, (3) who is affected, (4) the exit criteria verbatim, (5) rollback — plus the data-prepopulation matrix (Part 2), the drafted team communications (Part 3), and the open decisions for Bill (Part 4).

**Standing rules (§8, non-negotiable — repeated here so every flip inherits them):**
1. No stage starts before the prior stage's exit criteria are met. Schedule pressure changes the calendar, never the criteria.
2. Every flip is audited with the criteria evidence noted in the flip.
3. Any Sev-worthy surprise at any stage → affected surface back to `pilot` first, diagnose second.
4. **Protect Kelsey's window.** Her availability ends 8/1; Stages 1–3 are the only window her cross-checks are possible. If a stage slips past her, its validation falls back to parity artifacts + retro-audit (weaker).

**Two gate mechanisms this plan drives:**
- **ADR-0047 `notification_surfaces.rollout_state`** (`pilot | live`) — per surface × site. `pilot` = admins only, output carries `[PILOT — would have sent to: …]`. Flip = admin action, audited. Governs EMAIL/notification surfaces.
- **ADR-0047 `ui_surfaces` audience flags** (Stage-0 extension, same mechanism, ADR-0037 D7 template) — per surface × site. `pilot` = admin-only (current D7 behavior); `live` = designed audience. Governs DASHBOARD VISIBILITY (Workbench read, events/OR-counts tabs, Terex tab).
- **Rollback for BOTH is identical: flip back to `pilot`. One admin action. No code, no deploy.**

---

## PART 1 — Activation runbook (per §8 stage)

### Stage 0 — this week (wk of 7/6): admin-only, foundations true

**State as of tonight (Mon 7/6 evening PT):**
- ADR-0047 gate + bootstrap suppression: **deploying** (incident fix; PR #73 merged as ADR/amendments — build landing). All surfaces seed `pilot` by construction.
- Restore drill (P1-3): **DONE — PASS 2026-07-06 10:47 UTC** (`docs/operator/restore-drills.md`; latest migration `20260712_ap_approvals`, `bonus_daily_entries=5382`, paid payroll `316275¢` reconciled).
- RESTIC_PASSWORD off-box confirmation (**P1-4**): **STILL OPEN.** This is the last gate in `assertLoadsInventoryActivated` (`src/lib/loads/record-guards.ts`). **Until P1-4 closes, no loads/inventory manager surface and no manager ramp is legal — this is the critical-path blocker for all of Stage 1+.**
- Alert-digest roster (0043): **muted pending gate** — surface is `pilot`, routes to Bill only; the incident's two Eugene findings (`c4_billing_basis`, `m2_missing_snapshot`) auto-resolve with `bootstrap_suppression` provenance once the hotfix lands (do NOT hand-classify them — directive §3.2).
- P14 payroll timeline: **7 AM close-time change** in effect (verify Eugene P13 signature state before the guardrail deploy, mission §6 Phase 0).
- Woodland iPads: **Wednesday 7/9** (Amendment 2, LOCKED).

**ADR-0047 flips this stage:** NONE to `live`. Everything stays `pilot`/admin-only. Stage 0 is about making the foundations TRUE, not ramping audience. Bill reviews pilot digests daily.

**UI-surface build (Stage-0 work, §8):** extend `rollout_state` to `ui_surfaces` rows — Workbench (manager read), loads-inventory events/OR-counts tabs, Terex/equipment tab. All seed `pilot` (admin-only). Small build, per ADR-0047 D5.

**Operator actions (all admin/Bill; none are audience ramps):**
| # | Action | Runbook | Who |
|---|--------|---------|-----|
| 1 | Confirm RESTIC_PASSWORD off-box (**P1-4**), then flip `assertLoadsInventoryActivated` | `docs/operator/restore-drills.md`, `docs/operator/backups.md` | Bill |
| 2 | Seed Woodland operators from Janette's roster (name, locale en/es/ur, processor role) | `/admin/users` (ADR-0017) | Bill |
| 3 | Enable MyMRC ingestion profile → audit's 2nd leg fills (admin-visible only) | `docs/operator/mymrc-ingestion.md` (`docker compose --profile mymrc up -d`) | Bill |
| 4 | Verify first 02:30 PT sweep wrote an `audit_runs` row + Workbench renders real windows; fire one on-demand Woodland run as smoke | `docs/operator/audit-workbench.md` | Bill |
| 5 | Retro-import June (+May if handy) Woodland daily-log workbook (staging-only — feeds retro-audit + variance last-billed leg) | `/admin/audit/workbook` — `docs/operator/audit-workbench.md` | Bill |
| 6 | Enter June Woodland physical snapshot **4,062 Pool-A** as inventory anchor (see Part 2) | `/dashboard/woodland/loads-inventory` — `docs/operator/loads-inventory-foundations.md` | Bill |
| 7 | Align Woodland **DR3# counter** to Janette's last-issued+1 (currently safe-high 5000; ask Janette) | `docs/operator/events-and-sequences.md` | Bill + Janette |
| 8 | Rick populates `account_haul_rates` + `container_rental_sites` (+ confirm June $10,800 vs July $10,500 rentals, B10-7); seed CA transport tiers | `/admin/billing-rates` — `docs/operator/billing-rates.md` | Rick (`can_manage_rates`) |
| 9 | Send **E0** (all-staff map of what's coming) + **E-Rick** (§7 bootstrap-artifact note) | Part 3 | Bill |

**WHO is affected:** admins/Bill only see any new surface. Rick does data entry under `can_manage_rates` (not a workflow ramp). Staff receive E0 (informational). No operator touches Vision yet.

**Exit criteria (verbatim, §8):** "2 consecutive pilot digests with zero bootstrap noise; ops gates closed; DR3# verified; MyMRC sync green ≥3 consecutive runs."

**Rollback:** N/A (no live flips). If a foundation is wrong, fix in place; nothing is staff-visible to retract.

---

### Stage 1 — wk of 7/13: capture layer, Woodland only

*(Note: Woodland iPad go-live is Wednesday 7/9 per Amendment 2 — the physical cutover happens at the top of this window; Janette's manager flips follow once the operator flow is proven.)*

**ADR-0047 flips (Woodland only):**
| Surface | Type | pilot → live | Audience unlocked |
|---|---|---|---|
| Operator inbound flow (iPad) | capture (activation, not audience) | activated 7/9 | Woodland operators — exactly ONE surface |
| Schedule-a-load | `ui_surfaces` | live @ Woodland | Janette |
| Inbound verify gate | `ui_surfaces` | live @ Woodland | Janette |
| Daily close (processed units + categories) | `ui_surfaces` | live @ Woodland | Janette |

**NOT flipped this stage:** Workbench, alert digest, Terex, invoices/COR — all stay `pilot`/admin-only for Woodland.

**Operator actions:**
- Wed 7/9: one supervised test load **including the offline ride-out** (wifi off mid-load → complete → sync verify), then straight cutover per locked decision. Runbook: mission §8, `docs/operator/loads-inventory-foundations.md`.
- Janette runs Vision daily close **in parallel with her spreadsheet** (she maintains it anyway). Kelsey cross-checks both.
- Send **E1** (Woodland go-live note, + ES translation for operators).

**WHO is affected:** Woodland floor operators (capture only, one surface); Janette (minimum manager set); Kelsey (cross-check). Morena, Rick, Eugene untouched.

**Exit criteria (verbatim, §8):** "3 consecutive clean closes where Vision ties Janette's spreadsheet (or every variance is triaged bug-vs-business-rule and resolved); operator flow needs no floor intervention for 2 consecutive days."

**Rollback:** flip Janette's manager surfaces back to `pilot` (one admin action). Operator flow can revert to the manual "Schedule a load" interim (mission §8) — no paper fallback by design, so a hard operator-flow failure = pause cutover, not a paper day.

---

### Stage 2 — wk of 7/20: Eugene capture + Workbench to managers

**ADR-0047 flips:**
| Surface | Type | Flip | Audience |
|---|---|---|---|
| Operator inbound flow | capture | activate @ Eugene | Eugene operators |
| Schedule-a-load / verify / daily close | `ui_surfaces` | live @ Eugene | Rick (minimum manager set, mirrors Janette's) |
| Workbench (manager read) | `ui_surfaces` | live @ Woodland | Janette, Morena (READ); **Kelsey primary audit tool** |
| Terex/equipment **capture** | `ui_surfaces` | live @ Woodland | Morena, Janette (`equipment_events` entry only) |

**NOT flipped:** alert **digest emails** stay `pilot` (Workbench is in-app read only); Terex **trend views** stay admin-only until data exists; invoices/COR stay `pilot`.

**Operator actions:**
- Eugene iPad prep + cutover, same runbook as Woodland (Rick's roster via `/admin/users`; seed OR transport tiers first — see Part 4).
- Kelsey adopts the Workbench as her primary audit tool for the rest of her validation window — **her usage IS the P1 acceptance test.**
- Send **E2** (Eugene go-live + Workbench-read note).

**WHO is affected:** Eugene operators + Rick (capture); Janette + Morena (Workbench read); Kelsey (validation). Digest recipients still get nothing.

**Exit criteria (verbatim, §8):** "Eugene mirrors Stage-1 criteria; Kelsey signs off that Workbench findings match her manual audit for one full week."

**Rollback:** flip Workbench / Eugene manager surfaces / Terex capture back to `pilot`, independently, one action each.

---

### Stage 3 — 7/16 through EOM: money in SHADOW (default; Bill may override)

**ADR-0047 flips:** NONE to staff. Invoice-approval + COR notification surfaces stay `pilot`. This stage exercises the WORKFLOW, not the audience — Rick works inside Vision as a manager/admin; no money leaves the building on Vision's authority.

**Operator actions:**
- Vision generates the mid-month invoice set (~7/16) and EOM set from `processed_units_daily` + `state_program_rules` (ADR-0041; immutable versions, line provenance). Runbook: `docs/operator/invoices.md`.
- **The spreadsheet invoice remains the invoice of record for July.** Rick compares line-by-line (mission §4 parity checklist is the instrument) and exercises the approval workflow on the **shadow** invoices behind the `gateForWindow` trust gate — validating the workflow without it carrying money.
- **July COR** (~8/1): Vision generates (EOM inventory from pool-aware running balance cross-ref the 4,062 physical snapshot; headcount from daily-close; FT/PT entered at review; signer Rick). Rick validates the 4,062-style inventory tie + headcount against his manual count; signs whichever he trusts; variance filed as a finding either way. Runbook: `docs/operator/cor.md`.
- Send **E3** (shadow-billing note to Rick, Mary FYI).

**WHO is affected:** Rick (parity + approval workflow), Mary (FYI). No customer, no MRC group receives a Vision invoice.

**Exit criteria (verbatim, §8 → Vision becomes invoice of record for August):** "mid-month AND EOM parity clean or fully triaged; Rick states — in writing, in the ledger — that he'd have signed the Vision set."

**Rollback:** trivial — nothing is live; shadow invoices are drafts. If parity fails, August cutover (Stage 5) does not start; July stays spreadsheet-of-record with no retraction needed.

---

### Stage 4 — wk of 7/27: staff-facing communications ramp

**ADR-0047 flips (the first EMAIL surfaces to go live):**
| Surface | pilot → live | Audience | Precondition (§8) |
|---|---|---|---|
| 0043 alert digest | live | Morena, Janette (Woodland), Rick (Eugene) | ≥5 consecutive reviewed pilot digests, zero noise, AND ≥1 true finding handled end-to-end in pilot |
| 0045 task-ledger reminders | live | leads | — |
| 0045 contact-intake routing | live | tours → Rick | — |
| 0045 Updates digest | (already no mail path) | Morena sends from Vision's **draft** | Vision never sends; Morena finalizes |

**Operator actions:**
- Confirm the ≥5-pilot-digest / ≥1-true-finding precondition in the audit ledger before the digest flip.
- Set the digest send-time (see Part 4 decision — recommend 07:00 PT).
- Morena begins sending the Updates digest from Vision's draft (`docs/operator/ops-ledger-and-intake.md`).
- Send **E4** (alerts-go-live note, data-entry-vs-operational framing).

**WHO is affected:** Morena, Janette, Rick (digest); leads (reminders); Rick (tour intake); Morena (Updates send). This is the first time Vision emails a non-admin.

**Exit criteria (verbatim, §8):** "one week of live digests with no confused-recipient escalations."

**Rollback:** flip the digest (and/or any 0045 surface) back to `pilot` → routes to Bill only again, one action. Confused-recipient escalation = immediate flip-back per standing rule 3.

---

### Stage 5 — 8/1: cutover

**ADR-0047 flips:**
| Surface | Flip | Audience |
|---|---|---|
| Invoice generation | live (invoice of record) | August invoices native |
| Terex trend views | live | Morena, Janette |
| Remaining P4/P5 audiences | live | per surface |

**Operator actions:**
- Vision becomes **system of record**: August invoices native.
- **Woodland daily-log spreadsheet retired after July EOM parity passes** (Stage 3 exit). Eugene's spreadsheet retires after its own EOM cycle — NOT on the 8/1 calendar date, on Eugene's parity.
- **ADR-0046 AP mailbox ramps INDEPENDENTLY of 8/1** — born `pilot` when built; goes live when SVdP IT consent lands (shared mailbox `approvals-dr3@svdp.us` + Graph app + tenant consent + ApplicationAccessPolicy) AND Bill validates the first real quarantine/request cycle. If IT lags, interim = accounting emails Morena/Janette directly (pre-Vision workflow, new approvers). **The cutover does not wait on Graph consent.** (Addendum C, `docs/operator/ap-approvals.md`.)
- Send **E5** (cutover + thank-you).

**WHO is affected:** everyone — Vision is now the source of truth. Kelsey's window has closed; acceptance falls to parity artifacts + retro-audit from here.

**Exit criteria:** this is the terminal stage. Success = August invoices native + spreadsheets retired on parity + no regression to `pilot` triggered.

**Rollback:** per surface, flip to `pilot`. Invoice-of-record rollback is heavier (a live invoice was issued) — supersede-to-correct via a new immutable version (`docs/operator/invoices.md`), not an edit.

---

## PART 2 — Data prepopulation matrix

**Bill's ask: "all the old data prepopulated in that component as we make them live."** The central architectural fact governing this: **the ADR-0039 workbook-import surface is STAGING-ONLY.** Per ADR-0039 D4 (verbatim): *"a parser maps the §4 tab structure into staging rows tagged `import_id` (never into operational tables)."* It feeds the retro-audit comparators (C4 billing-basis, C6 continuity) and the variance report's last-billed leg — it does **NOT** populate `processed_units_daily`, the running balance, or any operational table. This is by design (clean-replay invariant, ADR-0035). It shapes every row below and drives the Part-4 backfill decision.

| Surface | What historical data loads | From where | Mechanism | When (stage) | Owner |
|---|---|---|---|---|---|
| **Audit Workbench + variance + retro-audit** | June (+May if available) Woodland daily-log workbook | Janette's monthly `.xlsx/.xlsm` | `/admin/audit/workbook` upload → **staging rows** (`import_id`), original to R2. Feeds C1–C7 legs + last-billed variance leg. Tolerates ≥3 template generations. | **Stage 0** | Bill |
| **MyMRC mirrors** | Historical Hauls/Processed/Outbound feeds | MyMRC Salesforce portal | Enable `mymrc` profile → continuous pull. **List depth is discovery-dependent** (ADR-0038 D6): actual backfill = whatever the portal's lists retain; historical checks degrade gracefully to 2-leg (workbook↔summary) where mirrors have no history. Not a fixed window. | **Stage 0** | Bill |
| **Inventory anchor** | June Woodland **4,062 Pool-A** | June physical count | Enter as a `site_inventory_snapshots` **physical** row (`snapshot_kind=physical`) — becomes the anchor; running balance computes forward from it. This is what makes the running balance and the July COR §7(b) tie MEAN anything. | **Stage 0** (after P1-4) | Bill |
| **Equipment / Terex** | Janette's Terex side-spreadsheet | Legacy Excel | **NO importer exists** (ADR-0044 — manual entry only via `equipment_events`). See Part 4 decision: manual key of recent months vs fresh-forward. | Stage 2 (capture) / decision | Morena/Janette |
| **Rates** | `account_haul_rates`, `container_rental_sites`, transport tiers | Rick's confirmed current values / workbook variables sheet | Manual entry `/admin/billing-rates`. CA tiers seeded; **OR tiers unseeded → typed error until Rick enters them** (blocks Eugene invoices, Stage 3). | **Stage 0** (CA) / pre-Stage-2 (OR) | Rick |
| **Bonus / payroll** | Jan 2025 → June 2026 | ADR-0023 one-shot seed | **DONE** — 5,158 daily entries, 94 processors, $113,776.00, 104 pay periods (76 historical_imported), 76/76 PDFs to R2. Live + historical. No action. | complete | — |
| **Invoices** | July data | `processed_units_daily` + rules | Not a separate import — July invoices generate from **operational** data captured from go-live forward. "Prepopulation" for the audit/variance context = the workbook staging imports above. | Stage 3 | Rick |
| **COR** | June anchor + July daily closes | running balance + snapshot + daily-close | Derives from the 4,062 physical snapshot (anchor) + operational closes. No separate import. | Stage 3 (~8/1) | Rick |

### The `processed_units_daily` backfill gap (surface this to Bill — Part 4 decision #1)

Because workbook import is **staging-only**, June's day-by-day operational closes do **not** exist in `processed_units_daily`. Consequences:
- **COR §7(b) 4,062 tie: SATISFIED anchor-forward** — the physical snapshot anchor reproduces 4,062 at June close; the running balance rolls forward from it. No operational backfill needed for the COR.
- **Retro-audit / historical money-drop check: SATISFIED** — that is exactly what the staging import + C4/C6 comparators are for.
- **NOT satisfied without a decision:** equipment throughput **trends** (derived from `processed_units_daily`) and day-over-day running-balance **continuity checks (C6)** have no June operational data. They start empty at go-live and accumulate forward.

This is the honest tradeoff: **anchor-forward-only** (recommended) vs **build a one-time guarded June-close operational backfill**. See Part 4 #1.

---

## PART 3 — Communication plan + draft emails

**Voice & conventions:** plain, warm, operator-to-operator, in Bill's voice. Sender `dr3-vision@svdp.us` (M365 Graph, `sendSystemEmail`) or Bill's own account as noted. SVdP branding rules apply (DR3 green/black mark, not SVdP red; no marketing tone). **Operator-facing emails (E1, and the operator-relevant portions of E4) should ship with an ES translation** — the operator surfaces are localized en/es/ur; the people entering data read Spanish first. Placeholders `[…]` mark true unknowns only.

---

### E0 — All-staff: "the map of what's coming" (Stage 0)
- **Send:** this week — **recommend Tuesday 7/7 AM PT** (after operator seeding lands, 2 days before Woodland go-live). See Part 4 #3.
- **Sender:** Bill · **To:** all DR3/MRC staff (Janette, Rick, Morena, Kelsey, Mary, Bethany, Shannon, Patrick, Juan, floor leads)
- **Subject:** DR3 Vision is going live — here's the plan, and here's what won't change yet

> Team —
>
> Over the next few weeks we're switching on DR3 Vision, the system that's been quietly built to take the mountain of spreadsheets, re-typing, and cross-checking off your plates. I want you to know exactly what's coming and when, so nothing lands as a surprise.
>
> **How we're doing it:** one thing at a time, one site at a time, and nothing goes live for anyone until the step before it has proven itself. If anything looks off, we flip it back the same minute — no drama.
>
> **What you'll see, and when:**
> - **Woodland floor (this week):** the iPad inbound flow. You'll scan and confirm loads instead of paper. We'll walk one load together first.
> - **Janette (next week):** scheduling and daily close in Vision, running alongside your spreadsheet until they match.
> - **Eugene (~wk of 7/20):** same iPad flow, Rick's crew.
> - **Rick (mid/late July):** billing and the certificate generate in Vision — but July stays on the current spreadsheet as the official invoice. We're checking, not switching.
> - **Alerts (late July):** a short daily "here's what needs a look" email — only after we've proven it's quiet and accurate.
>
> **What is NOT changing yet:** your paychecks, your current invoices, and how MRC gets billed for July. Bonuses already run through Vision and are unchanged.
>
> **Questions?** Ask me directly. This is built for the people entering the data first.
>
> — Bill

*(≈235 words)*

---

### E-Rick — bootstrap-artifact note (§7) — **send TODAY, Mon 7/6**
- **Send:** today (Mon 7/6 evening PT) · **Sender:** Bill (personal, not the system) · **To:** Rick Albritton
- **Subject:** Those two flags this morning — startup noise, your numbers are fine

> Rick — quick note on the two flags the new audit emailed you this morning. They were startup artifacts: the system was comparing Eugene against billing and inventory records that don't exist yet (your first Vision invoice isn't until mid-July, and no physical snapshot has been entered into a week-old feature). Your numbers are fine — nothing's wrong on your end. I've turned off staff emails from the audit until it's been validated, so you won't get another until it's earned your trust. That's the whole point — when it does flag something, it'll be real. Thanks for flagging it to me. — Bill

*(≈110 words — the §7 "two-line" note, drafted verbatim-ready)*

---

### E1 — Woodland go-live day (Stage 1)
- **Send:** morning of Wed 7/9 · **Sender:** Bill · **To:** Janette · **Cc:** Morena, Kelsey · **+ ES translation for operators/floor leads**
- **Subject:** Woodland iPads go live today — here's the flow

> Janette —
>
> Today's the day for the Woodland floor. Here's the shape of it:
>
> **Operators:** each inbound load gets scanned and confirmed on the iPad — units, program vs non-program at the verify step. That's their one new thing today, nothing else. We'll do one supervised load together first, including a test where I switch the wifi off mid-load to prove it still saves and syncs. No paper — the iPad is the record now.
>
> **You:** you're live on the minimum set — Schedule-a-load, the verify gate, and daily close (processed units + categories). **Please keep running your spreadsheet in parallel** — you'd keep it anyway, and Kelsey will cross-check both until Vision ties out three clean closes in a row. Not the Workbench, alerts, or Terex yet — those come later.
>
> **If anything's off on the floor:** tell me, and we hold. We don't push through a bad flow.
>
> The whole system was built for the people doing the entry first — so if a step feels clunky, that's a bug to me, not a you-problem. Say so.
>
> — Bill
>
> *(Spanish translation follows for the floor.)*

*(≈220 words)*

---

### E2 — Eugene go-live + Workbench read (Stage 2)
- **Send:** start of wk 7/20 (confirm Eugene date — Part 4 #4) · **Sender:** Bill · **To:** Rick, Janette, Morena, Kelsey
- **Subject:** Eugene goes live this week + managers get the audit view

> Team —
>
> Two things this week:
>
> **Eugene (Rick's crew):** the same iPad inbound flow Woodland's been running goes live. Lighter volume, so a smaller lift — same one-supervised-load-first, same offline test. Rick goes live on the same minimum manager set Janette has.
>
> **Woodland managers — the Audit Workbench opens (read):** Janette and Morena, you'll now see the 3-way reconciliation in-app — where Vision, MyMRC, and the logs agree or disagree, with the provenance on every number. The alert **emails** are still off; this is you looking when you want to, not getting pinged.
>
> **Kelsey:** this is the one. From here to 8/1, the Workbench is your primary audit tool — your week of it matching your manual audit is our acceptance test for the whole thing. If it disagrees with you, that's the most valuable bug you can hand us.
>
> Terex entry also opens for Morena and Janette this week (logging only — the trend charts stay dark until there's data behind them).
>
> — Bill

*(≈190 words)*

---

### E3 — Shadow-billing (Stage 3)
- **Send:** ~7/16 (mid-month set generates) · **Sender:** Bill · **To:** Rick · **Cc:** Mary (FYI), Kelsey
- **Subject:** July billing in Vision — shadow month, spreadsheet stays official

> Rick —
>
> Vision is now generating the MRC invoice set — mid-month today, EOM at month end — straight from the daily-close data and the rate tables you loaded. **This is a shadow month: your spreadsheet invoice is still the official one that goes out.** We are not billing MRC off Vision in July.
>
> What I'm asking:
> 1. Compare the Vision set against yours line-by-line — the parity checklist is the instrument. Every difference is either a bug we fix or a business rule we encode; either way it gets written down.
> 2. Run the approval workflow on the Vision invoices anyway — click through it as if it were real. That validates the workflow without it carrying money, and it's gated on the audit being clean, so you're testing the trust gate too.
> 3. The July COR generates around 8/1 — check the inventory tie (the 4,062-style number) and headcount against your manual count, sign whichever you trust, and we file the variance either way.
>
> The bar for Vision to become the official invoice in August is simple: parity is clean or fully explained, and you tell me — in writing — you'd have signed the Vision set.
>
> Mary — FYI only, nothing changes on your end for July.
>
> — Bill

*(≈235 words)*

---

### E4 — Alerts go live (Stage 4)
- **Send:** start of wk 7/27, at digest go-live · **Sender:** Bill · **To:** Morena, Janette, Rick · **+ ES note for operator-facing framing**
- **Subject:** The daily audit digest is now live — how to read it

> Team —
>
> Starting today you'll get a short daily email from Vision — the audit digest — but only because it's earned it: five-plus quiet days in a row and one real issue caught and closed while it was still in testing.
>
> **What it is:** one email, [07:00 PT], only on days there's something to look at. No email = nothing needs you.
>
> **What a "finding" means:** the system found a number that doesn't reconcile across the daily logs, MyMRC, and billing. Every finding tells you **where the number came from, who entered it, when, and what changed** — and it separates two very different things:
> - a **data-entry** issue (entered under the wrong date, a typo, a load not scheduled) — a quick fix, and
> - a **real operational** issue (a late load, a hold, low production because no inbound material came in).
>
> That second distinction matters to me: low production because there was nothing to process is **not** an underperforming team, and the digest is built to say so. When you note the cause on a finding, you're writing the record.
>
> If a digest ever confuses you about who it's for, tell me — that's my signal to pull it back and fix the framing.
>
> — Bill

*(≈235 words)*

---

### E5 — Cutover (Stage 5)
- **Send:** 8/1 · **Sender:** Bill · **To:** all DR3/MRC staff
- **Subject:** Vision is now the system of record — and thank you

> Team —
>
> As of today, DR3 Vision is our system of record. August MRC invoices are generated natively in Vision. Woodland's daily-log spreadsheet is retired now that July's numbers tied out; Eugene's retires after its own month-end check. The Terex trend views are on, and the last of the manager reports are live.
>
> A couple of things still ramp on their own clock, not this date: the accounting approvals mailbox goes live when SVdP IT finishes the setup — until then, accounting emails Morena and Janette directly, same as before, just with the new approvers. Nothing waits on it.
>
> I want to name what this took. This was built from **your** words — the survey answers, the "here's what actually breaks" notes, the walkthroughs. Enter once, use everywhere; every number carries where it came from; explain, don't just flag — those were your asks, and they're the spine of the thing.
>
> Special thanks to Kelsey, whose validation work these past weeks is the reason we can trust it, and to Janette, Rick, and Morena for running everything twice while we proved it out.
>
> Same as always: if something's clunky, that's a bug — tell me.
>
> — Bill

*(≈205 words)*

---

## PART 4 — Decisions for Bill (each with a recommendation)

**1. June-close operational backfill vs anchor-forward-only.**
Workbook import is staging-only (ADR-0039 D4), so June's operational closes aren't in `processed_units_daily`. Equipment trends and C6 day-over-day continuity therefore start empty at go-live.
- **Option A — anchor-forward-only (RECOMMENDED):** enter the 4,062 June physical snapshot as the anchor; run the balance forward. COR §7(b) tie and retro-audit are already satisfied (snapshot + staging import). Equipment trends accumulate from go-live. Zero build; no risk of reconstructed data leaking into operational tables that feed invoices; preserves the clean-replay invariant.
- **Option B — one-time guarded June-close operational backfill:** build a bounded importer that writes June daily closes into `processed_units_daily`. Gives June-July trend/continuity continuity, but is net-new build during go-live week, and risks double-count / clean-replay violations if that data ever reaches invoice generation.
- **Recommendation: A.** Revisit only if Bill specifically wants June equipment-trend continuity badly enough to justify the build and the guardrails — Janette keeps her spreadsheet through July anyway, so the trend gap is cosmetic short-term.

**2. Terex history import vs manual.**
No importer exists (ADR-0044 — manual `equipment_events` only). Janette's side-spreadsheet is small.
- **Recommendation: manual, no importer.** When the Terex tab flips (Stage 2), have the office key the last **1–2 months** of downtime/repair/cost events manually so the trend view has some context at Stage-5 go-live; everything older stays in Janette's spreadsheet as archive. Building a CSV import for one small side-sheet isn't worth the spend. If Bill wants deeper history, that's a small P4 follow-up, not go-live work.

**3. E0 send day.**
- **Recommendation: Tuesday 7/7 AM PT** — after operator seeding + rate entry land (so the email is true), and 2 days ahead of the Woodland 7/9 go-live (enough notice, not so early it's forgotten). Alternative: Mon 7/6 evening if Bill wants it out with the Rick note tonight.

**4. Eugene target week — confirm.**
§8, the forward handoff, and the mission all say "wk of 7/20," but Amendment 2 says "Eugene follow-on date not yet stated." E2 carries a placeholder.
- **Recommendation: confirm wk of 7/20** (specifically, cutover day) so E2's timing and the Kelsey-window math (she's gone 8/1) are locked. Eugene needs OR transport tiers seeded first (Rick, decision-adjacent to #5 rates).

**5. Digest send-time: 18:00 → 07:00 PT.**
The digest currently rides the daily-report cron at each site's `send_time_pt` = 18:00 PT. The audit sweep runs 02:30 PT.
- **Recommendation: move to 07:00 PT.** Overnight findings then land first thing and are actionable that same business day; an 18:00 send is read the next morning anyway. Aligns with the fleet quiet-hours/morning-digest posture. Trivial config, no redeploy. Set before the Stage-4 flip.

**6. (Found open) RESTIC_PASSWORD / P1-4 — not a decision, a blocking action.**
P1-4 (off-box backup-key confirmation) is the **last gate** in `assertLoadsInventoryActivated` and blocks every manager ramp from Stage 1 on. Restore drill (P1-3) is DONE; P1-4 is not confirmed in the runbook.
- **Action, not choice: confirm RESTIC_PASSWORD off-box in Stage 0 before 7/9.** Flagging here because it is the single hard dependency the whole calendar sits on.

**7. (Found open) COR signer title "TBC with MRC."**
`cor_signer_title` reads "Transportation Manager" (June COR); flagged TBC (`docs/QUESTIONS.md` Q-5). Not go-live-blocking (Vision pre-fills, human signs), but the July shadow COR (Stage 3) will render whatever's in config.
- **Recommendation: confirm the title with MRC during Rick's Stage-3 COR validation**, since he's reviewing it anyway.

---

*End of plan. Rollback for any stage is one admin flip to `pilot` — no code, no deploy. No stage starts before the prior stage's exit criteria are met. Protect Kelsey's window (ends 8/1).*
