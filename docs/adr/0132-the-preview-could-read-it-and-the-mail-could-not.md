# ADR-0132 — The preview could read it and the mail could not

- **Status:** Accepted, implemented 2026-09-15 (Pacific)
- **Date:** 2026-09-15 (Pacific)
- **Context:** Bill, 2026-09-15 15:27 PT — _"in the AP approval module - I am being
  told that when the accounting team gets the approval via email that the original
  invoice is NOT attached with the stamped decisions on them - is that true ? if so
  how did that happen ? this needs to be the case all the time"_
- **Follows:** ADR-0046 §3 + Amendment 4 (stamped originals), ADR-0046 Amendment 6
  (the tolerant inline-preview gate), ADR-0114 (a refusal is not a delivery),
  ADR-0126 (a decision nobody received), ADR-0129 (the first 0126 digest)
- **Grading:** ADR-0036 (transport), ADR-0037 (noise), ADR-0047 (rollout gate)

## Context

The report is **true, for a specific and identifiable minority of invoices**, and
the mechanism is not the one anybody would have guessed. It is not the transport,
not a size cap, not the rollout gate, and not a refactor that removed the feature.
The attachment code works. It is dispatched on the wrong fact.

### What the decision mail is supposed to carry

`sendDecisionEmail` (`src/lib/ap/approvals.ts`) builds the decision notice, calls
`buildDecisionStamp`, and attaches whatever it returns:

```ts
...(artifacts && artifacts.length > 0
  ? {
      attachments: artifacts.map((a) => ({
        filename: a.filename,
        buffer: a.pdf,
        contentType: 'application/pdf',
      })),
    }
  : {}),
```

`buildDecisionStamp` is **attachment-first** by deliberate design (the 2026-07-15
operator directive, recorded in its own docstring: _"the decision mail returns the
ACTUAL approved/rejected document — so REAL FILE ATTACHMENTS WIN"_). For each real
file attachment it calls `stampOneOriginal`, which picks a render path:

```ts
const ct = (att.content_type ?? '').toLowerCase();
...
if (ct === 'application/pdf') {
  result = await stampOntoOriginalPdf(bytes, input);      // TRUE overlay on the invoice
} else if (/^image\/(png|jpeg|jpg|webp)$/.test(ct)) {
  result = await stampImage(input, bytes, ct, renderer);  // TRUE overlay on the scan
} else {
  result = await stampApproval(input, renderer);          // COVER PAGE — no invoice
}
```

The first two branches return the customer's actual document with the decision
stamped onto every page. **The third returns a one-page DR3 cover sheet that
contains none of the invoice** — its entire body is this (`src/lib/ap/stamp.ts`):

> This stamped cover accompanies the original attachment, which is not modified.
> **Retrieve the original via the DR3-Vision AP queue.**

That sentence is the defect, stated in the product's own words. When the cover page
is the only artifact, accounting receives a decision notice, a PDF that looks
official, and no invoice — and is told to go and fetch it themselves.

### Why the third branch runs on real PDFs

`content_type` is Microsoft Graph's declared value, persisted verbatim at ingest
(`src/lib/msgraph-mail/normalize.ts` → `src/lib/ap/ingest.ts:205`). It is chosen by
the **sending mail client**, not by us, and a number of senders and relays label a
PDF `application/octet-stream`. Live distribution across all 334 AP file
attachments on 2026-09-15:

| `content_type`             | rows | render path                       |
| -------------------------- | ---- | --------------------------------- |
| `application/pdf`          | 155  | true overlay                      |
| `image/jpeg`               | 116  | true overlay (or inline-filtered) |
| `image/png`                | 48   | true overlay (or inline-filtered) |
| `application/octet-stream` | 15   | **cover page**                    |
| `text/csv`                 | 8    | **cover page**                    |

Every one of those 15 `application/octet-stream` rows has a `.pdf` or `.PDF`
filename. They are ordinary vendor invoices that a mail client failed to label.

### We already knew this, and we already fixed it — once

On 2026-07-22, commit `6efa5963` (PR #165, ADR-0046 Amendment 6) fixed **exactly
this mislabelling** — for the desktop preview. It created
`src/lib/ap/inline-preview.ts`, whose header says so verbatim:

> Why a filename fallback: MS Graph's `contentType` is persisted verbatim at ingest
> (`normalize.ts`), and some senders/relays mislabel PDFs as
> `application/octet-stream` (confirmed live: 2 of 41 file attachments) or
> parameterize as `application/pdf; name="inv.pdf"`. The old anchored
> `^application/pdf$` gate rejected both, hiding the Preview button entirely
> (download-only) — read by approvers as "can't see the invoice."

It exported `normalizeMime`, `isInlinePdf` and `isInlineImage` as a **pure module
with no server-only imports, specifically so both surfaces could share them.** Two
surfaces adopted it: `ApQueueClient.tsx` and the attachment route.
`src/lib/ap/approvals.ts` never did — it does not import `inline-preview` at all,
and still runs the anchored comparison the amendment was written to retire.

So the two halves of the AP module disagree about what a PDF is:

- The **approver's preview** uses the tolerant predicate → the invoice renders in
  the queue. The approver sees the document, approves it, and has no reason to
  suspect anything.
- The **decision mail** uses the anchored predicate → the same file is classed
  unrenderable and reduced to a cover page.

That asymmetry is why this survived seven weeks with nobody noticing: the one
person positioned to catch it is looking at the surface that works.

`decision-mail.ts` — written for the ADR-0126 sweep — names this exact hazard in
its own header (_"Two copies of that rule drift, and a badge that disagrees with
the alarm teaches operators to trust neither. So the rule lives here once and both
import it."_). The lesson was applied to the unsent-predicate and not to the
content-type predicate beside it.

### What production shows

`ap_notify` is **`live` at both sites since 2026-07-15 19:25 UTC** (`rollout_surfaces`),
so these are real sends to the real accounting roster, not pilot reroutes. Mail
delivery itself is healthy — every `[notify-staff] send decision` line in the
current container's logs reads `mode:"live"`, `delivered` equal to `intended`,
`disabled:false`, `oversizeRefused:false`.

Of **131 decided requests that carried file attachments**, 23 had at least one
attachment reduced to a cover page, and **9 received nothing but cover pages** —
accounting got no invoice at all. In every one of the 9 the only other attachment
was `image001.jpg`, an Outlook signature logo under 50 KB, correctly dropped by the
inline-image filter:

| Decided (PT)     | Vendor                          | Filename                                        | `content_type`             | Bytes   |
| ---------------- | ------------------------------- | ----------------------------------------------- | -------------------------- | ------- |
| 2026-09-09 15:05 | InterState Oil Co               | `2026.PDF`                                      | `application/octet-stream` | 71,420  |
| 2026-09-03 09:43 | Vulcan Incorporated             | `Invoice # 117075.PDF`                          | `application/octet-stream` | 25,990  |
| 2026-08-14 13:21 | Ramos Oil                       | `Invoice_IN-0320844.PDF`                        | `application/octet-stream` | 98,592  |
| 2026-08-13 05:35 | Ramos                           | `Invoice_IN-0323145.PDF`                        | `application/octet-stream` | 98,583  |
| 2026-08-07 12:10 | United Truck And Trailer Repair | `invoice-for-order-S-516386.pdf`                | `application/octet-stream` | 235,030 |
| 2026-07-30 09:36 | (not recorded)                  | `8720156898_20260716_…_nocal_6455.pdf`          | `application/octet-stream` | 877,659 |
| 2026-07-28 05:44 | (not recorded)                  | `invoice-for-order-S-516366.pdf`                | `application/octet-stream` | 233,596 |
| 2026-07-27 12:01 | Ramos Oil                       | `Invoice_IN-0312251.PDF`                        | `application/octet-stream` | 98,755  |
| 2026-07-27 12:01 | Ramos Oil                       | `Invoice_IN-0312251.PDF` (duplicate submission) | `application/octet-stream` | 98,755  |

All nine fall after both commits, in the window where preview worked and mail did
not. The other 14 of the 23 had a genuine PDF or image sibling, so accounting
received a correctly stamped invoice **plus** a cover page for the mislabelled or
CSV file — less harmful, still confusing.

The deployed image is commit `78bf2d2`; `git diff 78bf2d2 faa8969 -- src/lib/ap/`
is empty, so the running code is the code analysed here, and the anchored
comparison sits at line 1473 of the deployed file.

### The three silences

The dispatch is the cause of the 9. It is not the only way this mail can leave
without the invoice, and the other two are worse because they leave no trace:

1. **The `else` branch logs nothing.** It is an ordinary code path, not an error.
   Container logs for the last 30 days contain **zero** `ap-approvals` lines. The
   cover-page substitution is completely invisible.
2. **`buildDecisionStamp` is wrapped in `.catch(() => null)`**, and the comment
   says the quiet part out loud: _"mail proceeds without attachment"_. A render
   failure sends accounting a decision notice with **no attachment whatsoever**,
   behind a single `log.warn`, and still stamps `decision_mail_sent_at`.
3. **`stampOneOriginal` returns `null`** when the original bytes cannot be fetched
   from R2, and the caller silently degrades to the body render or a cover page.

In all three the row ends up looking successfully delivered. That is precisely the
indistinguishable-from-success shape ADR-0126 exists to end — ADR-0126 closed it
for _mail that never left_, and left open _mail that left without the thing it was
sent to carry_.

## Decisions

**D1 — The stamped original invoice rides the decision email every time.** This is
Bill's directive and it is now the module's contract, not a best effort. Accounting
must never be told to go and fetch the invoice themselves. The sentence _"Retrieve
the original via the DR3-Vision AP queue"_ is deleted from the standalone case.

**D2 — One content-type predicate for the whole AP module.** `approvals.ts` imports
`isInlinePdf` / `isInlineImage` / `normalizeMime` from `src/lib/ap/inline-preview.ts`
and the anchored comparisons are deleted. The module is already pure and already
the shared source of truth for the preview surfaces; this makes the mail the third
consumer instead of the one holdout. Fixes all 9 observed cases and the
`application/pdf; name="inv.pdf"` parameterized form we have not yet seen but
will.

**D3 — Bytes outrank both MIME and filename.** We already hold the original bytes
when we dispatch (`getApAttachmentBytes` runs first). Sniff them: `%PDF-` → PDF;
`\x89PNG\r\n\x1a\n` → PNG; `\xFF\xD8\xFF` → JPEG; `RIFF….WEBP` → WebP. Resolution
order is **sniff → MIME → extension**. A sender can mislabel a type and misname a
file; it cannot forge the leading bytes of its own attachment. D2 alone would fix
today's 9; D3 is what stops the next variant, including a `.pdf` that is really a
scan and a `.PDF` that is really a Word document.

**D4 — A cover page never travels alone.** For a genuinely non-overlayable
original — a CSV, a spreadsheet, a Word document, an unknown binary — we keep the
stamped cover page (it carries the decision, approver, site and dual-sha record)
**and attach the original file itself alongside it**, under its own filename and
its corrected content type. The decision is stamped, the invoice is present, and
accounting opens one message. This is what makes D1 true for _every_ type rather
than only the two we can overlay, and it is the only part of this ADR that changes
what a correct send looks like today: the 8 `text/csv` rows are correct-by-design
under the current code and still wrong under D1.

**D5 — If the original cannot be attached, the mail does not go. It fails loud.**
The `.catch(() => null)` that sends an attachment-free decision notice is removed.
When a request **has** file attachments and we cannot produce a stamped original
for any of them, `sendDecisionEmail` returns a new outcome **`refused_no_original`**:
nothing is sent, `decision_mail_sent_at` stays NULL, and a `dr3-vision-system` page
fires. This deliberately reuses machinery that already exists rather than inventing
any: a NULL stamp on a decided row is exactly the state
`isDecisionMailUnsent` / `isDecisionMailStuck` already watch, so the row
automatically appears in the AP queue's "decided but unmailed" badge and in the
06:00 ADR-0126 digest, and the existing re-send button is already the repair.

The grading follows ADR-0037 on its own terms: an invoice whose decision never
reached accounting is real money stuck, so it is worth naming within the hour, but
it is not customer impact now and not data loss — **`high`, not `urgent`**.
Fingerprint `ap-decision-mail-no-original:<requestId>` (per request, so a distinct
invoice always pages and a retry does not), cooldown 6 h to match the sibling
config-class alarms.

The body-only invoice keeps working exactly as today — a forwarded message with no
file attachment legitimately renders the sanitized body, and `refused_no_original`
does not apply to it.

**D6 — The 9 are repaired by re-send, after Bill's go.** `POST /api/ops/ap/{id}/resend`
re-runs `sendDecisionEmail`, which rebuilds the artifacts from R2 under the fixed
dispatch — so once this ships, re-sending the 9 request ids delivers each properly
stamped invoice with no data entry and no migration. It is **not** automatic:
accounting will receive a second message for an invoice they already actioned, so
Bill decides whether they get a heads-up first, and whether all 9 or only the
recent ones are worth re-sending. Recorded in `docs/OPEN-ITEMS.md` § 0.BU.

**D7 — The regression test asserts the delivered bytes, not the type table.** The
test that keeps this fixed must assert that the mail's attachment set **contains
the original document's bytes**, for each shape observed in production. A test that
asserts "octet-stream is in the accepted-types list" would pass forever while the
attachment silently regressed, which is how a pin goes vacuous.

## Alternatives considered

- **Normalize `content_type` at ingest.** Rejected. It corrupts the audit record:
  `ap_attachments.content_type` is what the sender actually said, and ADR-0046's
  dual-sha tamper record is built on preserving what arrived. It also cannot repair
  the 334 rows already stored, and it moves the guess earlier rather than removing
  it — D3 resolves the type where the bytes are, at the moment of use.
- **Attach the raw original unstamped and drop the overlay.** Rejected — it throws
  away the feature. The stamp is the point: accounting's copy is the evidence of who
  approved what, when, and against which site.
- **Keep the cover page and add a deep link to the invoice.** Rejected — it is
  today's behaviour with better manners. Bill's directive is that the document is
  attached, not that it is reachable.
- **Widen the dispatch inline in `approvals.ts` without importing the shared
  module.** Rejected — that is the defect: a second copy of a rule that already has
  a canonical home. It would leave three predicates where there should be one.
- **Convert CSV/Office originals to PDF and overlay them too.** Rejected for now —
  it puts a document converter (LibreOffice headless or equivalent) in the decision
  path, a large operational dependency for 8 rows, and a conversion is a
  re-rendering of the vendor's document rather than the document. D4 attaches the
  real file, which is what accounting needs to key from.
- **Make the mail fail-soft but flag the row.** Rejected — it re-creates the exact
  ambiguity ADR-0114 and ADR-0126 were written to remove. A mail that went out
  without the invoice is not a delivery; treating it as one puts a stamped
  `decision_mail_sent_at` on a row that still owes accounting a document.
- **Page `urgent` on `refused_no_original`.** Rejected under the ADR-0037 rubric —
  see D5. The decision itself stands and is visible in the queue; the sweep is the
  backstop.

## Consequences

- Accounting receives the stamped invoice on every decision, including the
  mislabelled and the non-overlayable, and the "go and fetch it yourself" sentence
  disappears from their workflow.
- A decision mail can now **refuse**. That is a new terminal state for operators to
  understand: the decision stands, the notice did not go, the queue badge and the
  06:00 digest both show it, and the re-send button is the repair. This is
  deliberately the same shape as the existing `refused_no_recipients` and
  `too_large` outcomes rather than a new concept.
- Message size grows for non-overlayable originals (cover + original, roughly
  double). This is comfortably inside the transport: ADR-0114 already sends under
  ~3 MB encoded as an inline `#microsoft.graph.fileAttachment` with `contentBytes`
  and switches at `GRAPH_INLINE_SEND_LIMIT_BYTES` (3 MB) to a draft +
  `createUploadSession` in 3,932,160-byte chunks, against a whole-message ceiling
  of `M365_MAIL_MAX_MESSAGE_BYTES` (default 35 MB, clamped to [3 MB, 150 MB]). The
  largest original in the entire table is 877,659 bytes. No transport work is
  required by this ADR.
- `original_attachment_sha256` stops being readable as "the original was stamped".
  It never meant that — it is written from bytes hashed **before** the overlay is
  attempted, so it is set identically on a true overlay and on a cover-page
  fallback. Anyone auditing this column in the future should know it proves the
  bytes were **fetched**, not that they were **attached**. Nothing in the fix
  changes that; this is written down so the next reader does not mistake it for
  evidence.
- The 8 `text/csv` decisions and the 14 mixed cases become correct only from the
  ship date forward unless they are re-sent (D6).

## Verification

Ship gate — each of these must be demonstrated, not asserted:

1. A unit test per production shape — `application/pdf`, `application/pdf; name="x.pdf"`,
   `application/octet-stream` + `.PDF`, `image/jpeg`, `image/png`, `text/csv`,
   an unknown binary — asserting the attachment set handed to the transport
   contains the original document's bytes (D7).
2. A regression test pinning the exact shape of the 9: one
   `application/octet-stream` attachment with a `.PDF` filename plus a sub-50 KB
   `image001.jpg` sibling ⇒ exactly one attachment, a true PDF overlay, **not** a
   cover page.
3. A test that a request with file attachments whose originals are all unfetchable
   returns `refused_no_original`, sends nothing, leaves `decision_mail_sent_at`
   NULL, and that the row is then caught by `isDecisionMailStuck`.
4. A test that a body-only request is unaffected and still sends.
5. Post-deploy, against production: re-send one of the 9 (D6, Bill's go) and
   confirm from the container log that the send carries one attachment, and from
   `ap_requests` that `decision_pdf_sha256` changed and `decision_mail_sent_at`
   re-stamped.

Execution plan, task by task, with per-task verification:
`docs/plans/2026-09-15-ap-approval-email-stamped-invoice.md`.

## Implementation note (2026-09-15, Pacific — this commit)

Shipped in one commit against `main`, in the order the plan laid out
(`docs/plans/2026-09-15-ap-approval-email-stamped-invoice.md` T1–T6). What changed:

- **`src/lib/ap/inline-preview.ts`** — the shared predicate module gained the D3
  byte sniff (`sniffBinaryType`) and the resolution order (`resolveOverlayType` =
  sniff → MIME → extension). It stays a pure module: `Uint8Array` only, no
  `Buffer`, no `server-only`, so `ApQueueClient.tsx` still imports it safely.
- **`src/lib/ap/approvals.ts`** — `stampOneOriginal` dispatches on the resolved
  type instead of `ct === 'application/pdf'`; `stampImage` now receives the
  CANONICAL type (`image/jpg` → `image/jpeg`); the inline-image size filter reads
  `normalizeMime`, so a padded or parameterized `image/jpeg; name="sig.jpg"` is
  still recognized as the signature logo it is. A non-overlayable original (and an
  overlay that throws) yields the cover page **plus the untouched original**, which
  rides the same `dedupeFilename` collision space — generalized to preserve any
  extension, since originals are not all `.pdf`. `buildDecisionStamp` returns a
  discriminated outcome instead of an array, and `sendDecisionEmail` refuses on
  `ok: false`.
- **`src/lib/ap/stamp.ts`** — `StampInput.originalAttached`. The cover page says
  the original is attached to this message when it is; the "Retrieve the original
  via the DR3-Vision AP queue" sentence survives only where it is true (see the
  deviation below).
- **`src/app/dashboard/ops/ap/ApQueueClient.tsx`** — the approver's confirmation
  line for `refused_no_original`: decided, nothing sent, flagged unmailed, Re-send
  is the repair.
- **Tests** — `src/lib/ap/decision-mail-attachments.test.ts` (new, 20 cases:
  the seven production shapes, the regression pin, D4, D5, and the
  `original_attachment_sha256` note below), plus the sniff/resolution cases in
  `inline-preview.test.ts` and the cover-copy cases in `stamp.test.ts`. The stamp
  renderers are mocked but **echo the bytes they are handed**, so "the delivered
  attachment contains the original document" is a literal assertion about what
  flowed through the real dispatch rather than a stand-in for it; the R2 fixtures
  carry real magic-byte prefixes so the sniff runs for real.

### Four deviations from the plan, and why

1. **A cover page gets its original whenever it is a cover — not only when the
   type is non-overlayable.** T3 scoped D4 to CSV/Office/unknown binary. But an
   overlay that _throws_ (a corrupt PDF, a pdf-lib refusal) produces the same
   cover page, and D1 does not have an exception for it. The artifact carries a
   `coverOnly` flag rather than a type test, so every cover page travels with its
   original by construction.
2. **The refusal also covers an unexpected throw.** D5 names the case "has file
   attachments, no stamped original could be produced". An exception escaping
   `buildDecisionStamp` (a Prisma read, a Chromium failure on a body render) used
   to be swallowed into "mail proceeds without attachment", which is the exact
   silence this ADR closes — so it now returns `{ ok: false, reason:
'render_failed' }` and refuses too. A body-only invoice that renders normally
   is untouched, as D5 requires; only its _failure_ mode changed, from a silent
   attachment-free send to a refusal the sweep can see.
3. **The original's filename is sanitized before it becomes a MIME part.** D4 says
   the original keeps its own filename, and `ap_attachments.filename` is the same
   untrusted, sender-written field the content type came from — it now becomes the
   name a recipient's mail client offers to save. `safeOriginalFilename` keeps the
   basename only, applies the character policy `stampedAttachmentName` already used
   (plus spaces), drops leading dots and caps the length. Ordinary vendor names
   (`Invoice_IN-0320844.PDF`, `ledger.csv`) pass through untouched; a test asserts
   no delivered part carries a path separator or a control character.
4. **A PARTIAL drop is logged, not refused.** D5 refuses when nothing survived.
   When 2 of 3 originals survive, withholding the two we have would help nobody,
   so the mail goes with what was built and the gap is named at `warn` with the
   dropped count — the silence is closed without inventing a second alarm class.

### Two facts the next reader should not have to rediscover

- **The one remaining cover-page-alone path is real and correct.** An
  `ap_attachments` row with a NULL `storage_key` has bytes that were never stored;
  there is nothing to attach and no re-send can recover it. That path keeps the old
  "retrieve it from the AP queue" sentence because there it is true. It is not
  reachable from an R2 miss — an R2 miss on a stored key now refuses.
- **`original_attachment_sha256` still is not evidence of stamping** (see
  Consequences). A test now pins that: it is set identically on a true overlay and
  on a cover-page fallback. The proof of delivery is the attachment set, which is
  what every test in `decision-mail-attachments.test.ts` asserts.

Ship gate: the whole `src/lib/ap` suite green (460 passed, 1 skipped, 27 files),
`tsc --noEmit` clean, `eslint --max-warnings=0` clean. Verification items 1–4 are
the new tests; item 5 (re-send one of the 9 in production) is **D6 and still waits
on Bill** — nothing has been re-sent.
