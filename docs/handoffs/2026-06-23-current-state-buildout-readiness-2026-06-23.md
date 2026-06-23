# DR3-Vision — Current State & Buildout Readiness (2026-06-23)

Current source of truth before the loads/inventory/reporting buildout. Full repo copy: `docs/handoffs/2026-06-23-current-state-and-buildout-readiness.md`.

## Executive summary
The bonus/payroll core is sound. A single live period exposed three latent defects (fixed + deployed) and prompted an enterprise-readiness audit. Four P0 guardrails are built (committed `6d14406`, deploy pending). Data is correct; backups real + encrypted.

## The 2026-06-22→23 payroll incident — RESOLVED
First-ever live sign-time payout lock (Woodland P13, `9b3dc951`) exposed:
1. **Decimal type-lie → silent $0 lock.** Raw Prisma Decimal into the calculator's `Number.isFinite()` guard → locked `total_payout_cents = 0`. The PDF path (`.toNumber()`) was correct, so the two paths disagreed. **The delivered PDF was always correct** ($2,125.50, verified from R2 bytes); only the internal field was $0. Fixed `526f46d` (coerce via `toCount()` + calculator now THROWS on non-number). Field backfilled 0→212550¢ (audited).
2. **Signer never emailed** — notification used a legacy `primary_site_id IS NULL` heuristic, not `bonus_signature_chains`. Fixed `5192345` (chain-sourced).
3. **PWA stale-shell stranded the signer** after a same-day deploy. Fixed `5192345` (UpdatePrompt auto-refreshes a hidden tab).

Through-line: unit-correct but integration-blind; silent wrong/zero instead of loud failure; two divergent computations of the same truth; Prisma Decimal boundaries not respected.

Status: Woodland P13 `paid`, $2,125.50, correct everywhere. Eugene P13 `partially_signed` awaiting ops signer Kelsey — correct on both paths when she signs (fix live).

## P0 hardening — BUILT (`6d14406`, ADR-0033), deploy pending
- **Reconciliation tripwire** — signed/paid: PDF recompute MUST equal locked `total_payout_cents`, else refuse PDF + urgent ntfy.
- **Implausible-$0 guard** — a $0 disagreeing with an entries-recompute is blocked + paged; a real sub-threshold $0 passes.
- **Loud failures** — signer-unresolved / no-email / mail-failed / PDF-gen-failed now PAGE.
- **Correctness gate** — husky pre-push (`tsc` + payroll tests) + `.github/workflows/ci.yml`.
970 tests green. NOT deployed (deploy after Eugene completes).

## Enterprise-readiness gameplan
**Solid:** single calculator (one source of truth for every cent); calculator fails loud; critical tests use real `Prisma.Decimal`; genuine e2e test; complete `audit_log`; `signed→paid` only on confirmed Graph 202; backups verified by decrypting actual snapshots; chain-sourced signer/override.
**Remaining (schedule):** P1-1 harden `pdf-data.ts` Decimal boundary; **P1-2 (before loads) MyMRC scraper anomaly alerts ("0 where N yesterday") + hardened logout detection**; P1-3 record one real restore drill; P1-4 confirm RESTIC_PASSWORD in 1Password; P2 retire redundant legacy plaintext backup, document operator PDF re-trigger.

**Buildout-readiness checklist:** P0 deployed · correctness gate enforced · scraper anomaly detection · restore drill recorded + key off-box · inventory math = ONE shared function w/ real-Decimal tests + e2e · all new money/weight/count fields coerce at a named Decimal boundary (no Decimal-as-number type lies).

## The buildout (MyMRC loads + inventory + reporting)
Foundation built-but-dormant (`inbound_loads`, `site_inventory_snapshots`, `expected_loads`, routes, Playwright scraper). **MyMRC auth solved** — portal redesigned; new login selectors committed (`08b317e`, no MFA, verified). Data pages mapped: `/s/hauls`, `/s/processed-materials`, `/s/outbound-materials` (Lightning datatables; see `docs/MYMRC-PORTAL-REDESIGN-2026-06-22.md`). Remaining: rebuild ingestion (prefer Aura/UI-API over DOM scraping) → inventory (computed running balance = inbound − outbound/processed, reconciled to physical counts) → reporting. Per-record weights/units are on each record, not the list view.

## Ops facts
svdp-dev `10.99.0.2`; `dr3-vision-postgres` (`-U dr3 -d dr3_vision`); deploy `docker compose build app && up -d`. Backups: nightly `pg_dump→restic→R2` (03:45 PT, 7d/4w/12m/5y), `docs/operator/backups.md`. Vision = SVdP: email only from `dr3-vision@svdp.us` (`scripts/send-svdp-mail.sh`). `mymrc-scrape` compose service paused (profile `mymrc`) pending ingestion rebuild.