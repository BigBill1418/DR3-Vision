# Personnel Wiring — Daven Stetson: AP Approver + Commodity Payment Reconciliation (ADR-0049 directive)

**Date:** 2026-07-07 · **Ordered by:** Bill · **Person:** Daven Stetson, `daven.stetson@svdp.us` — handles commodities, both sites.

## 1. Roles (locked by Bill)

1. **AP approver** — joins the ADR-0046 approver roster alongside Morena and Janette (first-action-wins accommodates N approvers natively; roster is data per 0046 C5). He is included when the AP surface ramps; it is currently `pilot` + gated on IT consent, so this is roster membership now, live traffic later.
2. **Commodity payment reconciliation owner** — inherits the parked open-register function ("audit MyMRC/billing data against buyer invoices; confirm payment on every commodity load", ex-Kelsey). **This resolves the 'payment-confirmation depth: define later' register item.** Build scope below as **ADR-0049**.
3. Site scope: **both sites** (all-sites visibility flag, same mechanism as Kelsey's).

Explicit non-role: Daven is NOT on the MRC invoice approval gate — Rick's billing trust gate is unchanged.

## 2. Account provisioning (Bill, admin-only per ADR-0017)

`/admin/users` → create manager-class account, `daven.stetson@svdp.us` (M365 SSO), all-sites visibility, no processor role, no bonus-chain involvement. Audit row per house pattern.

## 3. UI surface access — rides the §8 staging, no special-casing

Daven's visibility follows the same per-site flips as every manager: outbound-materials/commodities views live where those surfaces are live; Workbench READ arrives for him when it flips per site (Woodland at Stage 2, Eugene when flipped); the ADR-0049 reconciliation view (below) is born `pilot` per ADR-0047 and ramps by Bill's flip after validation. **No surface is flipped live for Daven ahead of its stage.**

## 4. ADR-0049 — Commodity Payment Reconciliation (build directive, v1 deliberately modest)

**Problem:** outbound commodity loads (metal, foam, wood, etc., both sites) are sold to buyers (SA Recycling, Miller Waste Mills, …); nothing tracks whether each load was invoiced and paid. Kelsey did this by hand; it lapsed unowned at her transition.

**v1 scope:**
- `outbound_materials` gains a payment-tracking companion (separate table, FK per load — do not widen the operational capture row): buyer invoice/reference #, expected amount (optional), payment-received date, status `awaiting_invoice → invoiced → paid` (+ `disputed`), notes. **Manual entry by Daven at v1 — no bank feed, no OCR.**
- A Daven-facing view: commodity loads by payment status, both sites, with **aging** (days since ship; days since invoiced) and CSV export.
- **Audit integration:** one new check on the ADR-0039 engine — unpaid/uninvoiced beyond threshold (config, propose 30/45 days) emits a finding through the standard lifecycle. Born under leg-liveness bootstrap gating like every missing-counterpart check; notification rides the 0043 digest, which is `pilot` — no new email path.
- Decimal boundary rules at every money edge; provenance on every status change (who/when); statuses append-only in audit log.
- **Out of scope v1:** remittance parsing, buyer portals, price-per-lb validation against contracts (candidate v2 once Daven's used it a month).

**D-items for Bill at ADR review:** D1 aging thresholds (30/45 proposed) · D2 whether expected-amount is required at `invoiced` (optional proposed) · D3 whether the aging check emits per-load findings or one rolled-up finding per buyer (per-buyer rollup proposed — less noise).

## 5. Comms (§9.1 — wiring a person is a flip-like event; pair it with its comm)

Add Daven to the **E0 all-staff roster** before E0 sends. Onboarding note (send when Bill seeds the account — drafted, Bill's voice):

> Daven — you're set up in DR3 Vision as of today. Two things are yours in it: (1) when the accounting-approvals mailbox goes live, vendor invoice requests will come to you, Morena, and Janette — first to act wins, everything audited; (2) commodity payment tracking — every outbound load you ship will have a payment status you own, so nothing we sell goes unpaid without us seeing it age. Access lights up in stages along with everyone else's — you'll get a note from me each time something new turns on, never a surprise. Questions, grab me. — Bill

## 6. Sequencing

Account seeding + E0 roster: **now** (Stage-0 compatible). ADR-0049 draft → Bill review → build: after the incident-fix deploy confirms; it does NOT preempt Stage-1 go-live work. AP roster membership: data change now, traffic when 0046 ramps. Reconciliation view ramp: Bill flip after Daven validates it against his own records for one week (§8 discipline).

**Numbering:** next free ADR = **0049**.



---

## 7. CORRECTION — reconciled against production state as of 2026-07-15 (supersedes conflicting statements above)

§§1, 4–6 above were drafted against the early-July design state. Production has moved; the following supersedes:

1. **The AP module is LIVE at both sites** (ap_notify live Woodland + Eugene, audited at `/admin/rollout`). It is NOT pilot and NOT gated on IT consent. Live flow: accounting sends to `approvals-dr3@svdp.us`; new-invoice alerts go to the approver roster; decisions email back to the original SVdP forwarder with Mary Scott CC'd, carrying the stamped original (visible per-page stamp: approver name + Pacific timestamp + optional site tag); Reject requires a note; Hold ("pending review") requires a note and notifies accounting.
2. **Actual live roster Daven joins:** Morena, Rick, Janette, Bill (admin), Kelsey (auto-expires 8/1) — all see all pending, first-action-wins. Daven makes six until 8/1, five after. §1's "alongside Morena and Janette" understated the set.
3. **Consequence for sequencing (§6 superseded):** adding Daven to the roster is **immediate live traffic** — he receives new-invoice alerts from his first day on the roster. Per §9.1 (PR #72), his onboarding note therefore pairs **same-day with the roster addition**, and the §5 draft's phrasing "when the accounting-approvals mailbox goes live" is corrected to present tense: it is live now, and requests will reach him immediately.
4. **ADR numbering (§4/§6 superseded):** 0049–0051 are consumed (0051 = office dark-space theme sweep; 0052 = proposed stewardship-fee AP booking). The commodity-payment-reconciliation ADR takes the **next free number in sequence at draft time** — Claude Code verifies against `docs/adr/` before numbering; do not reuse 0049.
5. **Adjacent open call:** O-9 (make the decision-time site tag REQUIRED so accounting always gets a site for GP filing) is pending. Daven's both-sites scope makes him a natural required-tag user — recommend resolving O-9 alongside his onboarding rather than after.

Corrected onboarding note (replaces §5 draft):

> Daven — you're set up in DR3 Vision as of today, and one thing starts immediately: vendor invoice approval requests from accounting now come to you along with Morena, Rick, Janette, and me — you'll get an email when a new one lands, first to act wins, and every decision is stamped and audited. Take a look at the queue when the first alert arrives; Reject and Hold both ask you for a note, and that note goes back to accounting. Second thing, coming shortly: commodity payment tracking — every outbound load you ship will carry a payment status you own, so nothing we sell goes unpaid without us seeing it age. That one turns on after you've had a chance to check it against your own records. Questions, grab me. — Bill
