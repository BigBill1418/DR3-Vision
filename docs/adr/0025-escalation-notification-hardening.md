# ADR-0025: Escalation & notification delivery hardening (2026-06-09 go-live)

**Status:** Accepted
**Date:** 2026-06-09
**Decider:** Bill Barnard (Director of Operations, SVdP / DR3)
**Extends:** ADR-0019.1 §6 (escalation crons / tier-4 deadline alert), ADR-0036/0037 (fleet ntfy transport + noise policy).
**Prompted by:** the Period-13 go-live (2026-06-09), first day of live team use.

## Context

On go-live morning, the 09:00 AM PT **t4** ("payroll deadline missed") escalation
tier ran and logged:

```
[escalation] deadline-missed ntfy dropped (primary+fallback failed)
```

— twice, ~16 ms apart. Investigation against the live CHAD-HQ system surfaced
**two independent defects**, both latent until this morning:

### Defect 1 — alert delivery had no retry

`publishNtfy` (`src/lib/ntfy.ts`) made exactly **one** POST to the primary
(`ntfy.barnardhq.com`) and, on failure, exactly **one** POST to the obscured
`ntfy.sh` fallback, then returned `dropped`. The two t4 alerts failed within
~16 ms of each other — far too fast to be the 5 s request timeouts, i.e. **instant
connection errors: a momentary egress blip on CHAD-HQ** that took out the single
primary attempt and the immediately-following single fallback attempt together.

This was **not** an ACL/credential problem: the DR3 publisher token returns
HTTP 200 to every `dr3-vision-*` topic, and both ntfy servers are reachable from
CHAD-HQ. It was purely the absence of a retry. For a t4 alert this is
unrecoverable — t4 fires once per day and has no later tick, so a transient blip
silently loses the page.

### Defect 2 — t4 false-fired on archival periods

`runDeadlineMissed` queried `bonus_pay_periods` with `state != 'paid'` and
`period_end == yesterday (Pacific)`. The intent (ADR-0019.1 §6, and the tier-4
alternative at 0019.1 "Alternatives considered") was narrow: catch a period that
went through the signing workflow but whose PDF **did not reach payroll** by the
deadline (M365/R2 outage after auto-override, or never signed).

When **ADR-0023** later introduced the `historical_imported` state (and ADR-0019.1
the `skipped` state), `state != 'paid'` silently broadened to match those
**archival, already-settled** periods. On go-live, **Period 12** (eugene + woodland)
— both `historical_imported`, `period_end = 2026-06-08` (yesterday) — matched, and
t4 reported two "missed payroll deadlines" that were never live deadlines at all.
(Period 12 was already paid in the V1 system; the import is a record, not a queue
item.)

There was no payroll impact on go-live day: Period 13 had only just *opened*, so
there was no real deadline to miss. But both defects are real for future periods.

## Decision

### 1. Retry every ntfy publish, under a bounded budget

`publishNtfy` now retries each delivery path with short backoff instead of taking
a single shot at each:

- **Primary:** up to **3 attempts** (backoff 250 ms / 750 ms).
- **Fallback:** up to **2 attempts** (backoff 500 ms).
- A shared **`PUBLISH_TOTAL_BUDGET_MS` (12 s)** wall-clock budget caps the
  pathological all-timeout case so a hung server can never block a caller far past
  it. A transient failure returns instantly, so a retry costs ≈ the backoff, not a
  full timeout.
- Cooldown is still recorded on a **retry-recovered** success, so recovery cannot
  double-page.

No change to *what* is published or to the ADR-0036/0037 contract (topics, headers,
priorities, cooldowns, the obscured fallback topic). This is delivery resilience
only — see also CLAUDE.md hard-rule #5 (ntfy → Bill, system events only), unchanged.

### 2. t4 fires only for live-lifecycle periods (allowlist)

`runDeadlineMissed` now selects on an **allowlist** of the live pre-`paid`
lifecycle states (`T4_LIVE_DEADLINE_STATES` in `src/lib/bonus/escalation.ts`):

```
draft · pending_signatures · partially_signed · signed
```

The archival / terminal states are excluded and can never page:

- `paid` — success.
- `skipped` — pre-cutover empties (ADR-0019.1); terminal, no PDF.
- `historical_imported` — spreadsheet loads (ADR-0023); already paid in V1.
- `amended` — admin corrections, handled out-of-band.

`draft` stays in the list so a period that **never closed** (period-close cron
failed) still pages — that is a genuine miss. Tiers t1–t3 were already allowlisted
(`pending_signatures` / `partially_signed`), so only t4 carried the leak. This
realigns t4 with its original ADR-0019.1 §6 intent.

## Alternatives considered

- **Denylist (`state NOT IN ('paid','skipped','historical_imported','amended')`)**
  — rejected. An allowlist is safe-by-default: a future archival/terminal state
  added by a later ADR cannot silently leak back into a payroll page, which is
  exactly the failure mode that produced Defect 2.
- **Retry only the primary, not the fallback** — rejected. The go-live blip took
  out both paths at once; the fallback is the last line of defense for an *urgent*
  alert and deserves its own (smaller) retry.
- **Unbounded retries** — rejected. Some `publishNtfy` callers run inside request
  handlers (`publishUnhandledError` via instrumentation); the 12 s total budget
  guarantees the helper can never block a caller indefinitely.
- **Distinguish transient vs. timeout failures and retry only the transient ones**
  — rejected as premature. `postWithTimeout` collapses all failures to `false`;
  the time budget already bounds the worst case, so uniform retry is simpler and
  sufficient.
- **Move escalation alerts off ntfy onto a queue with delivery guarantees** —
  rejected as over-engineering for a two-site payroll cadence. Bounded retry plus
  the existing daily re-run cadence is adequate.

## Consequences

- A momentary network blip can no longer silently drop a payroll-deadline page.
- Worst-case `publishNtfy` latency is bounded at ~12 s even against a hung server.
- t4 will never again page on a historical import, a skipped period, or an
  amendment; it still pages on any live period (including a stuck `draft`) that
  misses the 09:00 PT deadline.
- Any **new** terminal/archival `BonusPayPeriodState` must be considered for the
  t1–t4 allowlists when it is introduced — by construction it is excluded from t4
  unless explicitly added, which is the safe default.
- Tests: `ntfy.test.ts` 11 → 14 (transient-recovers-as-`sent`, `dropped`-only-after-
  all-attempts, cooldown-after-retry); `escalation.test.ts` +4 (no-fire on
  `historical_imported`/`skipped`/`amended`, still-fires on `draft`). Full suite
  716 → **720**, `tsc --noEmit` 0, eslint 0. Shipped as PR #17 (`a8a8928`) and
  PR #18 (`8c94543`), verified live on CHAD-HQ.

## References

- ADR-0019.1 §6 (escalation crons, tier-4 deadline alert) — the intent this restores.
- ADR-0023 (historical data import) — introduced the `historical_imported` state
  that exposed the t4 leak.
- ADR-0036 / ADR-0037 (fleet ntfy transport + noise-reduction policy) — the
  delivery contract the retry preserves.
- `src/lib/ntfy.ts`, `src/lib/bonus/escalation.ts`.
