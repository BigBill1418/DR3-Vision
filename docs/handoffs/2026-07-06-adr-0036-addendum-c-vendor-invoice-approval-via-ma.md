# ADR-0036 Mission — Addendum C: Vendor-Invoice Approval via Mailbox Ingestion (directive for ADR-0046)

**Date:** 2026-07-05 · **Decided by:** Bill (Option B locked) · **Fills:** the last locked function (mission §2.1 hybrid B1) with no build path — how accounting's approval request enters Vision and how the decision returns.

## C1. Decision

Accounting keeps composing ordinary emails. A **dedicated shared mailbox** (proposed: `ap-approvals@svdp.us` — accounting's one-time change is the To: address) is polled by Vision via **Microsoft Graph delta query**; each valid message becomes an approval request; **Morena and Janette approve/reject inside Vision, first-action-wins (atomic)**; Vision emails the decision back to accounting automatically. This is Vision's **first inbound-email transport** — treat as ADR-0046, full ADR discipline.

## C2. Architecture constraints (locked by this directive)

- **Polling, not Graph subscriptions** — matches the established daemon pattern (thin cron script → loopback-guarded internal route → `public-paths.ts` exemption **+ regression test**, the mandatory ADR-0036 lesson). Cadence ~10 min. New profile-gated compose service, `db.env`-less daemon per house pattern.
- **Graph app**: client-credentials flow; `Mail.Read` (or `Mail.ReadWrite` for processed-folder moves) **scoped by ApplicationAccessPolicy to the single shared mailbox** — org-wide mailbox read is unacceptable. Secrets via `~/.dr3-vision-secrets/` (mymrc.env precedent).
- **Transport layer generic**: `src/lib/msgraph-mail/` reusable — Morena's parked dispatch↔Outlook ask consumes the same capability later; do NOT scope dispatch into this build.
- **Outbound decision email**: existing `sendSystemEmail` from `dr3-vision@svdp.us`. No Graph send permission.

## C3. Security posture (BEC-aware; non-negotiable)

1. **Sender allowlist as data** (`ap_senders` table, admin-editable): only allowlisted addresses create approvable requests; validation against the authenticated envelope/tenant, never display name. Initial membership: Mary Scott + addresses confirmed on Monday's call.
2. **Quarantine, never silent-drop**: non-allowlisted or parse-failed messages → quarantined items (admin-only, unapprovable) + `dr3-vision-system` page. Every polled message ends in exactly one state: request, follow-up, quarantined — never skipped.
3. **Decision replies to fixed/allowlisted addresses only — never the inbound Reply-To** (attacker-controlled).
4. Structural bound: email only *creates* a request; approval requires an authenticated Vision session (Morena/Janette/admin) reviewing the stored PDF. Residual risk = fake-invoice social engineering, identical to today's email workflow, now with provenance.

## C4. Pipeline (v1 scope, deliberately modest)

Poll delta → sender validation → persist message (body text + metadata) → download ALL attachments → R2 under `ap/` (private; bonus/COR precedent) → create `ap_requests` row, **idempotent on `internetMessageId` (UNIQUE)** → move message to Processed folder. **No PDF content parsing at v1** — approver reads the stored PDF; vendor/amount are optional ledger fields keyed at decision time. Same-`conversationId` messages while a request is open → attached as follow-up notes, not new requests. No attachment = body-only request (valid).

## C5. Approval + return path

- `ap_requests.status`: `pending → approved | rejected` via **conditional transition** (updateMany-count pattern) — loser sees "already decided by {actor} at {time}"; **both attempts audited** (0028/0041 machinery).
- Approver set as data (Morena, Janette; admin can act). New-request notification to both via `sendSystemEmail`; the ADR-0043 daily digest MAY gain a pending-AP line (implementer's call).
- Decision email to accounting: request id, subject/vendor line, decision, approver, timestamp, note. That is what Mary files against in Great Plains.
- PII: attachments may carry bank details — R2 only; logs/ntfy carry row ids, never amounts/vendor/bank data (ADR-0045 discipline).

## C6. Observability (house rules)

Poll-run ledger (the `mymrc_sync_runs` shape: per-run status ok/auth_failed/error, ALWAYS written incl. on throw) · deadman page when no successful poll > threshold · typed `AuthFailedError`/`GraphContractDriftError` · a green run that read nothing while mail exists must be impossible by construction (ADR-0038 lesson).

## C7. Schedule gate — EXTERNAL dependency, start Monday 7/6

(1) SVdP IT creates the shared mailbox; (2) Graph app registration + **tenant-admin consent** + ApplicationAccessPolicy scoping. Calendar days of IT lead time are the 8/1 risk, not code. Bill raises both Monday; Mary's call also confirms the allowlist + the new To: address.

## C8. D-items for Bill at ADR-0046 review

D1 mailbox name (`ap-approvals@svdp.us` proposed) · D2 allowlist membership · D3 poll cadence (10 min proposed) · D4 quarantine notification target (admin + ntfy proposed) · D5 whether approved-request ledger backfills vendor/amount as required-at-decision or optional (optional proposed) · D6 Mail.Read + folder-category vs Mail.ReadWrite + move (ReadWrite/move proposed — cleaner idempotency).

**Numbering:** next free ADR = **0046**. Staff-email commitment ("approval requests from accounting will route to Morena and Janette through Vision") is satisfied by this build.



---

## C9. D-item resolutions (locked by Bill, 2026-07-06)

| D | Decision |
|---|---|
| D1 | Mailbox: **`approvals-dr3@svdp.us`** |
| D2 | Sender validation: **tenant-wide** — any authenticated `@svdp.us` internal sender creates an approvable request. Implement `ap_senders` with a **mode flag** (`tenant_wide` \| `explicit_list`), default `tenant_wide` per this decision; tightening to an explicit allowlist is an admin toggle, never a code change. Rationale accepted: matches today's trust model (any internal account can email an approver a fake invoice now; a human still reviews before any decision). Quarantine ring therefore covers **external senders + unprocessable messages** only. |
| D3 | Poll cadence: **10 minutes** |
| D4 | Quarantine notification: **admin queue + email to Bill** (via `sendSystemEmail`; row id + sender domain only in the email — no body content, no attachment names) |
| D5 | Vendor/amount at decision: **optional** — heterogeneous input (see C10) makes required fields friction; stored PDF-or-body is the record; the decision email echoes original subject + request id for Mary's Great Plains matching |
| D6 | Graph permission: **`Mail.ReadWrite` + move-to-Processed-folder** idempotency |

## C10. Heterogeneous input handling (spec change, Bill 2026-07-06)

Requests arrive as **PDF-attachment emails OR bare forwarded emails** — both are first-class:

1. **Body is a first-class record.** Persist full body (HTML + text); the approval queue renders it alongside any attachments. A no-attachment forward is a complete, approvable request.
2. **⚠ SECURITY — sanitize before render (non-negotiable).** Email HTML is untrusted input rendered inside an authenticated dashboard = stored-XSS vector into an approver's session. Server-side sanitization (allowlist-based, e.g. sanitize-html/DOMPurify-server) or sandboxed-iframe rendering with strict CSP; raw email HTML must never execute in the app origin. Regression test: a script-bearing fixture body renders inert.
3. **Complete Graph attachment taxonomy:** `fileAttachment` → R2 under `ap/`; `itemAttachment` (nested forwarded message) → unwrap ONE level (subject/body/its file attachments), deeper nesting stored as-is with a visible "nested message" marker; `referenceAttachment` (OneDrive/SharePoint link) → record the link for the approver, **never fetched** by Vision.
4. **Sender-auth nuance for forwards:** tenant validation applies to the internal **forwarder** (the authenticated envelope); the original external vendor address inside the forwarded body is display context only, never an auth input.
5. Decision email to accounting always carries: request id, original subject, decision, approver, timestamp, optional note — sufficient for GP matching under any input shape.

**IT asks go out today (C7):** shared mailbox **`approvals-dr3@svdp.us`** + Graph app registration with tenant-admin consent + ApplicationAccessPolicy scoped to that mailbox.
