# ADR-0036 — Survey daily reminders + campaign auto-close

**Status:** Accepted (2026-07-03)
**Related:** ADR-0034 (operational intelligence survey system — this extends it), ADR-0030 (daily-report thin-scheduler precedent), ADR-0021 (M365 Graph mail-send), ADR-0036/0037 fleet notification policy (ntfy transport + noise rubric).

> Numbering note: ADR-0035 is reserved by the open CI migration-check PR; this work takes 0036.

## Context

The ADR-0034 survey campaign `dr3-intel-2026-06` went live 2026-06-23 (10 invites). As of 2026-07-02 it stood at 7/10 submitted, with three outstanding: Leisha Wallace (opened, 0 answers), Kelsey Ruhland (opened, 10 answers saved), Mary Scott (sent, never opened). That night Bill directed a one-off **manual** nudge round (a zero-dependency Node script run inside the app container, deleted after) — one tailored reminder per outstanding invite, three tiers of copy keyed to each recipient's state.

Bill's directive: automate that. Check daily for people who have not completed and send them one reminder per day until they complete; close the campaign automatically once the last responses come in. The manual round proved the copy tiers and the send path; this ADR makes it a standing, idempotent system.

## Decision

Three layers, mirroring the ADR-0030 daily-report cron precedent:

1. **Thin plain-JS scheduler daemon** — `scripts/survey-reminder-cron.mjs`. A long-running `unless-stopped` process that computes the next **09:00 America/Los_Angeles** instant (DST-correct via `Intl.DateTimeFormat` `formatToParts`), sleeps, then POSTs the internal route with the optional `INTERNAL_CRON_TOKEN` bearer, logs the outcome, and loops. It imports **no TS, no tsx, and not even `@prisma/client`** — the fire time is fixed at 09:00 PT, so unlike the daily-report scheduler it reads nothing from the DB. Prod image is `npm ci --omit=dev`, so the daemon must stay dependency-free.

2. **Internal route** — `src/app/api/internal/survey/reminder-tick/route.ts`. Same guard as `/api/internal/bonus/escalation-check`: any request carrying a `cf-connecting-ip` header (public Cloudflare tunnel) gets a 404; an optional `INTERNAL_CRON_TOKEN` bearer adds defense in depth. Calls `runSurveyReminderTick()` and returns its summary.

3. **Logic** — `src/lib/survey/reminders.ts` (`runSurveyReminderTick`), plus a tiered `sendReminder`/`renderReminderHtml` beside `sendInvite` in `notifications.ts` (both now share one refactored `renderShell`), and a system-actor overload on `closeCampaign` in `campaigns.ts`.

### Reminder semantics

For every campaign with `status = 'open'`:

- **Candidates:** invites with `status IN ('sent','opened')`. Draft/approved were never emailed; submitted are done.
- **20h daily gate:** send only if `last_reminder_at IS NULL OR last_reminder_at <= now - 20h`. 20h (not 24h) so a slightly-early fire still counts as the next day; two reminders can never land inside one 20h window. `last_reminder_at`/`reminder_count` are stamped **only on a successful send** — a failed send is retried next tick. Per-invite `try/catch`: one invite never blocks the others (fail-soft, mirroring `sendInvite`).
- **Copy tiers** (state-keyed):
  - **opened + ≥1 saved answer** → subject `Reminder: <subject_template>`, "your progress is saved and waiting", button **Finish your survey**.
  - **opened + no answers** → subject `Reminder: <subject_template>`, friendly nudge (saves as you type, 20–45 min, skip what doesn't apply), button **Open your survey**.
  - **sent, never opened** → **original** subject (no `Reminder:` prefix), original `intro_text` prefixed with one resend line, button **Open your survey**.
  - Tiers a/b are first-person in Bill's voice ending `— Bill Barnard, Director of Operations`; tier c re-sends the original intro, which already carries his sign-off. Sender identity (`from_display_name`/`reply_to`) and base URL (`PUBLIC_BASE_URL`, default `https://dr3-vision.svdp.us`) come from the same mechanism the `/send` route uses.

### Auto-close

After processing reminders, if the campaign has **≥1 invite `submitted`** AND **zero invites in `approved`/`sent`/`opened`**, close it. Drafts deliberately do **not** block — a draft is an operator's un-sent exclusion, not a pending respondent. The close is audited under a system actor (`actor_label: 'system:survey-reminder-cron'`) via a widened `closeCampaign(id, ActorContext | SystemActor)` — the admin route's `ActorContext` signature is unchanged. A `dr3-vision-system` ntfy then fires (title "Survey campaign complete — auto-closed", click → `/admin/operations/intel/<campaignId>`, priority `default`, fingerprint `survey-campaign-autoclosed:<campaignId>`). This is a Bill-only, system-level autonomous action, so it satisfies hard-rule #5.

**No export in the cron path.** `buildExport` is not run on auto-close; the admin Export button (`export_only=true`) works after close. Keeps the cron path narrow and side-effect-light, and avoids duplicating the ClaudeSync push machinery.

**Unbounded daily reminders are deliberate** per the operator instruction ("one reminder per day until they complete"). There is no cap and no give-up tier. The operator stops them by closing the campaign in the admin UI (or `docker stop dr3-vision-survey-reminder`). The tier-c copy for a never-opened invite already softens the repeat ("in case an earlier copy got buried").

## Alternatives considered

- **Cron in the daemon reading the DB for a configurable fire time** (like daily-report): rejected — the fire time is a fixed 09:00 PT, so the daemon needs no DB and no `@prisma/client`; simpler and one fewer secret (`db.env`) mounted.
- **A hard reminder cap / escalation-to-Bill tier:** rejected for now — Bill asked for daily-until-complete; manual close is the stop. Revisit if a campaign ever runs long.
- **Building the export on auto-close:** rejected — the export path is the admin button's job; running it here would duplicate the ClaudeSync push and widen the cron's blast radius.
- **A resend API endpoint** reused by the cron: the app still has no resend endpoint; the cron calls `sendReminder` directly. A UI resend button remains a candidate follow-up.

## Consequences

- New schema columns `survey_invites.last_reminder_at` (nullable) + `reminder_count` (INT NOT NULL DEFAULT 0); additive migration `20260703_survey_invite_reminder_tracking`. `last_reminder_at` starts NULL, so the first automated reminders fire at the first 09:00 PT after deploy (acceptable — the manual round of 2026-07-02 did not set it).
- New compose service `survey-reminder` (image `dr3-vision-app:local`, `unless-stopped`, healthcheck disabled, `auth.env` optional, depends on `app` healthy). No `db.env` — the daemon reads nothing.
- `scripts/` is already COPY'd wholesale into the runner image and there is no `.dockerignore`, so the new `.mjs` ships with no Dockerfile change.
- Idempotent by construction: the 20h DB gate makes a restart-triggered re-fire, or a slightly-early fire, a no-op; a no-op also fires cleanly when no campaign is open.
- Out of scope: reminder throttling/cap, per-recipient opt-out, SMS/other channels, reminders for closed/draft campaigns.

## Post-acceptance addendum — 2026-07-03 first-fire incident

The first production tick (2026-07-03 09:00 PT) sent nothing while logging
success. Two stacked defects:

1. **Middleware gap.** The auth middleware's public-path list exempted
   `/api/internal/bonus/` but not the new `/api/internal/survey/` prefix, so the
   session-less cron POST was 307'd to `/login`.
2. **Redirect-following masked the failure.** The daemon's `fetch` followed the
   307 to the login page, whose HTML arrived as a 200 — `res.ok` was true, so the
   daemon logged the login page as a successful tick.

Fix (same day): the predicate was extracted to `src/lib/public-paths.ts` (pure,
edge-safe, unit-tested — the whole exemption list now has a regression test) with
the `/api/internal/survey/` exemption added; the daemon POSTs with
`redirect: 'manual'` and treats any redirect or non-200 as a failure; logged
response bodies are truncated. The missed tick was re-fired manually in-network
after deploy. Lesson recorded: **every new `/api/internal/*` route family needs a
middleware exemption + a `public-paths.test.ts` case, and a session-less caller
must never follow redirects.**
