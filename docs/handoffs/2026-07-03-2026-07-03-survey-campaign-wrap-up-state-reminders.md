# Handoff — DR3 Intel survey wrap-up + ADR-0035/0036 session (2026-07-03)

_Written by the operator session driving the survey wrap-up. Times Pacific unless marked UTC._

## Campaign `dr3-intel-2026-06` — current standing

**8 submitted · 1 withdrawn (Leisha Wallace) · 1 outstanding (Mary Scott).** Campaign `open`.

- **Kelsey Ruhland — operator-submitted 2026-07-03 9:41 AM PT.** She had all 10 answers in draft and believed she'd submitted (saving ≠ submitting). On Bill's direction, finalized via the real public route `POST /api/survey/<token>/submit` (audited; user-agent records the authorization). UX follow-up candidate: the save-vs-submit confusion.
- **Leisha Wallace — WITHDRAWN on Bill's direction** (input no longer needed). Applied on prod inside a transaction: `status='withdrawn'` + token rotated (old link 404s) + audit_log row under Bill's admin user (`c6a6ca68-…`) with the reason. `withdrawn` is a safe terminal status: not in the reminder pool (`sent`/`opened`) and not in the auto-close blocking set (`approved`/`sent`/`opened`). Recipe reusable for pulling any recipient from a live campaign.
- **Mary Scott** — `sent`, never opened since 6/23 (one manual resend 7/2 ~11:55 PM PT). She now gets one automated reminder/day; if she keeps not opening, switch channels rather than more email.
- **Auto-close arms on Mary's submission**: campaign closes under `actor_label: system:survey-reminder-cron`, Bill gets ONE ntfy on `dr3-vision-system` (fingerprint `survey-campaign-autoclosed:<id>`, click → `/admin/operations/intel/<campaignId>`). Export is NOT auto-run — use the admin **Export** button after close (`export_only=true` works post-close).

## ADR-0036 — automated daily reminders (LIVE, plus same-day hotfix)

- `dr3-vision-survey-reminder` container fires 09:00 PT daily → POSTs internal `/api/internal/survey/reminder-tick` → `runSurveyReminderTick()`: one reminder/day per `sent`/`opened` invite, 20h `last_reminder_at` gate (stamped only on Graph 202 — failures retry next day), tiered copy (saved-progress "finish" / opened-empty nudge / never-opened resend).
- **First-fire incident (2026-07-03 09:00 PT): tick silently no-op'd.** Middleware exempted `/api/internal/bonus/` but not `/api/internal/survey/` → 307 to /login; daemon's fetch followed the redirect → login page 200 → "success" logged, nothing sent. **Hotfix PR #40 `23e27e8` (merged):** predicate extracted to `src/lib/public-paths.ts` (+ exemption + regression test over the whole list), daemon uses `redirect:'manual'` and throws on any redirect/non-200, log bodies truncated. ADR-0036 addendum records the lesson: every new `/api/internal/*` family needs a middleware exemption + a `public-paths.test.ts` case.
- **Pending at handoff time:** PR #40's deploy was mid-build on CHAD; after it lands, the missed 7/3 tick gets re-fired manually in-network (must see a direct 200 JSON summary; expected remindersSent:1, Mary). A docs commit (`docs/survey-status-20260703` worktree → push to main `[skip-deploy]`) updates `docs/operator/operational-intelligence-survey.md` with the 7/3 campaign log.

## Also shipped this session (all merged to main)

- **PR #37 `636fe71`** — pre-push gate skips deletion-only pushes (was blocking branch sweeps).
- **PR #38 `20e4142`** — docs: 7/2 manual nudge round record.
- **PR #39 `eabd8eb`** — ADR-0036 feature (reminders + auto-close; migration `20260703_survey_invite_reminder_tracking`; suite 1035→1066).
- **PR #36 `e13fd77`** — ADR-0035 clean-DB migration CI gate + `20260616_amendment_submission_group` → `20260616_amendment_workflow_submission_group` rename (clean-replay ordering). **Prod `_prisma_migrations` ledger already reconciled** (pure-rename UPDATE, 1 row) BEFORE the deploy; verified merged 16-migration set replays clean on empty PG16. Drift step is advisory until pre-existing cosmetic drift is reconciled — promoting it is an open hardening item.
- **PR #40 `23e27e8`** — middleware/daemon hotfix above (suite → 1091).
- Repo hygiene: all stale worktrees (~3.5G) + 52 local + 15 remote branches pruned; remote = `main` only.

## Gotchas for the next session

- `~/DR3-Vision` on droneops-server is the deployer's reference clone — never move HEAD there; use worktrees, merge with `gh pr merge -R BigBill1418/DR3-Vision <n>` from OUTSIDE a repo dir (in-worktree merge fails its local checkout step).
- DR3 cold builds run ~730–884s against the 900s `compose_build_timeout` (noc-master `data/config.yml`) — bump if a build ever gets SIGKILLed.
- CHAD psql via ssh: heredocs get mangled (quoting) — scp a .sql file + `psql -f` with `-v var=…`.
- ADR numbering: next free is **0037**.
