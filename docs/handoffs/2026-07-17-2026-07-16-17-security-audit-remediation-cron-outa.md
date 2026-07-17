# Session handoff — 2026-07-16 → 07-17

Very large session. Everything below is MERGED + DEPLOYED to CHAD unless marked
otherwise. Live register: `docs/OPEN-ITEMS.md`. Deploy/CI mechanics:
required checks gate merges, auto-merge is OFF (poll `gh pr checks` then
`gh pr merge --squash --delete-branch`), ADR-0062 saturation guard defers
deploys under CHAD load, always `npx prisma generate` after a schema rebase.

## 1. Full-stack security audit (2026-07-16) — ALL REMEDIATED
Register: `docs/security/2026-07-16-full-stack-audit.md`. 18 findings fixed via
two aegis batches: **PR #116** (money/audit-integrity: amendment approve/reject
CAS, atomic AP decide+audit, dup-report guard, credit cumulative cap,
comma-currency parse, AP field caps) and **PR #117** (input/infra: Playwright
SSRF, CSV formula-injection, upload MIME allowlist, health authz, internal-cron
token, iframe sandbox, legacy/ delete, .dockerignore, container mem/pid limits).
**ADR-0053** tracks the 5 decision items — ALL DONE:
- D1 next 15.5.15→15.5.20 (middleware-bypass advisory; non-breaking, PR #120).
- D2 session kill-switch `users.sessions_invalidated_at` (instant off-boarding; PR #122).
- D3 nonce CSP, drop script-src unsafe-inline (PR #123; browser-verified — SW registers, no violations).
- D4 svdp.us DMARC verified p=reject; sender comments corrected (PR #121).
- D5 non-force npm audit fix (prod highs cleared; residual = dev-only vite/vitest).

## 2. CRON-OUTAGE INCIDENT (ADR-0054) — resolved
PR #117's `guardInternalCron` made INTERNAL_CRON_TOKEN mandatory-in-prod (503
when unset) but the token was NEVER provisioned in prod `auth.env` → ALL 10
internal cron daemons 503'd for ~18.5h (2026-07-16 16:41 → 07-17 11:10 PDT).
One real miss: the 2026-07-16 daily report (both sites); everything else
auto-recovered (AP ingested 2 queued invoices) or was idle.
**FIX:** added `INTERNAL_CRON_TOKEN` (openssl rand -hex 32) to
`~/.dr3-vision-secrets/auth.env` on CHAD (mode 600, `.bak-20260717` backup) —
app + all daemons read this same file; daemons already send the bearer when set.
Recreated app + daemons. All crons recovered.
**PR #126** shipped: (a) date-parameterized daily-report backfill
(`POST /api/internal/bonus/daily-report` accepts `{date,siteCodes,force}` →
real report to roster + logged, idempotent), (b) fail-LOUD guard (unset token in
prod now pages ntfy `dr3-vision-system`, 30-min dedup). Backfill for 2026-07-16
was FIRED for both sites (woodland 3/3, eugene 4/4 delivered, logged). ADR-0054
= postmortem (PR #125). LESSON: a hardening that makes an env var
mandatory-in-prod must provision it + a preflight in the same change.

## 3. §8.2 ADR-0048 workbook parser finalization — STAGED, UNPUSHED, awaiting Kelsey
**Branch `feat/adr-0048-parser-finalization` in `/tmp/dr3-parser82`, commit
`825a572` on `fdac9e9`, NOT PUSHED. STAGING ONLY — no promotion run.**
The promotion `parser.ts` matched sheets by exact name (dead — July dropped
June's month prefixes) → 0 rows. Fix: wired `section-resolver.classifyWorkbookSheets`
into the parse path; inbound now sourced from the DAY per-day INBOUND grids (the
COMPLETE all-channel inbound), not the category sheets. **Both months reconcile
EXACTLY** to the workbook's own ending inventory: **June close 4062, July 2577**
(July opening = June close; inbound totals 19765/8822 tie to the workbook).
Would write per month: June 23 processed / 208 inbound / 141 outbound / 24
dropoffs / 1 opening(1423); July 13 / 97 / 65 / 8 / 1 opening(4062). Terex =
equipment log, `templateGeneration=unknown`, 0 promotable rows (correct).
Full report: scratchpad `final-report.txt`. Gates: tsc clean, 2084 vitest, build ok.
**BLOCKED ON:** Kelsey confirming 4 layout assumptions (email drafted + sent to
bill.barnard@svdp.us via dr3-vision@svdp.us Graph for him to forward): (1)
Processed sheet cols D/E/J + "Day N" dating, (2) opening from Processed!D5 with
non-program opening=0, (3) program vs non-program split rule, (4) consumer
drop-off attribution + incentive $/check. These overlap O-6 Kelsey walkthroughs.
NEXT: on Kelsey's OK → push branch, PR, merge, deploy, then run the promotion
(writes processed_units_daily/inbound_loads/outbound_materials/consumer_dropoffs).

## 4. Other shipped this session
- **O-2 file-drop inbox** (PR #124): `/admin/file-drop` (admin-only) — Bill dumps
  any file → R2 + `file_drops` manifest; Claude classifies/routes. Bill uploaded
  the 3 real workbooks (June/July .xlsm + TEREX.xlsx); checksums differ from the
  2026-07-09 reference = newer versions (benign), verified as correct via structure.
- **ADR-0052 commodity payment reconciliation** — LIVE (Daven's module).
- **Ops ledger** — always-on digest email link + task assignee widened to
  admins+managers (`listAssignableOwners`). LIVE.
- **Daven Stetson onboarded** — manager, all_sites, active, on the LIVE
  ap_approvers roster (created via CHAD psql + audit row).
- **O-4** Mary's account HELD; **O-5** Eugene June backfill SKIPPED (closed).

## 5. Loose ends / cleanup
- Real production workbook files sit gitignored in `/tmp/dr3-parser82/.real-*`
  and scratchpad `_june/_july/_terex` — clean up after promotion.
- Several /tmp worktrees may linger (git worktree prune on ~/DR3-Vision).
- The parser branch is the only UNPUSHED work — it waits on Kelsey.
