# ADR-0034 — Operational intelligence survey system

**Status:** Accepted (Sprint 6, 2026-06-22)
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
