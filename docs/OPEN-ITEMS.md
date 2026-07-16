# Open items register

The single live list of everything HANGING — operator actions, decisions
waiting on Bill or a stakeholder, and accepted-residual code follow-ups.
Started 2026-07-10 (post-stack-sweep, pre-AP-go-live). Any session that
finishes work with a loose end appends it here; any session that closes one
marks it **DONE (date)** and moves it to the bottom section. Sibling docs:
`docs/QUESTIONS.md` (design questions), `docs/handoffs/` (session context),
`CHANGELOG.md` (what shipped).

**Deadline that anchors everything: Kelsey's availability ends 8/1** — Stages
1–3 of the go-live plan (`docs/plans/2026-07-06-staged-golive-activation-and-comms.md`)
are the only window her cross-checks are possible.

---

## 1 — Operator actions (Bill)

| #   | Item | Source | Notes / deadline |
| --- | ---- | ------ | ---------------- |

| O-2 | **Pick a workbook file-fetch method (§7 A/B/C)** | rollup `docs/handoffs/2026-07-09-full-rollup-…` §7 | Blocks all of §8.2 (real-file parser finalization, ADR-0048 D4 promotion, June close-balance 4062 assertion). Recommended: A (rclone + Drive folder), ~5 min setup. **Kelsey window: before 8/1.** |
| O-3 | **RESTIC_PASSWORD off-box confirmation (P1-4)** | go-live plan Stage 0 | Last gate in `assertLoadsInventoryActivated` — critical-path blocker for every manager ramp (Stage 1+). |
| O-4 | **Create Mary Scott's account** when she's ready: role `manager` + `all_sites` + `can_view_billing_verify` | rollup §1.2, PR #92/#93 | Unlocks `/admin/billing/verify` (read-only pre-GP check). |
| O-5 | **Eugene June backfill decision (A/B/C)** | rollup §4.4 | Default assumption is **C — skip** (clean forward-only ledger from Rick's 7/20 iPad go-live). Confirm or override. |
| O-10 | **Five security-audit decision items** (2026-07-16 audit): D1 Next.js auth-layer bump (+D5 CVE clear), D2 session revocation strategy, D3 CSP nonce, D4 verify svdp.us DMARC + sender-header gate | ADR-0053, `docs/security/2026-07-16-full-stack-audit.md` | Each needs Bill's call/deploy window; recommendations + sequencing in ADR-0053. The `[fix]` findings already shipped (PRs #116/#117). |
| O-6 | **Schedule Kelsey walkthroughs (5 items)** | rollup §8.3 / PR #87 §3 | `saved_units` semantics, DAY6 formula-level `×5`, `%` column on Steel/Biomass/WTE, event units as inbound, MRC contact map. **Before 8/1.** |
| O-7 | **Answer: does Mary's outgoing stewardship-fee AP booking warrant a Vision surface?** | rollup §1.6, ADR-0046 note | If yes → draft an ADR (takes the NEXT FREE number at draft time — 0052 went to commodity payment reconciliation; numbers are never reserved). Also clarify which direction the fee flows. |
| O-8 | Remaining Stage-0 runbook rows (operator roster seed, MyMRC profile enable, DR3# counter alignment with Janette, Rick's rate tables, E0/E-Rick comms) | go-live plan Part 1, Stage 0 | See the plan's table for runbook links per row. |

## 2 — Blocked on stakeholders

| #   | Item                                                                                            | Blocked on                           | Notes                                                                        |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| S-1 | ADR-0050 dispatch-integration draft (3 email types + parser signals)                            | Morena's 2–3 example emails per type | She committed to forwarding them (rollup §2).                                |
| S-2 | "Verbal capture" surface for phone/text swap requests (ADR number assigned at draft time)       | Product go-ahead post-cutover        | Parked deliberately (rollup §2.2).                                           |
| S-3 | Eugene source names/addresses (Thompsons Sanitary Service, Stayton Community Center, Deschutes) | Rick                                 | Seeded 2026-07-10 with Address TBD; names to be confirmed against his forms. |

## 3 — Code follow-ups (accepted residuals, not bugs)

| #    | Item                                                                                                                                                                                                                                                                                           | Source                                  | Shape                                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1  | `invoice_export` **v2 contract bump** carrying the trade-discount fields — lands WITH the GP adapter (blocked on Mary's packet)                                                                                                                                                                | ADR-0041 §D review item 1               | Deliberate: v1 stays frozen; the adapter must not re-derive from line JSON.                                                                     |
| C-2  | Credit-memo **admin UI** (list + transition actions)                                                                                                                                                                                                                                           | ADR-0041 §D item 2                      | API + state machine shipped (PR #92/#93); UI is the follow-up.                                                                                  |
| C-3  | Credit-memo **cancel/withdrawn state**                                                                                                                                                                                                                                                         | ADR-0041 §D item 4                      | Today a memo whose invoice was voided out-of-band can only bounce between `rejected` and a failing reissue (compensated + audited, but wedged). |
| C-4  | Credit memo ↔ ADR-0039 **finding soft-link** (provenance chain finding → memo → superseding invoice)                                                                                                                                                                                           | ADR-0041 §D item 3                      | Nice-to-have provenance.                                                                                                                        |
| C-5  | Section-resolver **provenance telemetry for §8.2** — flag category tabs that only resolve via the name-fallback tier so unconfirmed row-2 label rules fail loudly against real files                                                                                                           | ADR-0041 §D item 5 / resolver TODO      | Do during §8.2 finalization.                                                                                                                    |
| C-6  | **Period-close manual-close residual**: an app outage spanning the whole retry budget (~07:00–09:30 PT on a close day) still needs a manual close; nothing pages                                                                                                                               | PR #93 / cron audit F4                  | Candidate: daemon-side ntfy page on final give-up. Documented in `scripts/bonus-period-close.mjs`.                                              |
| C-7  | **Client-side GlitchTip DSN not baked** into the browser bundle — client React errors go unreported (server-side reporting is live)                                                                                                                                                            | 2026-07-10 ops sweep                    | Needs `NEXT_PUBLIC_GLITCHTIP_DSN` at image build (Dockerfile ARG), not runtime env.                                                             |
| C-8  | **AP `pendingApCount` excludes ON-HOLD items** from the ADR-0043 digest count                                                                                                                                                                                                                  | AP audit #6 (deliberate, test-asserted) | Product call for Bill: is a held invoice "pending" in the digest sense?                                                                         |
| C-9  | **Workbook-wins sync never deletes**: a row Kelsey removes from the workbook survives in `processed_units_daily` (caught only by ADR-0039 comparators/parity); **mid-edit rows never age out** (a permanently malformed date cell = a day silently absent, by D11 design, with no aging alarm) | billing audit M6                        | Revisit at §8.2 / before cutover parity window.                                                                                                 |
| C-10 | Container rentals bill the **full monthly rate for any overlap** (no proration; a boundary-spanning rental bills full in both months)                                                                                                                                                          | billing audit M7                        | Believed intentional (flat monthly) — confirm with Rick, then document in ADR-0040.                                                             |
| C-11 | Transportation generation is a **per-load N+1** (~6 queries/load, serial)                                                                                                                                                                                                                      | billing audit M5                        | Operator-triggered, tolerable; batch when invoice volume grows.                                                                                 |
| C-12 | `bonus-eod-check.mjs` is a **fat daemon** (direct Prisma + business logic, diverges from the thin-daemon contract; bypasses the in-process ntfy cooldown ledger)                                                                                                                               | cron audit F6                           | Refactor to internal-route shape when next touched.                                                                                             |
| C-13 | Shared **ForbiddenPage** component — 4 inline copies across admin pages (billing-rates already extracted its own)                                                                                                                                                                              | 7/9 review pass                         | Consolidate on next admin-surface touch.                                                                                                        |
| C-14 | `mymrc-cron` timer fix shipped but service stays **profile-disabled** (creds unprovisioned)                                                                                                                                                                                                    | cron audit F1                           | Re-enable steps in `docs/` + compose comment; safe to re-enable now.                                                                            |
| C-15 | **`ap_attachments.is_inline` capture** — replace the 50 KB image size-heuristic with Graph's exact `isInline`/`contentId` signal (`normalizeFile` → `persistFile` → new column)                                                                                                                | ADR-0046 note 2026-07-15 (PR #101)      | The heuristic ships fine; this is the durable form.                                                                                             |

## 4 — §8.2 (unblocks the moment O-2 lands)

1. ADR-0048 D4 promotion of June + July + Terex against real bytes (checksums in rollup §7.4).
2. Full-file parser fuzzing; reconcile the resolver's inferred row-2 label rules (only `inb_trans_charges` is confirmed) + DAY-grid stride (cotton col-68 anchor is proven; blocks 1–8 inferred).
3. Woodland June close-balance assertion (= 4,062).

## Done

- **C-16 — DONE 2026-07-16 (office dark-theme sweep executed).** Operator
  directive (Bill): "everything goes to the new look except the floor iPads."
  Repainted every remaining green office/manager surface to the Vision
  deep-space theme (`dr3-space`/`dr3-mist`/`dr3-cyan`/`dr3-steel`) following the
  AP reference (PR #99), as an in-place token swap (the optional `office-shell`
  extraction from VisionShell was not needed for the sweep goal and is deferred).
  Surfaces: all `/dashboard/[site]/*` pages + clients (cor, equipment, invoices,
  invoices/[id], loads-inventory, ops, yard), `/dashboard/ops/digests`,
  `/admin/processed-units`, `/admin/production-report`, `/bonus/amendments`, the
  `/login` locale picker, and the app-global chrome (`layout` themeColor,
  `global-error` fallback, the `UpdatePrompt` banner CTA). `/login` was confirmed
  office-only (Entra SSO door; the floor PIN path is under `/operator`), so it
  goes dark. The floor (`/operator/*`) and the COR PDF renderer stay green per
  ADR-0008. A static sweep test (`office-dark-theme-sweep.test.tsx`) now guards
  the "no green office pages" invariant. See the ADR-0051 post-acceptance note.

- **O-9(b) — DONE 2026-07-15 (floor stays GREEN).** Operator decision: "keep
  the floor green." The warehouse-floor iPad surfaces (`/operator/*`) keep the
  ADR-0008 green theme for sunlight/glare readability; the deep-space theme
  remains office/manager-only per ADR-0051. O-9 is now fully closed — (a)
  site tag required shipped same day (PR #105), (b) settled here.

- **O-9(a) — DONE 2026-07-15 (site tag REQUIRED on decisions).** Operator
  directive: "make the site tag required on decisions." Enforced service-side
  (`assertDecisionSite` → `ApSiteRequiredError` 400 before any state change),
  route-side (resolve + refuse pre-CAS), and in the queue UI (required select
  - client guard). ADR-0046 post-go-live amendment note. Only O-9(b) (floor
    iPad theme) remains open above.
- **C-17 — DONE (shipped in the 7/15 AP overhaul).** The decision-mail resend
  path exists end-to-end: `Resend` button in the queue detail →
  `/api/ops/ap/[id]/resend`. Register row was stale.

- **O-1 — DONE 2026-07-15 (AP IS LIVE).** Operator order same day as the
  validation pass: test data purged (3 requests: DB rows, 7 R2 objects, 3
  mailbox emails; audit rows kept) and `ap_notify` flipped to **live at BOTH
  sites** (audited under Bill's admin user; criteria note cites the ADR-0046
  validation record + PRs #98–#102). Mary (`mary.scott@svdp.us`) active in
  `ap_decision_recipients`; approver roster: Morena, Rick, Janette, Kelsey
  (auto-expires 8/1). From now on: new-invoice alerts go to the real roster,
  decision mail to the forwarder + Mary CC — no [PILOT] banner. Rollback =
  flip both rows back to pilot on /admin/rollout, one audited action each.

- **O-0 — DONE 2026-07-14.** Bill added `dr3-vision@svdp.us` to the
  `dr3-vision-scoped@svdp.us` RAOP scoping group (Exchange device-code session
  from the workspace host — pwsh 7.4 + ExchangeOnlineManagement now installed
  at `~/.local/pwsh` for future admin one-offs). After propagation the probe
  cleared (201), `M365_MAIL_FROM_ADDRESS` was restored to `dr3-vision@svdp.us`
  on CHAD, app recreated, and a live test report delivered from the proper
  sender (delivered 1). AP mail keeps sending from `approvals-dr3@svdp.us` as
  designed. The 2026-07-10 mitigation is fully unwound.
