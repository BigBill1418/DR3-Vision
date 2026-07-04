> **⚠ PARTIALLY SUPERSEDED (2026-07-04, same day):** §1's "0041 PROPOSED / 0042 not
> drafted" and §2-1/§3-1/§3-2 are DONE — ADR-0041 was walked through D1–D6, accepted,
> and BUILT (PRs #57 capture + #58 engine, both merged); ADR-0042 was drafted,
> accepted (PR #56), and its build is in flight. Do not re-review or rebuild them.
> Current state lives in docs/adr/README.md + CHANGELOG. The ops lane (§4), go-live
> week (§5), and Kelsey capture (§6) remain the live marching order.

# ADR-0036 Mission — Forward Handoff: P1 Complete, P2 Gated on 0041, Go-Live Week

**Date:** 2026-07-03 (evening) · **Supersedes as marching order:** none — extends the mission record + Addenda A/B · **State verified against:** main @ sync 2026-07-03T21:15Z

## 1. Where we actually are (verified, not planned)

| Piece | State |
|---|---|
| Mission record + Addendum A + Addendum B | Merged, actively traced by ADRs |
| ADR-0037 loads/inventory foundations | **Accepted + BUILT** — schema, Addendum-B-shaped taxonomy, rate seeds, verify gate, running balance, daily close, manager/admin surfaces; hardened same-day (loud logging, no-blind-default verify, negative-balance guard, ambiguous-rate error, N+1 kills) |
| ADR-0038 MyMRC ingestion rebuild | **Accepted + BUILT** — Aura/JSON transport, mirror tables, run ledger, deadman, live-captured fixtures; green-run-with-no-data impossible by construction. Compose service `mymrc-scrape` **profile-gated — enabling is an operator action** |
| ADR-0039 3-way audit + Workbench + retro-audit | **Accepted + BUILT + INTEGRATED** — C1–C7 comparators on live legs, nightly 02:30 PT sweep + on-demand run, findings lifecycle, workbook import (3 template generations), Workbench live, billing trust gate ready for P2 |
| ADR-0040 billing rate infrastructure | **Accepted + BUILT** — tier table seeded, freight resolver, fuel + EIA Tuesday cron, `can_manage_rates`, variance report at `/dashboard/billing-variance` (last-billed leg honest-empty until retro-audit staging feeds it) |
| ADR-0041 invoice generation | **PROPOSED — the pipeline gate. Awaiting Bill's review** (D1–D6) |
| ADR-0042 COR generator | Not yet drafted — next in series after 0041 |
| Survey `dr3-intel-2026-06` | 8/10 · Mary outstanding (daily auto-reminders live) · **auto-close armed on her submission** · export is a manual admin button post-close |
| ADR numbering | **Ruling: leave as-is.** `docs/adr/0036` = survey reminders/auto-close (separate session took it legitimately). The mission record is a handoff, referenced by path. Next free ADR number: **0042** |

## 2. Bill — decision/review lane (ordered)

1. **Review ADR-0041** (`docs/adr/0041-invoice-generation.md`, D1–D6). This is the only thing blocking P2 build. Note one input it depends on: **B10-5 commodity→invoice-block mapping** (esp. shoddy↔Biomass, trash→Landfill-vs-WTE destination logic) — get the answer from Kelsey/Janette during review so 0041's rendering layer isn't built on a guess.
2. **Mary**: reminders are automated; if still unopened Monday morning, call/text (channel switch per wrap-up doc). On auto-close ntfy → admin **Export** → merge the export PR.
3. **Renegotiation prep** (interim MRC seat): variance report exists; it becomes fully armed once (a) Rick populates current rates and (b) one historical workbook is retro-imported (last-billed leg). Then the tier-jump exhibit is a CSV click.
4. **VBA** (B10-1): Alt+F11 in the daily log, paste modules (or "none") — last unread artifact; determines whether any freight/consolidation logic exists only in macros.

## 3. Claude Code — build lane (after 0041 approval)

1. **Build 0041** per accepted text: immutable invoice versions w/ line provenance, §3.1 math (all inputs now data), minimal `collection_events` capture, **Rick's approval flow behind the ADR-0039 billing trust gate** (`gateForWindow`), parity acceptance per mission §4 checklist, standing observability directive.
2. **Draft ADR-0042 — COR generator** (mission §5 + Addendum B §B4): month, EOM unprocessed inventory from pool-aware balance/snapshot (June Woodland anchor 4,062), FT/PT headcount from daily-close fields, signer block = Rick (title TBC w/ MRC), human signs — Vision never auto-certifies. Propose → Bill review → build.
3. **Then P3** (alerts: recovery rate incl. renovation channel, missing records, thresholds in `audit_check_config` pattern) — much of the plumbing now exists in 0039's findings/config model; propose as a thin ADR.
4. Carry-forwards inside builds: `saved_units` semantics (B10-2) still excluded from balance pending answer; DR3#/Material# sequence issuance (B10-6 — survey answered semantics: Woodland manual/typo-prone → **Vision assigns**; Eugene scan-timestamp; Material # is MyMRC-owned at EOD, never pre-filled) — schedule the sequence-issuance slice with 0041 or 0042, whichever touches load entry first.

## 4. Ops lane (deploy/enable — operator session or Bill)

1. **Enable MyMRC ingestion**: per `docs/operator/mymrc-ingestion.md` (profile-gated compose service). First runs populate mirrors → the audit's second leg goes live → deadman starts mattering.
2. **Verify first nightly sweep** (02:30 PT) wrote an `audit_runs` row and the Workbench renders real windows; fire one on-demand run for Woodland as smoke.
3. **ADR-0037 D7 activation gate**: manager audience for the new loads/inventory surfaces stays admin-only until the **restore-drill + off-box-backup** ops gates close. Close them — that's the last P0-era readiness debt, and Kelsey's validation window works best with Janette's manager view open.
4. **Retro-audit seeding**: upload the June daily-log workbook (and May if handy) via workbook import — quantifies the DAY6 roll-break class + Friday→Monday defect (Janette Q11) and feeds the variance report's last-billed leg.
5. **Rick data entry**: populate `account_haul_rates` + `container_rental_sites` from confirmed current values (seeded empty by design); confirm June $10,800 vs July $10,500 rentals (B10-7) while in there.

## 5. Go-live week (ops, Bill + Janette + Rick + Kelsey)

- **Fri 7/4:** holiday — nothing scheduled.
- **Mon 7/6:** Janette's roster (name, locale en/es/ur, processor role) → Bill seeds operators via `/admin/users`. Mary's phone call if unopened. Likely auto-close + export + merge day.
- **Tue 7/7:** iPad physical prep — mounts, PWA install, per-device iPadOS language, cellular check. Janette's morning "Schedule a load" procedure walkthrough (manual until mymrc profile is enabled and trusted).
- **Wed–Thu 7/8–9:** **Woodland go-live.** One supervised test load incl. the offline ride-out (wifi off mid-load → complete → sync verify), then straight cutover per locked decision.
- **7/9 → 8/1: Kelsey validation window = P1 acceptance.** She audits Vision inbound + the live Workbench against her manual process; every discrepancy triaged bug vs business rule. Her remaining capture items (§6) get worked in parallel. Eugene follows ~week of 7/20.

## 6. Kelsey capture — remaining (was 9 items, now 6)

Resolved since: freight tiers (B2), fuel formula (B3 + Rick Q6), mid-month cutoff (Rick Q2), DR3#/Material# semantics (survey §C), Re-TRAC ID = MyMRC haul/materials number (Kelsey Q3), OR fee $17.00 locked through 2027 then CPI (Kelsey Q2/Rick Q10).
**Remaining:** (1) `%` column on Steel/Biomass/WTE; (2) commodity→invoice-block mapping (feeds 0041 — priority); (3) `saved_units` semantics; (4) DAY6 `×5` quirk; (5) `event units` validity as inbound type; (6) MRC contact map + Re-TRAC/CalRecycle filing mechanics walkthrough (CalRecycle spec already advanced via her Q6: inbound unit numbers + outbound commodity weights, 2026 filing covers Woodland AND the closing CA site). GP integration path arrives with Mary's packet (backstop: Kelsey/Mary/controller call).

## 7. Open register (unchanged owners unless noted)

MRC point person: **Bill interim** · accounting liaison: TBD · licenses/renewals owner: TBD — **revisit alongside Kelsey's compliance-evidence ledger** (survey §D5, broader than licenses; one decision, one owner) · dispatch inbox: TBD — now overlaps Morena's dispatch↔Outlook integration ask (survey §D2, real scope, own decision) · payment-confirmation depth: define later · new survey scope parked: trailer/yard list (P4/P5), downtime+safety records (P4 Terex absorbs downtime), processor bonus-standing view (**post-P1 quick win — recommend Bill green-light early, cheap morale**), Bethany board-pack cadence (2nd Wednesday + preceding Monday — P5 digest requirement).

**Definition of done for this phase remains mission §7:** Kelsey signs off on the overlap window; July COR generates from the snapshot; parity checklist validates against her parallel July workbook; retro-audit reproduces known findings.
