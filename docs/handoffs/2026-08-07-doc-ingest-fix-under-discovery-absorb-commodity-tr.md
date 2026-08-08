# 2026-08-07 — Doc-ingest: fix silent under-discovery, absorb the commodity tracker + trailer list, close two honesty residuals

**Session context (Bill × Claude, 2026-08-07):**

This handoff was scoped in conversation, deferred while JT's floor feedback (PR #205) and the Terex daily-entry fix (PR #206) were pushed, and is now being written before it evaporates. Bill: **absorb the commodity tracker — it's the cross-system reconciliation I want** — with the reconciliation *rules* explicitly deferred to after Kelsey's audit-method capture (she leaves 8/8; her method is the spec for the rules). Build the foundation now (absorb + side-by-side display), not the judgment layer.

**Bundled by Bill's decision:** the discovery-visibility gap (C-49) and the sweep-deploy precondition (C-46) ride in the same handoff, because a *reconciliation* feature built on silently-incomplete discovery is worse than none — it looks authoritative while missing documents. Plus two honesty residuals (F-1 COR headcount; Terex cost `$0.00`).

**Standing instruction:** re-read `CHANGELOG.md` + `docs/OPEN-ITEMS.md` on current `main` first; verify every premise against live code/DB. Multiple premises have died on checking this month.

---

## PRECONDITION (Bill, operator action) — deploy the sweep container (C-46)

**Until this runs, nothing sweeps** — no document is re-read, nothing new is discovered, and this entire handoff's absorption has no feed. A compose service already exists (`docker-compose.yml`, `scripts/doc-ingest-sweep-cron.mjs`); it needs the existing `~/.dr3-vision-secrets/cron.env` and:

```bash
# on svdp-dev
docker compose up -d doc-ingest-sweep
```

`/admin/doc-ingest/health` currently shows the sweep STALE — that is the intended alarm, not cosmetic. Claude Code should confirm the container is running (or tell Bill to run it) before trusting any discovery/absorption result.

---

## PHASE 1 — Discovery must stop under-reporting silently (C-49) — do this FIRST

**[M] Measured:** `sharedWithMe` returns **1 item while ≥2 documents are genuinely shared** to `docs-dr3` (a Graph search surfaced `DR3 Machine List (2).xlsx`, an Outlook-attachment share that appears in **no** enumeration route). **No surface compares "reachable" against "watched,"** so the under-count is invisible — the exact silent-staleness shape ADR-0057 D9 exists to prevent, in the one pipeline layer that never got the guard.

A reconciliation feature (Phase 2) built on discovery that silently misses documents is **worse than no feature** — it presents incomplete data as authoritative. So this is fixed first.

- **Move primary discovery off the under-reporting route** where a more complete one exists (a Search-based enumeration surfaced the missing file; assess it as the primary, per the C-49 note's "response (1)"). Verify empirically which route sees the most.
- **Build a "reachable vs. watched" reconciliation for discovery itself:** a surface (and a health signal) that compares what is *actually shared* to `docs-dr3` against what Vision is *watching*, and **flags the gap loudly** rather than letting it be invisible. This is the guard the discovery layer never had.
- **Non-silent:** an under-count surfaces in `/admin/doc-ingest/health` and Bill's 06:00 digest, consistent with ADR-0057 D9. Discovery that can't see a document must say so, not shrink quietly.

**Note the C-43 sunset (do not fix here, but record):** `GET /me/drive/sharedWithMe` is Microsoft-deprecated, degrades now, and **stops returning data 2026-11-01** with no documented one-to-one replacement. The whole "owners share, Vision reads in place" model rests on it. This is a **three-month architectural fuse** — out of scope for this handoff, but Phase 1's move toward a Search-based route may also be the start of the C-43 mitigation. Flag explicitly in the PR so it is not forgotten; it needs an architecture decision before November.

## PHASE 2 — Absorb the commodity tracker (Layer A: absorb + side-by-side, NOT reconciliation rules)

The `Woodland Data Auditing Tracker` cross-references commodity data against vendor invoices — the highest-reconciliation-value document, and structurally the beginning of the integrity campaign's Layer 3. **Bill wants Layer A now; Layer B (the reconciliation rules) is deferred to post-Kelsey.**

**Layer A — buildable now, no Kelsey dependency:**

- **Absorb** the commodity tracker into a **typed, queryable table** with real columns (using the ADR-0067 Am.8 header detection that already fixed the merged-title-row problem — verify it resolves this document's real headers, not a banner).
- **Preview-then-confirm**, because it carries money — same discipline as the TEREX absorption (ADR-0069 Am.2). Nothing money-touching auto-writes.
- **VERSION-SCOPED from the start.** The TEREX absorption's hard lesson (ADR-0077): registering a source made *all* applied revisions absorbable at once and the ledger summed every confirmed row → a **3× overcount** caught only by a hard-stop check. The commodity ledger must be **newest-absorption-wins, version-scoped**, with a test that goes red if a second confirmed revision double-counts. Do not repeat the triple-count.
- **Respect the `processed_units_daily` precedence rule** if any absorbed figure touches inventory — three writers under precedence (`source='mymrc' AND closed_at IS NULL`), **not** a sole writer. Compare against Vision's numbers; never overwrite them.
- **Surface side-by-side with Vision's own figures** — the tracker's numbers next to the matching MyMRC-haul / processed / outbound figures, so a human eye can see disagreements. **Display the comparison; do NOT judge it.** No flagging rules, no divergence thresholds, no "which source wins" logic — that is Layer B.

**Layer B — explicitly DEFERRED, tagged not forgotten:** the reconciliation *rules* (which discrepancies matter, which source is authoritative per field, ranked by dollar impact). **Blocked on Kelsey's audit-method capture** — her method is the requirements doc. Record this as an open item so it is picked up after her narration session, not lost.

## PHASE 3 — Absorb the trailer list

The trailer list (`Material`, `Weight (lbs)`, `Date of Entry to Yard`, `Exit Date` — clean operational data with a natural Vision comparison) absorbs 96 rows on confirmation. Same absorption path as Phase 2 (version-scoped, real headers). **The confirm click itself is Bill's (O-2)** — `confirmClassification` writes `classified_by` + `doc_class_source='operator'`, and Vision must not stamp Bill's name on a decision he didn't make. So: build/verify the absorption path works end-to-end; the human confirm is Bill's action, not Claude Code's. Report that the trailer list is ready to confirm.

## PHASE 4 — Two honesty residuals

**F-1 — COR month-end headcount renders `—`.** `src/lib/cor/prefill.ts` reads `processed_units_daily.employees_count`/`processors_count`, **NULL on all 987 prod rows** (never written by any of their four write paths). ADR-0076's `distinctProcessors` helper computes the real figure from the payroll source in ~21 ms. Small change + tests. (Deliberately unbundled from ADR-0076 to keep that change email-only; this is the right place to land it.)

**Terex cost `$0.00` → "not recorded."** ADR-0077 fixed the identical bug for downtime (a NULL column summed to 0 and painted green — "an unmeasured machine displayed as a flawless one") but **explicitly left the cost residual**: `totalCostCents` still renders `$0.00` rather than "not recorded," because cost is genuinely partly populated (7 of 68 events) so it is a weaker case. Widen `totalCostCents` to `number | null`; a genuinely-absent cost renders "not recorded" (neutral), a real $0 stays $0. This ripples into `costUsd` on the overview panel — update consumers. Same "not recorded ≠ zero" discipline, now applied consistently.

---

## Actions for Claude Code

1. Re-read CHANGELOG + OPEN-ITEMS on main. Confirm the sweep container is running (C-46) or tell Bill to run it — nothing downstream works without it.
2. **Phase 1 FIRST:** move discovery to the more complete route; build reachable-vs-watched with a loud gap alert (health + digest); flag the C-43 Nov-1 sunset in the PR as needing an architecture decision.
3. **Phase 2:** absorb the commodity tracker — typed queryable table, real headers, preview-then-confirm, **version-scoped (no triple-count, test-pinned)**, precedence-rule-respecting, surfaced side-by-side with Vision figures. **Display only, no reconciliation rules** (Layer B deferred to Kelsey). File the Layer-B open item.
4. **Phase 3:** trailer-list absorption path end-to-end; report it ready for **Bill's** confirm click (do not confirm on his behalf).
5. **Phase 4:** F-1 headcount fix; Terex cost `$0.00` → "not recorded" with `number | null` and consumer updates.
6. Falsification-grade tests (this codebase has shipped green-because-the-mock-lied twice): the version-scoping double-count test; reachable-vs-watched detects a known-missing doc; "not recorded ≠ 0" for both headcount and Terex cost.
7. Adversarial review; per phase PR → CI → merge → deploy → verify live. Tag Bill with: discovery before/after (does it now see the missing file?), the commodity tracker absorbed + side-by-side screenshot, trailer list ready-to-confirm, and the two residuals fixed.

**Do NOT:**
- Do NOT trust discovery/absorption before the sweep container runs (C-46).
- Do NOT build commodity **reconciliation rules** — Layer A display only; Layer B is Kelsey-blocked.
- Do NOT repeat the TEREX triple-count — version-scope the commodity ledger from the start.
- Do NOT assume `processed_units_daily` has a sole writer — precedence rule, three writers.
- Do NOT confirm the trailer list or commodity tracker on Bill's behalf — the operator confirm writes his name; it must be his click.
- Do NOT render an absent value as 0 (headcount, Terex cost) — "not recorded", neutral.
- Do NOT fix C-43 here, but do NOT let it go unrecorded — it's a Nov-1 fuse.

## Success criteria

- The sweep runs; discovery sees the previously-missing document (or loudly flags what it cannot reach); reachable-vs-watched exists and alarms on a gap.
- The commodity tracker is absorbed into a queryable table, version-scoped (no double-count, test-proven), shown side-by-side with Vision's figures — comparison displayed, not judged.
- The trailer list absorption path works and is reported ready for Bill's confirm.
- COR headcount shows the real number, not `—`; Terex cost shows "not recorded" for absent, `$0.00` only for a real zero.
- Layer B reconciliation rules are filed as a Kelsey-blocked open item; C-43's Nov-1 sunset is flagged for an architecture decision.

## For Bill

Two of your clicks gate this: deploying the sweep container (one line, or nothing sweeps) and confirming the trailer list + commodity tracker in `/admin/doc-ingest` (Vision won't stamp your name on a classification you didn't make). Once the sweep runs and Phase 1 lands, discovery stops quietly missing documents — which is the precondition for trusting any reconciliation. The commodity tracker will then sit next to Vision's own numbers so you can eyeball disagreements manually now; the automatic flagging is the part that waits for Kelsey's method, which is why her session this week is the thing that unlocks it.
