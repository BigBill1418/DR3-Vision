# DR3-Vision — Current State & Buildout Readiness (2026-06-23)

Supersedes the 2026-06-22 buildout handoff. Captures everything through the
2026-06-22→23 payroll incident, its resolution, the P0 hardening, and the
enterprise-readiness gameplan. This is the current source of truth before the
loads/inventory/reporting buildout begins.

---

## 1. Executive summary

The bonus/payroll core is sound and well-engineered. A single live payroll period
exposed three latent defects (all now fixed + deployed) and prompted an
enterprise-readiness audit. Four P0 guardrails are built (committed, deploy pending).
Data is correct; backups are real and encrypted. The system is ready for the buildout
**once the P0 guardrails are deployed and the P1 items below are scheduled**.

---

## 2. The 2026-06-22→23 payroll incident — RESOLVED

**What happened:** the first-ever live bonus period to run the sign-time payout lock
(`9b3dc951`, Woodland, Period 13, 2026-06-09→22) surfaced three defects:

1. **Decimal type-lie → silent $0 lock.** The lock passed raw Prisma `Decimal`
   mattress counts into `calculator.ts`, whose `Number.isFinite()` guard rejected
   them → locked `total_payout_cents = 0`. The PDF path (`.toNumber()`) computed the
   correct $2,125.50, so the two paths disagreed. **The delivered PDF was always
   correct** ($2,125.50, verified from the actual R2 bytes); only the internal field
   was wrong. Fixed in `526f46d`: coerce via `toCount()` + the calculator now THROWS
   on non-number input. The Woodland field was backfilled 0 → 212550¢ (audited,
   `audit_log` row, fresh restic snapshot taken).
2. **Signer never emailed.** `signature-notifications.ts` resolved the signer by a
   legacy `primary_site_id IS NULL` heuristic instead of `bonus_signature_chains`
   (the authoritative source the sign route + UI use). Fixed in `5192345`:
   chain-sourced.
3. **PWA stale-shell stranded the signer.** A same-day deploy left an installed PWA
   serving a stale read-only shell. Fixed in `5192345`: `UpdatePrompt` now polls +
   auto-refreshes a hidden tab so a deploy can't strand a signer.

**Process lesson (the through-line):** unit-correct but integration-blind; silent
wrong/zero/empty instead of loud failure; two divergent computations of the same
truth; Prisma Decimal boundaries not respected.

**Status:** Woodland P13 is `paid`, $2,125.50, correct everywhere; payroll holds the
correct signed PDF. Eugene P13 is `partially_signed` awaiting the ops signer (Kelsey
Ruhland) — it will be correct on both paths when she signs (fix is live).

---

## 3. P0 hardening — BUILT (`6d14406`), deploy pending

ADR-0033. Closes the incident's failure classes:

- **P0-1 Reconciliation tripwire** — every signed/paid period: recomputed PDF total
  MUST equal the locked `total_payout_cents`; on mismatch the PDF is refused (cannot
  reach payroll) + `urgent` ntfy. The net that would have caught tonight automatically.
- **P0-2 Implausible-$0 guard** — a $0 that DISAGREES with an entries-recompute is
  blocked + paged; a legitimately sub-threshold $0 (recompute also 0) is allowed. No
  false positives.
- **P0-3 Loud failures** — signer-unresolved, signer-no-email, mail-failed,
  PDF-gen-failed now PAGE (ntfy) instead of log-only. Fail-open boot preserved.
- **P0-4 Correctness gate** — husky pre-push hook (`tsc --noEmit` + payroll tests,
  skips cleanly when node_modules absent) + `.github/workflows/ci.yml` (tsc + lint +
  full vitest + next build). The type-lie that caused tonight can't ship again.

970 tests green, tsc/lint/build clean. **NOT deployed** — to be deployed after Eugene
completes (so a redeploy doesn't disturb the in-flight signature).

---

## 4. Enterprise-readiness gameplan (audit 2026-06-23)

### Solid — build on it
Single calculator = one source of truth for every cent (lock/PDF/CSV/list/report all
call it); calculator fails loud; critical tests use real `Prisma.Decimal`; a genuine
end-to-end test (close→sign→lock→PDF→deliver→paid); complete + honest `audit_log`
(every payroll mutation, same transaction); `signed→paid` only on a confirmed Graph
202; backups real + encrypted (verified by decrypting actual snapshots); strong
site-scoping + chain-sourced override discipline.

### Remaining gaps (P0 done above; schedule these)
- **P1-1** `pdf-data.ts PdfEntry.mattress_count: number` boundary relies on callers
  coercing — harden defensively / accept `DecimalLike`.
- **P1-2 (before loads buildout)** MyMRC scraper silent-empty class: add "0 where N
  yesterday" anomaly alerting + hardened logged-out/404 detection. The buildout
  multiplies this across Hauls/Processed/Outbound feeds.
- **P1-3** Run + record one real restore drill (`restic dump | pg_restore` into a
  scratch DB) — list-tested ≠ restore-proven.
- **P1-4** Confirm `RESTIC_PASSWORD` is actually filed in 1Password (off-box).
- **P2** Retire the redundant legacy plaintext backup to the same bucket; surface a
  documented operator PDF re-trigger; consider 1Password for rotatable secrets.

### Buildout-readiness checklist (must be true before loads/inventory/reporting)
- [ ] P0 guardrails DEPLOYED (reconciliation + $0-guard + loud-failures live).
- [ ] Correctness gate enforced (pre-push/CI green before any prod deploy).
- [ ] Scraper anomaly detection + hardened logout detection (P1-2).
- [ ] One restore drill recorded (P1-3) + RESTIC_PASSWORD confirmed off-box (P1-4).
- [ ] New computed quantities (inventory running balance) = ONE shared function with
      real-Decimal tests + an e2e path — never a second divergent computation.
- [ ] Every new money/weight/count field coerces at a named Decimal boundary; no
      hand-written interface types a Decimal column as `number`/`string`.

---

## 5. The buildout itself (MyMRC loads + inventory + reporting)

Foundation is built-but-dormant (tables `inbound_loads`, `site_inventory_snapshots`,
`expected_loads`; routes; a Playwright scraper). **MyMRC auth is solved** — MRC
redesigned the Salesforce portal; the new login selectors are committed (`08b317e`,
no MFA, verified live), and the data pages are mapped: `/s/hauls`,
`/s/processed-materials`, `/s/outbound-materials` (all Lightning datatables). See
`docs/MYMRC-PORTAL-REDESIGN-2026-06-22.md`. Remaining: rebuild ingestion (prefer the
Aura/UI-API with the session over DOM scraping), then inventory (computed running
balance = inbound − outbound/processed, reconciled to physical counts — operator
decision) + reporting. Per-record weights/unit counts live on each record, not the
list view.

---

## 6. Operational facts
- Host svdp-dev `10.99.0.2`; Postgres container `dr3-vision-postgres` (`-U dr3 -d
  dr3_vision`); app image `dr3-vision-app:local` (has Playwright+chromium); deploy =
  `docker compose build app && up -d` (migrate auto-runs).
- Backups: nightly encrypted `pg_dump → restic → R2` (`scripts/dr3-pg-backup.sh`,
  `dr3-vision-pg-backup.timer`, 03:45 PT, 7d/4w/12m/5y). RESTIC_PASSWORD = recovery
  key. Restore steps in `docs/operator/backups.md`.
- Email: Vision is SVdP (separate org) — send only from `dr3-vision@svdp.us`
  (`scripts/send-svdp-mail.sh`), never a BarnardHQ identity.
- MyMRC creds: `~/.dr3-vision-secrets/mymrc.env` (both sites). `mymrc-scrape`
  compose service paused (profile `mymrc`) pending the ingestion rebuild.
