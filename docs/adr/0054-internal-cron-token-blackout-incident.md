# ADR-0054 — Incident: internal-cron 503 blackout from an unprovisioned mandatory secret (2026-07-16→17)

**Status:** Accepted (2026-07-17) — postmortem of a resolved production incident. Service restored; backfill + prevention tracked below.
**Date:** 2026-07-17
**Source:** PR #117 (`0f8b948`, security hardening, audit 2026-07-16) CRON finding → `src/lib/internal-auth.ts` `guardInternalCron`.
**Relates to:** ADR-0053 (2026-07-16 audit decision register — the CRON finding was a `[fix]` row there), ADR-0030 (daily production report), ADR-0046 (AP mailbox), ADR-0036/0037 (fleet notification transport + noise policy), noc-master ADR-0056/0057 (fleet deployer gate model).
**Owner:** Bill (decisions) + Claude Code (execution).

## Context

The 2026-07-16 full-stack security audit found a fail-OPEN hole on the 12
`/api/internal/**` cron routes: when `INTERNAL_CRON_TOKEN` was unset the bearer
check was skipped, and the app is WG-published on 10.99.0.2:9469, so any WG peer
could POST AP-poll / month-close / report blasts. PR #117 fixed it with a shared
`guardInternalCron` (`src/lib/internal-auth.ts`): in production an unset token now
REFUSES with `503 internal_unconfigured` ("mandatory in prod"); fail-open is kept
only for non-prod. This is the correct security posture.

But `INTERNAL_CRON_TOKEN` was never provisioned in the prod environment
(`~/.dr3-vision-secrets/auth.env`, shared by the app and all 10 cron daemons via
`env_file`). From the moment #117 deployed, every internal-cron POST returned 503.
The failure was silent: the 503s went to in-cluster daemons, and the guard 503s
before writing any run-log row, so nothing paged.

## Timeline (Pacific-labeled; hosts run UTC)

- 2026-07-15 23:08 PDT — #117 committed (`0f8b948`).
- 2026-07-16 16:07–16:35 PDT — 2026-07-16 production data entered (both sites), before the deploy.
- 2026-07-16 16:41 PDT (23:41Z) — #117 image built/deployed to CHAD. **Outage begins.**
- 2026-07-16 18:00 PDT — daily production report (report_date 7-16, both sites) scheduled fire → 503, **MISSED**.
- overnight — AP poll + escalation/EOD/period-close/survey/audit/fuel/board-pack ticks all 503.
- 2026-07-17 11:09 PDT — fix: `INTERNAL_CRON_TOKEN` (openssl rand -hex 32) added to `auth.env` (mode 600, `.bak-20260717` backup).
- 2026-07-17 11:10:03 PDT — app + all 10 daemons `--force-recreate`. **Outage ends.**
- 2026-07-17 11:10:36 PDT — first clean AP poll: 2 queued invoices ingested.

**Duration ≈ 18 h 29 m.** Exact container-start of the broken app is unrecoverable
(fix recreation replaced it); the window is bracketed by the image build and the
first proven missed fire.

## Blast radius

All 10 standing cron daemons 503'd for the full window. Only one had real consequence:

- **REAL MISS — daily production report 2026-07-16, both sites.** No
  `bonus_daily_report_log` row for report_date 7-16. Data present: eugene 2/224,
  woodland 15/808. Requires explicit date-parameterized backfill.
- **AUTO-RECOVERED — AP mailbox poll.** 2 invoices queued in the mailbox;
  ingested on the first post-fix poll (11:10 PDT). No data lost.
- **IDLE TICKS (no action due) —** period-close (current period 7-07→7-20 still
  `draft`, end not reached; prior period `paid`), escalation-check (no open
  signature chains since 6-06), EOD-check, survey-reminder (only campaign closed
  7-07), audit-sweep, fuel-fetch, ap-approver-expiry, board-pack-digest (0 sends
  ever). All are stateless/self-healing re-runs.
- **NOT affected:** the in-app on-save late-report path (Woodland 7-13 late report
  sent 18:02Z *during* the outage — it never crosses `guardInternalCron`);
  mymrc-scrape (no internal route); workbook-sync (not running).

## Root cause

A security hardening made a new secret mandatory-in-prod (fail-closed) but shipped
without (a) provisioning the secret, (b) a preflight, or (c) a loud signal on the
misconfiguration. The security design was right; the process failed at
provisioning and observability. The 503 was correctly refusing an unconfigured
request — it just should never have been unconfigured, and should have paged.

## Fix (applied 2026-07-17)

`INTERNAL_CRON_TOKEN` added to prod `auth.env` (mode 600, backed up); app + all 10
daemons force-recreated. Verified: `INTERNAL_CRON_TOKEN=SET` in app and daemons;
AP poll ingested the 2 queued invoices; 0 503s across all 10 daemons post-fix.

## Backfill status

- [ ] Daily production report, report_date 2026-07-16, **eugene** — data present, no log row.
- [ ] Daily production report, report_date 2026-07-16, **woodland** — data present, no log row.
- Executed via the date-parameterized backfill (PR building the backfill path +
  the fail-loud guard). Verify a `bonus_daily_report_log (site, 2026-07-16)` row
  lands for each site after send.

## Prevention decisions

1. **Fail-loud on unset mandatory secret.** `guardInternalCron` (and app startup)
   pages via ntfy (`dr3-vision-*`, `high`, ADR-0036/0037 envelope) when a
   mandatory prod secret is unset — fail-closed for security AND fail-loud for
   ops. This alone would have cut the 18 h blackout to minutes.
2. **Provisioning-before-merge.** Any PR that makes an env var mandatory-in-prod
   must, in the same change, provision it in `~/.dr3-vision-secrets/*.env` on CHAD
   and add a startup/preflight assertion. Added to the DR3 PR template + the audit
   remediation protocol.
3. **Fleet-deployer required-env gate.** Extend the noc-master deployer
   (ADR-0056/0057) with a per-repo `required_env` declaration; assert presence in
   the host env_file before promoting a build, page instead of deploying if
   absent — a `version_assert`-style gate for secrets.
4. **App startup config self-check.** Boot-time consolidated "mandatory prod
   config missing: [KEYS]" log+page, rather than lazy per-request 503s.

## Consequences

- 18.5 h of missed internal automation, bounded to one real miss (the 7-16 daily
  report) that backfills cleanly; everything else auto-recovered or was idle.
- The fail-open→fail-closed hardening stands; we add fail-LOUD + preflight so a
  fail-closed control can never again blackout silently.
- Prevention item 3 generalizes the lesson fleet-wide: an unprovisioned mandatory
  secret becomes structurally undeployable.
