# Questions

This file is where Claude Code logs questions encountered during development that the charter and ADRs do not resolve. Bill reviews this file out-of-band.

## Format

```
## Q-N: <one-sentence question>
**Date:** YYYY-MM-DD
**Encountered in:** path/to/file.ts (line N) or "ticket T-NNN"
**Question:** <full question with context>
**Alternatives considered:** <what you weighed>
**Proposed answer:** <what you went with, flagged in code with `// TODO(question-N): see docs/QUESTIONS.md`>
**Resolution:** (filled in by Bill or by Claude on follow-up)
```

## Q-1 — example

**Date:** 2026-05-04
**Encountered in:** N/A — this is the template example
**Question:** Should the operator's PIN entry mask digits as `*` after a brief preview, or always-mask?
**Alternatives considered:** Brief preview (better usability with gloves), always-mask (better shoulder-surf protection)
**Proposed answer:** Brief preview (300ms), then mask. Matches iOS PIN entry UX and is appropriate for the threat model (warehouse floor, not a public terminal).
**Resolution:** Pending Bill review.

## Open questions (Claude Code: append below)

## Q-2: Should the employee-number extraction also write formal audit_logs rows, or is the previous_names provenance entry sufficient?

**Date:** 2026-06-15
**Encountered in:** docs/plans/2026-06-15-bonus-employee-number-extraction.md (§6); prisma/migrations/20260615_bonus_employee_number/migration.sql
**Question:** The migration records each rename in `bonus_employees.previous_names` (reason `employee_number_extracted`). Do we also want an `audit_logs` row per change (ADR-0007/0018) for a queryable, viewer-visible trail? The migration runs without an operator actor, so any audit row would carry a synthetic `system`/`migration` actor that the ADR-0018 viewer may not render cleanly.
**Alternatives considered:** (a) previous_names only — reversible, self-contained, no actor problem [chosen]; (b) previous_names + audit_logs INSERT...SELECT — stronger trail but synthetic actor; (c) audit_logs only — loses the row-level reversible record.
**Proposed answer:** Ship (a). Add (b) only if Bill wants a viewer-visible audit trail and after confirming the audit_logs nullable/synthetic-actor contract.
**Resolution:** Pending Bill review.

<!-- Add new questions above this line. Do not edit resolved questions; preserve the historical record. -->

## Q-3: How should a physical inventory snapshot be split across the program / non-program pools for the running balance?

**Date:** 2026-07-03
**Encountered in:** src/lib/inventory/running-balance.ts (`onHand`) — ADR-0037 D6
**Question:** The pool-aware running balance returns `{ program, nonProgram, total }`, but `site_inventory_snapshots` carries no program/non-program split (only indoor/total/in-processing — outdoor removed per the ADR-0037 addendum, 2026-07-22). The flow records (inbound, processed, renovator, landfilled) all split by pool, but the physical anchor does not. How should the anchor's units be attributed so `program + nonProgram === total` holds?
**Alternatives considered:** (a) attribute the whole anchor to the program pool (most inventory is program; keeps the invariant, non-program reflects only flow since the anchor); (b) add program/non-program columns to `site_inventory_snapshots` now (beyond ADR-0037's additive scope; ADR-0039 loads the historical workbooks that carry the split); (c) return only `total` and defer pools entirely (rejected — the survey amendment requires both derivable).
**Proposed answer:** (a) — the DB adapter attributes the entire physical anchor to the PROGRAM pool (`anchorProgram = total`, `anchorNonProgram = 0`); the pure `computeRunningBalance` stays fully general (accepts an arbitrary per-pool anchor) so the invariant is unit-tested with any split. ADR-0039 can refine the anchor attribution when historical workbook pool data lands. Flagged in the code with a doc comment pointing here.
**Resolution:** Pending Bill review.

## Q-4: Should ADR-0037 be implemented against the accepted ADR text, or re-modeled against mission Addenda A/B?

**Date:** 2026-07-03
**Encountered in:** ADR-0037 build — coordinator relays during implementation
**Question:** Mid-build, coordinator messages proposed progressively larger changes to the D4/D5/D6 data model, culminating in "Addendum B," which would: DROP the `renovator_shipments` table (fold renovation into `outbound_materials.sub_category`), change the `outbound_materials.commodity` taxonomy (daily-log 9: trash/toppers/foam/metal/wood/cardboard/plastic/shoddy/cotton), add `outbound_materials.sub_category`, add a `consumer_dropoffs.kind` enum (incentive/unpaid/illegal), extend `LoadSourceType` with `event`, add `Source.is_non_program`/`is_trans_charge`/`canonical_mileage` + a `source_aliases` table, restructure `processed_units_daily` (stripped_program/stripped_non_program + saved_units + metadata; whole-units-sold/landfilled DERIVED at close), and add more rule seeds incl. effective-dated 2025/2027 CA processing rates. Adopt this model?
**Verification note:** When the first relay (Addendum A) arrived the cited doc was NOT in my checked-out tree or git log, so I declined it as unverified. A later `git fetch origin main` showed Addenda A **and** B were genuinely merged (PR #47, commits `71db954`/`6372ca7`) — REAL ADR-0036 mission addenda, reverse-engineered from the live `JUNE 2026 DAILY LOG WOODLAND.xlsm`, not fabricated. My earlier "does not exist" note was true when checked but is now stale.
**Alternatives considered:** (a) rebuild the data model against Addendum B; (b) deliver ADR-0037 as the user accepted it and surface the addenda for the user to rule on.
**Proposed answer:** (b). Reasons: (1) the direct user instruction was to implement **ADR-0037** (docs/adr/0037, "your requirements document") with an explicit deliverable list that NAMES `renovator_shipments` and the ADR-0037 commodity taxonomy — Addendum B contradicts both; (2) the relays carry no user authority and arrived as a shifting target (A, then B correcting A) mid-build; (3) adopting B is a ground-up data-model rebuild — silently making that product decision on a no-authority relay that conflicts with the written user instruction is exactly what CLAUDE.md forbids; (4) the tree is being left dirty for Bill's review — his review is the right place to decide a re-scope. Implemented ADR-0037-as-accepted plus the two additive, ADR-consistent survey amendments (program/non-program pool splits; captured CA fuel formula), which align with Addendum B's direction and so carry over.
**Recommendation to Bill:** If the Addendum-B model is the intended target (it is workbook-grounded and well-reasoned), commission an **ADR-0037 revision / ADR-0037.1** and the D4/D5/D6 rebuild is a clean single pass — drop `renovator_shipments`, re-enum `outbound_materials` + add `sub_category`, add `source_aliases` + `Source` flags, `consumer_dropoffs.kind`, the daily-close metadata, effective-dated rate seeds. The current core carries straight over: `state_program_rules`, the resolver, the incentive cap, the running-balance engine, the verify gate, and the audit/PII disciplines.
**Resolution:** ANSWERED — **adopt Addendum B (option a)**. Bill (project operator) ruled 2026-07-03 that Addendum B corrects Addendum A's category model and supersedes the conflicting parts of ADR-0037; the P1 implementation was reconciled against it in this build (operator-directed, no further approval needed). Applied exactly as the recommendation above anticipated: `renovator_shipments` dropped (folded into `outbound_materials.sub_category = renovation`); `outbound_materials` commodity taxonomy → the daily-log 9, plus `sub_category` + nullable `whole_units`/`program_units`/`non_program_units`; `consumer_dropoffs.kind` (incentive/unpaid/illegal); `LoadSourceType` + `event`; `Source.is_non_program`/`is_trans_charge`/`canonical_mileage` + `source_aliases`; `processed_units_daily` restructured to `stripped_program`/`stripped_non_program` + `saved_units` (excluded from math) + daily-close metadata, with whole-units-sold + landfilled DERIVED at close; running balance = `End = Start + Inbound − Stripped − WholeUnitsSold − Landfilled` (pool-aware); Addendum B5 rate seeds. The core (resolver, incentive cap, running-balance engine, verify gate, audit/PII disciplines) carried straight over as predicted. The single ADR-0037 migration was regenerated in place (never deployed). Items deliberately left OPEN per Addendum B10: the daily-log-9 → billing-workbook-11 block mapping (B10-5), `saved_units` semantics (B10-2), and DR3#/Material# sequence issuance (B10-6). See ADR-0037 "Post-acceptance revision — Addendum B (2026-07-03)".

## Q-5: What is the correct signer title on the Woodland COR (Exhibit 5)?

**Date:** 2026-07-04
**Encountered in:** ADR-0042 D2.3 (`cor_site_config`, `src/lib/cor/signer.ts`)
**Question:** The COR signer block is standardized from site config, not typed per certificate. The signer is Rick Albritton; the title on the hand-written June COR read "Transportation Manager". Is that the title MRC expects going forward?
**Alternatives considered:** (a) seed "Transportation Manager" (what the June copy read) and flag TBC; (b) leave the title blank until MRC confirms (rejected — a draft could not pre-fill a signer block, and blank is not what June showed); (c) hardcode the title in code (rejected — hard rule that rates/standing facts are DATA, and D2.3 requires "one config edit when confirmed, never a code change").
**Proposed answer:** (a). Seeded `cor_site_config` for Woodland with `signer_name = "Rick Albritton"`, `signer_title = "Transportation Manager"`. The resolver reads the config row (falling back to the same value as a documented default), and the title is DENORMALIZED onto each certificate at generation, so confirming a different title is one row edit and never rewrites a finalized artifact. Config model choice: a simple site-scoped config ROW rather than a `state_program_rules`-style effective-dated table — the signer is a single standing fact per site with no history/effective-dating need.
**Recommendation to Bill / MRC:** Confirm the exact title MRC expects on Exhibit 5. If it differs, edit the one `cor_site_config` row (or reseed) — no code change, no redeploy for the data.
**Resolution:** Pending MRC confirmation.

## Q-0047-1: Should the ADR-0030 daily production report be brought under the rollout gate?

**Date:** 2026-07-07
**Encountered in:** ADR-0047 §4.4 completeness sweep (`src/lib/bonus/daily-report-notifications.ts`)
**Question:** The daily production report emails its configured recipients (managers) via `sendSystemEmail`. It is a staff-facing outbound path that was NOT named in directive §4.4 and NOT in the grandfathered out-of-scope list (signature-chain, survey, Updates). Directive §3 says: any other outbound staff path found → STOP and report, do not guess.
**Alternatives considered:** (a) route it through `notifyStaff()` as a new pilot surface — matches the "structurally impossible" principle but reroutes a long-established, relied-upon production email to admins-only on an incident-night deploy (an operational regression); (b) grandfather it (allowlist) — preserves the working surface, matches how signature-chain/survey were treated; (c) leave it un-allowlisted — fails the repo test, blocks the incident deploy.
**Proposed answer:** (b) — **grandfathered (allowlisted)** for the incident deploy. It is an established production surface, in daily use, and was NOT implicated in the incident (which was the new ADR-0043 audit digest). Grandfathering preserves the status quo; gating it would expand the incident-night blast radius to a working, non-implicated surface. Flagged here for your explicit disposition rather than silently decided.
**Recommendation to Bill:** If the daily production report should also be gated (defensible on the "everything staff-facing is gated" principle), say so and it converts to `notifyStaff()` (register a `daily_production_report` surface, born pilot) in a follow-up — a small, mechanical change, not an incident-night one.
**Resolution:** Pending Bill's disposition.

## Q-0047-2: Should the ADR-0028/0029 amendment lifecycle mail be brought under the rollout gate?

**Date:** 2026-07-07
**Encountered in:** ADR-0047 §4.4 completeness sweep (`src/lib/bonus/amendment-notifications.ts`)
**Question:** The amendment notifications send via `sendSystemEmail` to the approver (admin), Bill (admin), and — on a decided notification — the requester (a manager, i.e. one staff recipient). Not named in §4.4, not grandfathered explicitly.
**Alternatives considered:** (a) gate via `notifyStaff()`; (b) grandfather (allowlist).
**Proposed answer:** (b) — **grandfathered (allowlisted)**. Same reasoning as Q-0047-1: established production bonus subsystem, not incident-implicated, mostly admin/Bill-facing (only the requester on a decided notification is a non-admin). Preserving behavior on the incident deploy is the conservative call.
**Recommendation to Bill:** If you want the requester-facing "decided" notification gated, the cleanest scope is a `bonus_amendment_notify` surface (born pilot) routed through `notifyStaff()`, leaving the admin/Bill ntfy path as-is.
**Resolution:** Pending Bill's disposition.

## Q-0047-3: The AP decision email was routed through `notifyStaff(ap_notify)` — confirm the surface mapping.

**Date:** 2026-07-07
**Encountered in:** ADR-0047 §4.4 completeness sweep (`src/lib/ap/approvals.ts` `sendDecisionEmail`)
**Question:** Directive §4.4 named the AP notify surface as `src/lib/ap/notify.ts` specifically. The AP module ALSO sends a decision email (to Mary's fixed GP-filing recipients) from `ap/approvals.ts`. It is the same dormant AP module (ADR-0046, born pilot).
**Proposed answer:** Routed the decision email through `notifyStaff()` on the **`ap_notify`** surface — treating `ap_notify` as "AP module staff notifications" (new-request + quarantine + decision). This is coherent, born-pilot, and NON-disruptive (the AP module is dormant until IT consent lands). The empty-recipient REFUSE + page guard is preserved (checks the live GP roster before the gated send), so a config gap still pages before ramp.
**Recommendation to Bill:** If AP decision emails should have their OWN surface (separate from `ap_notify`), add an `ap_decision_notify` row and point `sendDecisionEmail` at it — a one-line change. Otherwise `ap_notify` covers the whole AP module and the current mapping stands.
**Resolution:** Pending Bill's confirmation (interim: mapped to `ap_notify`).
