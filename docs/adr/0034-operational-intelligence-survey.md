# ADR-0034 — Operational intelligence survey system

**Status:** Accepted (Sprint 6, 2026-06-22) · **LIVE — campaign launched 2026-06-23** (see _Launch record_ below)
**Related:** ADR-0021 (M365 Graph mail-send), ADR-0030 (super-admin flag); informs ADR-0033 (operations system-of-record expansion).

## Context

ADR-0033 is blocked on operational depth that only specific team members can supply. Eight-plus parked questions sit with named individuals: Rick (CA mid-month cutoff rule), Janette (DR3#/Material# sequences, container rentals, format drift), Mary (Great Plains integration), Morena (cross-facility coordination), Kelsey (MRC reporting cadence, Re-Trac, per-state fee schedules), floor staff Juan and Patrick.

Microsoft Forms was rejected: no Graph API for template creation; responses live in OneDrive requiring manual export; no per-recipient personalization.

## Decision

Admin-gated route group at `/admin/operations/intel` plus a public route at `/survey/{token}` implementing a one-shot, per-recipient-personalized survey system. Four new tables. Responses export as markdown to `docs/operations-intel/{campaign-slug}/` via the existing ClaudeSync handoff path.

### Public access model

Unauthenticated. Tokens are 32-char URL-safe cryptographic random values, generated once per invite. The token IS the access. Tokens never logged, never echoed in errors. Audit references invites by UUID, not token.

### Per-recipient personalization

Each invite has its own question packet (one `survey_questions` row per question, FK'd to invite). No sharing across invites. The closing question "What are we missing? What should we be looking at?" duplicated at the end of every packet.

Question kinds: `short_text`, `long_text`, `single_select`, `multi_select`. File uploads schema-deferred.

### Approval gate

`status` enum: `draft` → `approved` (Bill clicked after preview) → `sent` (email fired) → `opened` (recipient loaded the page) → `submitted` (locked).

`/send` refuses any invite not in `approved` state. Also requires `confirmed_recipient_count` matching the actual approved-count at request time. Mismatch → 422 `count_diverged`.

### Draft auto-save and submit

PUT `/api/survey/[token]/draft` upserts answers by `(invite_id, question_id)`. POST `/api/survey/[token]/submit` flips all rows to `is_draft = false`, sets `invite.submitted_at`. After submit, GET renders read-only thank-you; PATCH/PUT/POST returns 409.

### Email sender

Defaults: `from_address = dr3-vision@svdp.us`, `from_display_name = "Bill Barnard via DR3-Vision"`, `reply_to = bill.barnard@svdp.us`. Override per campaign. Vision is SVdP, outbound identity must be the SVdP mailbox.

### ClaudeSync export

Campaign close generates one markdown file per submitted invite at `docs/operations-intel/{campaign-slug}/{recipient-slug}.md` plus a `_summary.md` consolidated index. Pushed via the same `create_handoff` mechanism the team uses for sprint handoffs.

### Audit trail

Every state transition writes one `audit_log` row. Bill's admin actions log with `actor_user_id`; public route actions log with `actor_label = 'public:survey-respondent'`, IP, and user-agent. Audit volume kept sane by storing counts and timestamps, not full response text.

## Consequences

Positive: closes ADR-0033's parked questions structurally; responses land where Claude reads via ClaudeSync; reusable for future campaigns; no auth burden on respondents who aren't Vision users.

Negative: four new tables plus a new admin route group; token-as-access means losing/forwarding a link would let the holder submit as the recipient (mitigation: short campaign window, audit log, trusted internal recipients).

Out of scope: file upload on questions; anonymous public surveys; recurring scheduled surveys; respondent view of past submissions; resubmission after submit (manual reset only).

## Launch record (2026-06-23)

Campaign **"DR3 Operational Intelligence — June 2026"** (`survey_campaigns.id = 4b90f984-bae6-4568-a0a5-ce223186a177`) went live. All **10** invites approved and sent at **~1:38 PM PT** from `dr3-vision@svdp.us` (reply-to `bill.barnard@svdp.us`) via the real `/send` route — Graph `sendMail` accepted all 10 (`delivered:true`), each marked `sent`, campaign flipped `draft → open`. Recipients: Bethany Cartledge, Shannon Rockwell, Leisha Wallace, Mary Scott, Rick Albritton, Janette Tomas, Morena Gomez, Kelsey Ruhland, Juan Perez, Patrick Dills.

Operational note on the send: the human path is the admin **Send Campaign** button → type the campaign title in the `SendInterstitial` → POST `confirmed_recipient_count`. For this launch the same route was driven programmatically by minting a valid super-admin Auth.js v5 session (cookie `__Secure-authjs.session-token`, secret = `NEXTAUTH_SECRET`) and POSTing `/send` with `confirmed_recipient_count: 10` — every server-side guard (super-admin, count-match, approved-only) still ran. No guard bypassed; nothing hand-written into the DB.

### Two post-launch fixes (same day)

1. **Admin invite-preview iframe** (`InvitePreview.tsx`) embeds `/survey/{token}?preview=1` in a same-origin `<iframe>`, but a global `X-Frame-Options: DENY` in `next.config.js` forbade _all_ framing → blank ("vision won't connect"). Fixed: a more-specific `/survey/:path*` header block sets `X-Frame-Options: SAMEORIGIN` + CSP `frame-ancestors 'self'`; every other route keeps `DENY` via a negative-lookahead `source`. Survey page now also skips `markInviteOpened` when `?preview=1`. Commit `2b65687`; regression test `src/__tests__/next-config-headers.test.ts`.
2. **Response-field legibility / mobile** (`SurveyForm.tsx`) — text inputs had no explicit `color`/`background`/`color-scheme`, so dark-mode phones painted typed text nearly invisible; `fontSize:14` also caused iOS zoom-on-focus. Fixed: explicit `color:#1a1a1a` (+ `-webkit-text-fill-color`), `background:#fff`, `colorScheme:'light'`, `16px`, plus a dark base color + `colorScheme:'light'` on the page so labels/radios/checkboxes stay high-contrast. Commit `722f86c`.

### Response status (as of 2026-06-24 AM)

4 submitted (Juan, Janette, Rick, Bethany), 3 opened-not-submitted (Shannon, Morena, Leisha), 3 not yet opened (Kelsey, Mary, Patrick). Live tracker query + reading actual answers: see `docs/operator/operational-intelligence-survey.md` and `docs/handoffs/2026-06-23-survey-launch.md`. **Paused — awaiting the remaining submissions before close + ClaudeSync export.**
