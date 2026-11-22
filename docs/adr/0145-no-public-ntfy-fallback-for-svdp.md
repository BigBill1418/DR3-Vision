# ADR-0145 — No public ntfy.sh fallback: SVdP alerts go to the self-hosted primary or nowhere

- **Status:** Accepted 2026-11-22 (Pacific). Bill approved 2026-11-22 1:30 PM PT.
- **Implements:** noc-master notification standard (its ADR-0036), amended 2026-11-22 by noc-master PR #248: the shared helper
  `scripts/ntfy-publish.sh` refuses the public fallback for SVdP topics, and SVdP callers that post to a shared
  topic pass `--no-public-fallback`.
- **Supersedes:** the fallback clauses of ADR-0122 §Consequences (the `dr3-vision-floor` fallback row) and the
  noc-master ADR-0194 Am.3 obscured-suffix rules as they applied to this repo.

## Context

DR3-Vision is an SVdP system. SVdP data does not go to external services. Every DR3 publisher retried a failed
`ntfy.barnardhq.com` publish on the **public** server `ntfy.sh`, on an obscured topic whose name was its only
access control. The topic name was written out five times in this repo: `src/lib/ntfy.ts` (five topics),
`src/lib/mymrc/ntfy.ts`, and the three standalone daemons `scripts/bonus-eod-check.mjs`,
`scripts/bonus-escalation-check.mjs` and `scripts/migrate-with-ntfy.mjs`. The escalation daemon also posted to
the public topic **without trying the primary** whenever its token file was missing. Bodies there include
MyMRC sync errors and stacks (redacted since ADR-0133, but still SVdP operational detail), floor dead-end pages
and payroll-deadline pages.

## Decisions

- **D1 — no public leg.** Every publisher above posts only to the self-hosted primary. On failure it logs a
  structured line with the reason (`public fallback disabled (SVdP, ADR-0145)`) and drops the page. The
  `fallback-sent` outcome no longer exists; `PublishNtfyResult.outcome` is `sent | cooldown-suppressed |
unconfigured | dropped`.
- **D2 — retries instead.** `src/lib/ntfy.ts` keeps its three primary attempts inside the 12 s budget, and a drop
  still releases the ADR-0130 cooldown claim so the next watchdog tick retries. The escalation daemon's
  app-independent payroll page (audit P1-4) gets three primary attempts, 500 ms apart, in place of the public leg.
  With no token it sends nothing and logs it, rather than posting anywhere unauthenticated.
- **D3 — host scripts.** `scripts/restore-drill.sh` (shared `infrawatch-alerts`) and `scripts/dr3-pg-backup.sh`
  (`chad-hq-backup`, which the helper already refuses) pass `--no-public-fallback` explicitly, so the guarantee
  does not depend on the helper's topic regex.
- **D4 — a source guard.** `src/lib/ntfy.test.ts` "no public ntfy.sh fallback in any DR3-Vision publisher" fails
  if any publisher's code (comments excluded) contains `ntfy.sh`, an obscured `bhq-fb-dr3v-*` topic or a
  `[FALLBACK]` title, or if a helper call in the two host scripts lacks `--no-public-fallback`.

## Consequences

- A total outage of `ntfy.barnardhq.com` now silences DR3 pages for its duration. Accepted: the primary is
  self-hosted with its own monitoring, the in-app dashboards and the durable ledgers (ADR-0117, ADR-0130) are
  unaffected, and stamps are written only on `sent`, so sweeps re-page after recovery (the
  delivered-is-not-sent rule of ADR-0114/0126/0129).
- The obscured DR3 rows in noc-master `data/ntfy-fallback-topics.yml` were already removed by PR #248; nothing in
  this repo references them now.
