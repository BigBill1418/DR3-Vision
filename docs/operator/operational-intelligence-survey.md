# DR3 Operational Intelligence Survey — Operator Runbook

## Purpose

Vision's survey system gathers structured operational intelligence from named DR3 team members and adjacent functions. Designed for the one-shot ADR-0033 intelligence campaign but reusable for future campaigns (annual ops reviews, post-incident retrospectives, vendor surveys).

## URLs

- Admin: https://dr3-vision.svdp.us/admin/operations/intel (super-admin only)
- Public (per invite): https://dr3-vision.svdp.us/survey/{token}

## Workflow

### 1. Open the seeded campaign

After migration + seed runs, navigate to /admin/operations/intel and click on "DR3 Operational Intelligence — June 2026" (status: draft).

You'll see 10 invites pre-populated with role-specific question packets. Each invite starts in status `draft`.

### 2. Per-invite review

For each invite, in any order:

a. Click the invite row to open the editor.
b. Review the recipient_name, recipient_email, role_label — edit if needed.
c. Review the question packet. Each question shows: position, kind (short_text/long_text/single_select/multi_select), prompt, optional description, options (for select kinds), required flag.
d. Edit individual questions if needed. Add, remove, or reorder questions.
e. When satisfied, click "Preview".
f. The preview modal shows two tabs:

- **Email preview** — the EXACT email the recipient will receive, with sender display name, reply-to, and subject visible above the rendered body.
- **Survey page preview** — the EXACT survey page the recipient will see when they click the link.
  g. If anything's off, click "Edit questions" and adjust. The invite stays in `draft` until you approve.
  h. When everything looks right, click "Approve". Invite moves to status `approved`.

If you edit questions on an `approved` invite, approval clears back to `draft` and you must re-preview and re-approve.

### 3. Send the campaign

Once all 10 invites are `approved`:

a. Click "Send Campaign" on the campaign header.
b. A confirmation interstitial shows the count: "You are about to send 10 emails to 10 recipients."
c. Review the recipient list.
d. Type the campaign title into the confirmation input to enable the Send button.
e. Click "Send 10 emails".

The interstitial shows per-recipient progress (spinner / ✓ / ✗). On any failure, the failed invites stay in `approved` state — they can be retried by hitting Send again (the count auto-recalculates).

### 4. Monitor responses

The campaign detail page shows each invite with its current status (sent → opened → submitted). Bill receives no email when responses come in — check the page periodically.

### 5. Close the campaign

When enough responses are in (or when the response window ends), click "Close Campaign". The campaign moves to status `closed` and the markdown export generates.

The export pushes via ClaudeSync to `docs/operations-intel/dr3-intel-2026-06/` — one .md per submitted respondent plus a `_summary.md`.

### Emergency procedures

- **Recipient says they need to amend a submitted response**: open the invite in the admin UI and manually clear `submitted_at` from the database (no UI button for this by design — friction is intentional). Document the reason in the campaign notes.
- **Wrong email sent to wrong person**: the token is unique per invite; revoking access means setting the invite status to a state where the token is rejected. Manual SQL: `UPDATE survey_invites SET token = '<random>' WHERE id = '...'`.
- **Campaign needs to be paused mid-flight**: there's no pause; do not click "Send Campaign" again. Already-sent invites can complete; un-sent invites stay in `approved` until you send.
- **Need to add a recipient mid-campaign**: add the invite as normal (draft → approved → send). The /send endpoint will only target approved-but-unsent invites.

### Diagnostic queries

```sql
-- Per-recipient state across the campaign
SELECT recipient_name, role_label, status, sent_at, first_opened_at, submitted_at
FROM survey_invites
WHERE campaign_id = (SELECT id FROM survey_campaigns WHERE slug = 'dr3-intel-2026-06')
ORDER BY recipient_name;

-- Response counts per invite
SELECT i.recipient_name, COUNT(r.id) AS response_count
FROM survey_invites i
LEFT JOIN survey_responses r ON r.invite_id = i.id AND r.is_draft = false
WHERE i.campaign_id = (SELECT id FROM survey_campaigns WHERE slug = 'dr3-intel-2026-06')
GROUP BY i.recipient_name ORDER BY i.recipient_name;
```

## Launch status — LIVE (2026-06-23)

The `dr3-intel-2026-06` campaign is **live**: all 10 invites sent 2026-06-23 ~1:38 PM PT from `dr3-vision@svdp.us`. Sending is gated — the **Send Campaign** button requires typing the campaign title and the server re-verifies `confirmed_recipient_count == approved-count`; only `approved` invites are emailed. As of 2026-06-24 AM: 4 submitted, 3 opened, 3 not yet opened. **Paused — close the campaign (which triggers the ClaudeSync markdown export) once enough responses are in.** Full launch record, the live PT-converted tracker query, and how the send was driven: `docs/handoffs/2026-06-23-survey-launch.md`.

### Nudge round — 2026-07-02 (PT)

Standing at 7/10 submitted (Shannon Rockwell came in 2026-07-02 9:20 AM PT), Bill directed a
nudge round for the three outstanding invites. All three sends were accepted by Graph (202),
same branded shell, from `dr3-vision@svdp.us` as "Bill Barnard via DR3-Vision", reply-to
`bill.barnard@svdp.us`, existing tokens re-linked (no token rotation, no DB mutation —
`sent_at`/status untouched, so the diagnostic queries above still reflect the ORIGINAL send):

- **Leisha Wallace** (opened 6/23, zero answers) — "Reminder:" subject, nudge copy.
- **Kelsey Ruhland** (opened 6/24, 10 answers saved) — "Reminder:" subject, copy notes her
  progress is saved and waiting; button reads "Finish your survey".
- **Mary Scott** (never opened) — original subject + original intro re-sent, prefixed with a
  "resending in case the June 23 original didn't reach you" line. If this one also shows no
  open, assume delivery/filtering trouble and switch channels (hallway ask / different address)
  rather than sending a third copy.

Mechanics: the app has no resend endpoint (adding one is a candidate follow-up if a second
round is ever needed); the sends were driven by a one-off zero-dependency Node script executed
inside `dr3-vision-app` on CHAD-HQ (env supplies the Entra creds), replicating
`sendSystemEmail`'s Graph `POST /users/{from}/sendMail` call and the ADR-0034 invite shell
verbatim. Script was deleted from the host and container after the run (it embeds live tokens).

### Automated daily reminders — 2026-07-03 (ADR-0036)

The manual nudge round is now a standing system. The `dr3-vision-survey-reminder` container
(compose service `survey-reminder`) fires **once a day at 09:00 PT** and, for every OPEN
campaign, sends **one reminder per unsubmitted invite per day** until they submit — the same
three tiers as the manual round, chosen automatically from each invite's live state:

- opened with saved answers → "your progress is saved", button _Finish your survey_
- opened but nothing saved → friendly nudge, button _Open your survey_
- sent but never opened → original subject + a "resending in case it got buried" line

A 20h database gate means a container restart or a slightly-early fire never double-sends. When
the **last** response comes in (every invite is `submitted`, with only drafts remaining), the
campaign **auto-closes** and Bill gets one `dr3-vision-system` ntfy — then export as usual with
the admin **Export** button (auto-close does NOT export for you).

### Campaign log — 2026-07-03 (PT)

- **First tick (09:00 PT) silently failed** — the auth middleware was missing the
  `/api/internal/survey/` exemption and the daemon followed the login redirect to a 200, so it
  logged success while sending nothing. Fixed same-day (PR #40 `23e27e8`, three-layer hardening;
  see the ADR-0036 addendum). The missed tick was re-fired manually in-network after the deploy.
- **Kelsey Ruhland — operator-submitted 9:41 AM.** She had answered all 10 questions in draft
  and told Bill she'd submitted (saving ≠ submitting). On Bill's direction her invite was
  finalized through the real public submit route (`POST /api/survey/<token>/submit`), so the
  normal audit + status transition applied. UX follow-up candidate: the thank-you/submit
  distinction clearly reads as "done" before the final submit.
- **Leisha Wallace — WITHDRAWN on Bill's direction** (input no longer needed). Applied directly
  on prod with an audit row under Bill's admin user: `status='withdrawn'` + **token rotated**
  (her original link now 404s). `withdrawn` is a terminal operator status: it is not in the
  reminder pool (`sent`/`opened`) and does not block auto-close (`approved`/`sent`/`opened` do).
  Use this same recipe to pull any recipient out of a live campaign.
- **Standing after the above: 8 submitted · 1 withdrawn (Leisha) · 1 outstanding (Mary Scott).**
  Mary gets one reminder per day; her submission triggers auto-close + the ntfy.

**How to stop the reminders** (they are unbounded by design — daily until complete):

- Preferred: **Close the campaign** in the admin UI (`/admin/operations/intel/<campaign>`).
  Reminders only touch OPEN campaigns, so closing stops them immediately.
- Or stop the daemon: `docker stop dr3-vision-survey-reminder` (stops reminders for ALL
  campaigns until it is started again).

First automated reminders fire at the first 09:00 PT after deploy (`last_reminder_at` starts
NULL; the 2026-07-02 manual round did not set it).
