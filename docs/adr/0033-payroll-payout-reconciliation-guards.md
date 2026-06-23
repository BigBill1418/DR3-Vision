# ADR-0033 — Payroll payout reconciliation guards + correctness gate

- Status: Accepted
- Date: 2026-06-23
- Supersedes/relates: ADR-0019 (bonus engine + signature lifecycle), ADR-0021
  (M365 payroll delivery), ADR-0023 (historical import), the 2026-06-23
  Decimal-lock correctness fix (commit `526f46d`).

## Context

On 2026-06-22/23 a confirmed payroll-correctness incident occurred. When a bonus
pay period reached `signed`, the sign-time lock in `src/lib/bonus/signatures.ts`
passed each entry's `mattress_count` **raw** into the calculator. `mattress_count`
is a `Decimal(5,1)` — Prisma returns a `Decimal` object, not a `number` — and the
calculator's finite-number guard rejected it, so **every entry contributed 0 and
the period locked to `total_payout_cents = 0`** while the PDF page (which coerces
via `.toNumber()`) computed the correct **$2,125.50**. Two independent
computations of the same payout DISAGREED, and the lock silently won.

The engine was fixed (the calculator now THROWS on a non-number; the lock now
coerces). But two systemic gaps remained, both of which this ADR closes:

1. **No outer ring.** Nothing compared the locked total against the recomputed
   total. A future divergence (a different type bug, a stale lock, a partial
   write) would again be paid silently.
2. **Silent payroll failures.** Every payroll-critical failure on the signing /
   delivery / notification path was log-only — none paged. The 2026-06-22 missed
   payroll deadline traces to exactly this: the ops signer was never emailed and
   nobody was alerted.

## Decision

Add four guardrails — an OUTER RING of assertions + loud alerts — without
touching the calculator's math or any payout/period data.

### P0-1 — Reconciliation tripwire (new invariant)

**Invariant:** for a period in a _reconciled state_ (`signed` or `paid`), the
recomputed grand total MUST exactly equal the locked `total_payout_cents`.

- Pure decision logic in `src/lib/bonus/reconcile-payout.ts` (`reconcilePayout`);
  the impure recompute + page in `src/lib/bonus/reconcile-fetch.ts`
  (`assertPayoutReconciles`). The recompute is INDEPENDENT — it re-walks the
  entries through the single `@/lib/bonus/calculator` (with `.toNumber()`
  coercion) rather than trusting the stored total.
- Wired into `generateBonusPdf` (BEFORE render/upload) and into
  `triggerPayrollDelivery` (BEFORE mail) — so a mismatched PDF can never reach R2
  or payroll. On mismatch: refuse + URGENT ntfy `dr3-vision-system`, fingerprint
  `payout-reconcile-mismatch:<monthId>`.
- Exact integer equality of the same computation → **no false positives by
  construction.**
- `amended` (editable/re-keyed), `draft`, `pending_signatures`,
  `partially_signed`, and `historical_imported` / legacy-formula imports are
  EXCLUDED from the invariant — their locked total is intentionally absent or a
  different number. Delivery only fires from `signed`, so this is sufficient.

### P0-2 — Implausible-(zero)-payout delivery guard

**Predicate (chosen):** block delivery iff `lockedTotalCents === 0` AND
`recomputedTotalCents > 0`.

- A `$0` that AGREES with a `$0` recompute (every processor sub-threshold — e.g.
  Timothy Elich, 24 mattresses < 50) is a legitimate real `$0` and is ALLOWED.
- A `$0` that DISAGREES with a positive recompute is the signature of the Decimal
  incident → BLOCK + URGENT ntfy, fingerprint `payout-zero-suspected:<monthId>`,
  for a human to confirm.
- This is a strict subset of the P0-1 mismatch, broken out so the operator page
  reads as the recognisable "wrong $0" case.

### P0-3 — Loud payroll failures

Add ntfy pages to previously log-only failure paths, all passing the ADR-0037
5-question gate (actionable, payroll-visible, deduped per-month, routed to the
month page):

- `signature-notifications.ts`: signer unresolvable / no email when a signature is
  required (`high`, `signer-unresolved:<monthId>:<slot>`); signature-request mail
  failed though M365 configured (`high`, `signer-mail-failed:<monthId>:<slot>`).
- `payroll-delivery.ts`: PDF generation failed for a signed period (`urgent`,
  `payroll-pdf-failed:<monthId>`); missing `pdf_storage_key` after generation
  (`urgent`, `payroll-pdf-missing-key:<monthId>`); R2 unconfigured at fetch time
  (`high`, `payroll-r2-unconfigured:<monthId>`).
- The sign route's notify `.catch` pages (`high`, `signer-notify-threw:<monthId>`).

**Fail-OPEN preserved:** a CONFIG-ABSENT state (M365 unset → `mail_disabled`) stays
SILENT and never throws — the app must still boot/serve without M365 (hard rule
#5). Only real, operator-actionable failures page. A reconciliation refusal that
already paged does not double-page from the delivery layer.

### P0-4 — Correctness gate before prod

- **Pre-push hook** (`.husky/pre-push`): runs `tsc --noEmit` + the bonus/payroll
  vitest suite, blocking the push on failure. SKIPS cleanly (exit 0) when
  `node_modules` is absent so the in-container deploy clone can still commit/push;
  `SKIP_PREPUSH=1` is a deliberate operator override.
- **GitHub Actions** (`.github/workflows/ci.yml`): `tsc --noEmit` + lint + full
  `vitest run` + `next build` on push/PR. Targets `ubuntu-latest` (no DB/secrets
  needed — build uses a dummy `DATABASE_URL`, the suite mocks every boundary).
  RUNNER NOTE: the fleet's self-hosted runners on BOS-HQ are an option but their
  labels are unconfirmed from the build workspace; switch `runs-on` if desired.

This is the gate the original `total_payout_cents: number` type-lie would have
tripped at push/CI time.

## Consequences

- A locked/recomputed disagreement can no longer be paid silently — it refuses the
  PDF and pages urgently. The cost is one extra recompute per PDF gen + per
  delivery (cheap; same query shape as the lock).
- A wrong `$0` is caught before payroll sees it; a real `$0` still flows.
- Payroll-path failures are now loud and deduped, not buried in logs.
- Typecheck/test are now enforced before code can ship.

## Failover & Resilience Guard self-check

- **Fail-closed where it matters:** the reconciliation + zero guards REFUSE
  (do not ship) on a failure — the safe direction for payroll.
- **Fail-open where required:** config-absent M365/R2 at boot never crashes; ntfy
  is fail-soft (no-op when unconfigured). Pages, not throws, on config gaps.
- **No data mutated:** the guards are read-only over `bonus_pay_periods` /
  `bonus_daily_entries`; no payout/period data is written by this change.
- **Dedup:** every page carries a per-month(/slot) fingerprint so a retry storm
  pages once per cooldown.
