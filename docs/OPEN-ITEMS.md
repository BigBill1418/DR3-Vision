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

| O-2 | **DECIDED + SURFACE BUILT 2026-07-16 — portal upload.** `/admin/file-drop` inbox live (admin-only): Bill dumps ANY file → stored to R2 + manifested with a best-effort `detected_kind`; Claude Code downloads + classifies/routes each (workbook staging / equipment import / etc.). REMAINING: Bill uploads the June/July workbook + Terex/Eugene files, then Claude runs §8.2 (ADR-0048 parser + promotion, June close-balance **3,977** assertion — corrected from the buggy 4,062; the workbook's grid double-counted the DAY23 non-program row, ADR-0037). **Kelsey window: before 8/1.** | rollup §7, `/admin/file-drop` | Capture done; §8.2 promotion awaits the actual files. |
| O-3 | **RESTIC_PASSWORD off-box confirmation (P1-4)** | go-live plan Stage 0 | Last gate in `assertLoadsInventoryActivated` — critical-path blocker for every manager ramp (Stage 1+). |
| O-4 | **HELD 2026-07-16 (Bill): do NOT create Mary's account now** — no other accounting staff has billing-verify, so she won't either for now. Revisit if that changes. | rollup §1.2 | `/admin/billing/verify` stays admin/super-admin-reachable only. |
| O-10 | **Five security-audit decision items** (2026-07-16 audit): D1 Next.js auth-layer bump (+D5 CVE clear), D2 session revocation strategy, D3 CSP nonce, D4 verify svdp.us DMARC + sender-header gate | ADR-0053, `docs/security/2026-07-16-full-stack-audit.md` | Each needs Bill's call/deploy window; recommendations + sequencing in ADR-0053. The `[fix]` findings already shipped (PRs #116/#117). |
| O-6 | **Kelsey capture register — effectively CLOSED (2026-07-17, rollup §A.11).** 4 of the 5 walkthrough items are resolved: DAY6 `×5` (B10-3) CLOSED as a false lead — Kelsey didn't recognize the concept; the "×5" was a garbled survey artifact, the real DAY6 cotton-block quirk was already solved in PR #87 §3.2 (§A.3). `%` column ANSWERED — it's per-vendor recycling rates, now built as ADR-0055 (§A.4). Event units (B10-4) ANSWERED — they feed the program pool like standard inbounds; event _billing_ is separate (Rick owns the mechanics) (§A.5). B10-5 (commodity → invoice mapping) CLOSED — NOT REQUIRED for billing (§A.1), which simplified the ADR-0041 invoice math to a single line. **RESIDUAL asks:** (1) `saved_units` (B10-2) — Kelsey confirmed the model (draw from non-program pool) but Rick must confirm OR practice; (2) MRC contact map + Re-TRAC filing — PENDING, on Kelsey's post-8/1 knowledge-transfer side (non-blocking). | rollup §A.11 / §8.3 / PR #87 §3 | Register closed except the 2 residuals above. |
| O-7 | **Answer: does Mary's outgoing stewardship-fee AP booking warrant a Vision surface?** | rollup §1.6, ADR-0046 note | If yes → draft an ADR (takes the NEXT FREE number at draft time — 0052 went to commodity payment reconciliation; numbers are never reserved). Also clarify which direction the fee flows. |
| O-8 | Remaining Stage-0 runbook rows (operator roster seed, MyMRC profile enable, DR3# counter alignment with Janette, Rick's rate tables, E0/E-Rick comms) | go-live plan Part 1, Stage 0 | See the plan's table for runbook links per row. |

## 2 — Blocked on stakeholders

| #   | Item                                                                                            | Blocked on                           | Notes                                                                        |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| S-1 | ADR-0050 dispatch-integration draft (3 email types + parser signals)                            | Morena's 2–3 example emails per type | She committed to forwarding them (rollup §2).                                |
| S-2 | "Verbal capture" surface for phone/text swap requests (ADR number assigned at draft time)       | Product go-ahead post-cutover        | Parked deliberately (rollup §2.2).                                           |
| S-3 | Eugene source names/addresses (Thompsons Sanitary Service, Stayton Community Center, Deschutes) | Rick                                 | Seeded 2026-07-10 with Address TBD; names to be confirmed against his forms. |
| S-4 | **§7 OR source seeds — PARKED pending Rick (Bill's call 2026-07-18).** The MRC-billing-rollup §7.2 seed table is NOT reconcilable with the live system (verified in `prisma/seed/sources.csv` + prod DB during the 2026-07-18 ADR ship): (a) its names (`Salem SVDP`, `Glenwood Transfer Station`, `Rifes`, `Roseburg`, `The Dalles SVDP`, `Sponsors`) are NOT the verbatim MyMRC names the live sources use (`Salem-Keizer Recycling Center`, `Glenwood Transfer & Recycling Station`, …) — `schema.prisma`/`seed/README.md` HARD-require verbatim names or the MyMRC reconciliation join breaks; (b) the "Glenwood TC 143/144 split rows to merge/delete" do NOT exist in the seed or prod — one Glenwood source; (c) `Sponsors` is a committed `consumer_dropoffs.kind`, not a source; (d) per_mattress ($2.25) + OR mrc_unit ($17) already live in `state_program_rules` where the generator reads them — `source_service_rates` (ADR-0040) has NO generator consumer yet, so seeding it is inert+duplicative. | Rick (canonical name→entity mapping) + Bill (rate-model + Sponsors decision) | UNBLOCK = Rick's verbatim names + old→new mapping; then decide: keep OR rates in `state_program_rules` (current, wired) vs migrate to per-source `source_service_rates` (needs generator rewire). §10.5 also gates live-rate seeding on Bill's go-ahead. Safe interim subset available: classify the existing 8 OR sources by `site_type` only (no rename/rate) once the SVDP↔municipal identity is confirmed. |
| S-5 | **MRC invoice: incentives (B7) + event-misc (B8) on the processing invoice?** ADR-0041 still composes B7/B8 as ancillary lines → GP `Misc`. §A.7 single-line math (`units×rate + trade_discount`) is EXACT for a clean Woodland processing invoice (no incentives/events → Misc $0). If they should be OFF the processing invoice, it's a one-line change that CHANGES BILLED MONEY. | Mary/Rick | Needs explicit sign-off; not done unilaterally (ADR-0041 amendment §residual-1). |
| S-6 | **GP identifiers still unknown** — OR MRC Customer ID + Eugene PO suffix (`DR3E`/`DR3O`?). Seeded null (never invented); `buildPoNumber` returns null until set. | Mary | Woodland (MRCL001 / DR3W), Sales ID 34, Net 30, 501 Wythe St ARE seeded (ADR-0041). |
| S-7 | **Recycling rate: Xtraction steel 0.81 vs 0.8098?** Kelsey's verbal example (1,054 trash + 4,487 steel on 5,541 lb) implies 80.98%, not the 0.81 she stated. Seeded the confirmed **0.81** (derives 4,488/1,053). Other wood-recycler rates unknown. | Kelsey/Morena | ADR-0055; system uses 0.81 correctly — confirm the exact rate + the remaining wood vendors. |

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
| C-16 | **ADR-0040 rate resolvers built but NOT wired into the generator.** `resolveSiteTypeBilling` / `resolveSourceServiceRateCents` / `resolveWoodlandFreightCents` (`src/lib/billing-rates/`, PR #132) have no caller in `src/lib/invoices/generation-inputs.ts` — the live generator still prices OR via `resolveFreightCents` (`account_haul_rates`+`transport_rate_tiers`) and reads per_mattress/processing rates from `state_program_rules`. The new resolvers + `source_service_rates` are forward-infra. | PR #132 / 2026-07-18 §7-seed audit | Deliberate for now (pilot mode = no live MRC send). Wiring is coupled to the S-4 rate-model decision — do BOTH together or the two paths drift. |

## 4 — §8.2 (unblocks the moment O-2 lands)

1. ADR-0048 D4 promotion of June + July + Terex against real bytes (checksums in rollup §7.4).
2. Full-file parser fuzzing; reconcile the resolver's inferred row-2 label rules (only `inb_trans_charges` is confirmed) + DAY-grid stride (cotton col-68 anchor is proven; blocks 1–8 inferred).
3. Woodland June close-balance assertion (= 4,062).

## Done

- **O-5 — DONE 2026-07-16 (Bill: skip, Option C).** No Eugene June backfill; Rick's 7/20 iPad go-live starts a clean forward-only ledger (Eugene lacks Woodland's billing complexity, so the shadow-billing-parity rationale doesn't apply).

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
