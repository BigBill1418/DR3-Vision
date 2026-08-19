# ADR-0114 — A refusal is not a delivery

- **Status:** Accepted, implemented 2026-08-19 (Pacific)
- **Context:** AP request `acb03895-9aac-4494-80c7-dca548b70837` was decided
  (rejected) on 2026-08-19 at 11:29 AM Pacific and accounting was never told. The
  `oversize` refusal fired exactly as designed; there was no transport that could
  have carried the mail it refused.
- **Supersedes / amends:** nothing. Extends ADR-0021 (the Graph mail transport and
  its retry policy) and ADR-0046 §3 (the stamped AP decision mail). Interacts with
  ADR-0047 (`notifyStaff` as the staff-mail chokepoint).

## Context

On 2026-08-19 an approver rejected a six-attachment vendor invoice. The decision
committed, the stamped artifacts were rendered and archived, and the decision mail
was **refused before it was posted**: the stamped attachments totalled 4,146 KB
against a 3,072 KB ceiling. `decision_mail_sent_at` correctly stayed NULL, ntfy
correctly paged, and Mary correctly received nothing.

Every part of that behaved as specified. The problem is what the specification
left out.

### Why the shrink ladder did not save it

The obvious first theory — "the shrink ladder has a bug, or hit the
vector-can't-rasterise case" — died on the first measurement, and it died in a way
worth recording, because the evidence *looked* like it supported the theory.

The repo genuinely has a shrink ladder, and CI genuinely runs tests named
`the size budget is enforced, and failing it is VISIBLE` and
`a VECTOR receipt is never rasterised — there is no scan to re-encode`. Both of
those tests are in **`src/lib/reimbursements/pdf.test.ts`**. The ladder itself —
`COMPOSED_PDF_BUDGET_BYTES`, `MIN_EFFECTIVE_DPI`, `shrinkToBudget` — lives in
`src/lib/reimbursements/pdf.ts` and is called from exactly one place: the sibling
function in its own file that renders the **reimbursement** decision PDF.

`acb03895` is an **AP** request. Nothing on the AP decision path imports that
module, and nothing on it measures a byte count at all. A green test name is not
evidence about a path it was never pointed at.

The ladder could not have been ported to save this one either, and the arithmetic
is the reason:

| attachment | original | kind | stamped |
| --- | ---: | --- | ---: |
| `DR3 Invoices.pdf` | 85.1 KB | vector PDF | ~85 KB |
| `35.jpg` | 2,077.8 KB | JPEG scan | ~1.3 MB |
| `5340.jpg` | 2,271.8 KB | JPEG scan | ~1.4 MB |
| `285859.jpg` | 2,306.4 KB | JPEG scan | ~1.4 MB |
| `image001.jpg` / `image002.jpg` | 22.1 / 20.1 KB | signature logos | not stamped |

Six rows on the request, `stamped_count: 4` in the audit row — the two small
signature images are filtered out before stamping. The three big files are JPEG
scans, so this is **not** the vector case; they are rasterisable in principle.

But the ladder is a **per-document** budget, and the failure is a **whole-message
sum**. The AP path does not compose one PDF; it stamps each original separately
and attaches N of them. Four attachments at the reimbursement path's own 1.6 MB
budget would still be 6.4 MB against a 3 MB ceiling. A per-file ladder cannot fix
a sum, and driving each file low enough that four of them fit under 3 MB would put
a 9 pt invoice line somewhere around 4 pt — the "picture of a receipt rather than a
readable one" outcome `reimbursements/pdf.ts` already refuses to ship.

So the ladder is not the missing piece, and this is not a ladder bug.

### What was actually missing

`sendSystemEmail` posted every message as a single
`POST /users/{mailbox}/sendMail` with each attachment base64-encoded into
`contentBytes`. That is Microsoft's **small-message** shape, and Graph accepts it
only below 3 MB.

Microsoft documents a second shape for anything larger: create a draft, attach each
file to it individually — via an upload session for files that need one — then send
the draft. **That half was never built.** The `oversize` guard was written as though
the 3 MB inline limit were the ceiling on what could be emailed at all, when it is
only the ceiling on what fits in one request.

That is why the refusal, though correct, was not the whole story: re-sending
`acb03895` through the existing transport could never have worked, at any time, no
matter how many times it was retried.

## Decision

Build the second half. `sendSystemEmail` remains the single chokepoint and decides
the shape internally from the measured size; callers are unchanged.

1. **Under the inline ceiling** — unchanged. One `sendMail` POST. The shrink ladder
   still runs first on the paths that have one, and still earns the simple
   transport; the session path is a floor under it, not a replacement.
2. **Between the inline ceiling and the mailbox limit** — draft path:
   `POST /messages` → attach each file → `POST /messages/{id}/send`.
3. **Above the mailbox limit** — the `oversize` refusal, which now names the
   ceiling that was actually exceeded.

### The one fact that shapes the whole design

Graph **refuses** `createUploadSession` for a file under 3 MB, with
`ErrorAttachmentSizeShouldNotBeLessThanMinimumSize`. The upload session is
documented for files "between 3 MB and 150 MB".

This kills the intuitive implementation. "The message is oversize, so send it via
an upload session" would open a session per attachment — and for `acb03895`, whose
four stamped artifacts are 85 KB / ~1.3 MB / ~1.4 MB / ~1.4 MB, **not one reaches
3 MB**, so Graph would reject every single one. The message is oversize by their
*sum*; no individual file is large.

So each attachment is routed by **its own** size, exactly as Microsoft instructs
("choose the approach for each file based on its file size"):

- `size < 3 MB` → `POST /messages/{id}/attachments` (a `fileAttachment` with
  `contentBytes`);
- `size >= 3 MB` → `createUploadSession`, then ranged `PUT`s.

`acb03895` therefore takes the draft path with **four direct attachment POSTs and
zero upload sessions** — and that is precisely what fixes it. The draft is what
lifts the ceiling, because each attachment is added in its own request instead of
sharing one 3 MB budget.

### The ceiling that replaced it

The real limit is now Exchange Online's per-message send limit, not a Graph request
limit: **35 MB** by default for a Microsoft 365 mailbox, admin-raisable toward
Graph's 150 MB attachment maximum. It is read from `M365_MAIL_MAX_MESSAGE_BYTES`
and clamped to `[3 MB, 150 MB]`, so raising the tenant limit does not need a deploy
and a typo cannot install a ceiling that is either unsendable or a lie. Base64
inflation is still charged against it — Exchange's limit applies to assembled MIME.

`OversizeAttachmentReport` gains a `ceiling` discriminant (`'graph-inline'` |
`'exchange-message'`) so the refusal says *which* limit was hit rather than making
the reader infer it from a number. Every operator-facing message — the AP ntfy, the
payroll ntfy, the reimbursement problem line — now says "per-message limit on the
sending mailbox" instead of "what Microsoft Graph accepts inline", because sending
someone to shrink a file that is already well inside Graph's limits is a wrong
instruction, not merely an imprecise one.

### Chunking

Ranges are contiguous and inclusive (`bytes {start}-{end}/{total}`, last `end` is
`total - 1`), capped at 3.75 MiB — under Graph's 4 MB per-`PUT` limit, and a
multiple of the conventional 320 KiB quantum so a boundary rounding error cannot
push a range over. The `PUT`s go through a raw `fetch`, **not** the Graph client:
the `uploadUrl` is pre-authenticated on `outlook.office.com` and Microsoft is
explicit that an `Authorization` header must not be added — which the Graph client
would do.

### Failure honesty

A draft is real, persistent mailbox state, so the draft path is not merely
"try harder":

- `delivered` is true **only** after the `send` action returns cleanly. The AP
  caller stamps `decision_mail_sent_at` from it, and that column has to mean *Mary
  was told*, not *we tried* — the same discipline `sent_to_accounting_at` is held to
  on the reimbursement path.
- Any failure after draft creation **deletes the draft** before returning, using a
  fresh retry session so cleanup is not skipped because the send that preceded it
  exhausted the budget. Otherwise a failed send leaves a half-built message in
  Drafts that a person could send by hand or a retry could duplicate.
- If the cleanup itself fails, it is logged loudly as an orphaned draft and the
  send is **still** reported as failed. An orphaned draft is a mess a person can
  clean up; a delivery that did not happen reported as one that did is not
  recoverable at all.

The ADR-0021 retry policy (5 backoff retries on 429/503/504/network, one credential
refresh on 401, immediate surface on 400/403) now lives in one shared retry session
used by **both** transports, with the budget scoped per *send* rather than per
call — so a draft flow that burns its retries creating the draft does not get a
fresh five for the upload. The inline path was collapsed onto it rather than
duplicated, because two copies of a retry policy is how they drift.

## Consequences

- Messages between 3 MB and 35 MB are now deliverable. `acb03895` is deliverable.
- `too_large` remains a real outcome and is deliberately **not** deleted — a limit
  still exists, and a refusal with nowhere to be reported is how the original
  silence happened. It should now be rare rather than routine.
- Three tests in `m365-mail.test.ts` asserted "over the inline ceiling ⇒ refused".
  That was the defect pinned as a contract. They are rewritten to assert the
  *measurement* (still load-bearing — it picks the transport) rather than the
  refusal, with comments recording what changed and why.
- The draft path issues N+2 Graph calls where the inline path issued one. For the
  AP decision mail (typically 1–6 attachments) that is 3–8 calls on a path that
  runs a few times a day.
- `Mail.ReadWrite` (application) is required to create a draft and an upload
  session. **It is already granted** — assignment `WXZ4dqj5SE-Ww9DXfScZ_j3aOH99GORNgYDxvb-Oiyo`,
  RoleId `e2a3a72e-5f79-4c64-b1b1-878b674786c9`, granted 2026-07-09 for the ADR-0046
  mailbox ingestion. No operator action is needed. The mailbox must be in scope of
  the existing ApplicationAccessPolicy, which it is, since the same app already
  sends as it.

## Alternatives considered

**Port the reimbursement shrink ladder to the AP path.** Rejected as a *fix* —
per-file shrinking cannot resolve a whole-message sum, and four attachments shrunk
enough to fit under 3 MB would be illegible. Still worth doing on its own merits
one day (a smaller attachment is better even on the session path), but it is an
optimisation, not the floor. Recorded as a follow-up rather than done here, because
shipping it *as* the fix would have left the transport gap open.

**Compose the N stamped artifacts into one PDF, then shrink it.** Rejected: it
destroys the per-original `sha256` tamper records that ADR-0046 Amendment 4 exists
to produce, and the AP decision mail's whole point (2026-07-15 directive) is that
accounting receives *the actual documents*.

**Link to the artifacts in Vision instead of attaching them.** Rejected: accounting
works from the mail, and the 2026-07-15 reversal that made attachments win over the
body render was driven by exactly this. It also re-creates the "the receipt is in
Vision, go look" problem `reimbursements/pdf.ts` was changed to eliminate.

**Raise the Exchange message limit and keep posting inline.** Does not work — the
3 MB limit is on the Graph *request*, not the mailbox, and no tenant setting moves
it.

## Falsification

Naive-fails-first, run against the real module (failures quoted in the PR):

- Route every oversize attachment through `createUploadSession` (the intuitive
  design, ignoring Graph's 3 MB floor) → **3 failed**, including
  `expected false to be true` on the assertion that no session is opened for the
  acb03895 shape.
- Chunk ranges with an exclusive end (the off-by-one) → **5 failed**, including
  `expected 10485760 to be 10485759` and
  `expected [ { start: +0, end: 100 } ] to deeply equal [ { start: +0, end: 99 } ]`.
  The strict fetch double rejects the bad range rather than accepting a corrupt
  upload.
- Remove the draft cleanup → **2 failed**:
  `expected [ …(2) ] to include 'DELETE /users/dr3-vision@svdp.us/mess…'`.
- Restore the pre-change transport (refuse anything over the inline ceiling) →
  **13 failed**, including `expected 'refuse' to be 'upload-session'` and
  `expected 'graph-inline' to be 'exchange-message'`.

## Follow-ups

- **FU-0114-1** — port a shrink pass to the AP stamped-attachment path, so the
  simple inline transport is used more often. Optimisation, not a correctness gap.
