# Plan — the stamped original invoice rides every AP decision email

- **Date:** 2026-09-15 (Pacific)
- **Owner:** unassigned (execution agent — Aegis)
- **Decision record:** `docs/adr/0132-the-preview-could-read-it-and-the-mail-could-not.md`
- **Register:** `docs/OPEN-ITEMS.md` § 0.BU
- **Trigger:** Bill, 2026-09-15 15:27 PT — the original invoice is not attached to
  the accounting decision mail; it must be, every time.

## Read this first

The bug is **not** in the transport, the size caps, the rollout gate, or a
refactor. `src/lib/ap/approvals.ts` dispatches the stamp renderer on a strict
string equality against Graph's declared MIME type:

```ts
// src/lib/ap/approvals.ts — inside stampOneOriginal()
const ct = (att.content_type ?? '').toLowerCase();
if (ct === 'application/pdf') {
  // true overlay on the invoice
} else if (/^image\/(png|jpeg|jpg|webp)$/.test(ct)) {
  // true overlay on the scan
} else {
  result = await stampApproval(input, renderer); // COVER PAGE — no invoice
}
```

15 production attachments are real PDFs labelled `application/octet-stream` by the
sending mail client, so they take the third branch and accounting gets a cover
sheet instead of the invoice. `src/lib/ap/inline-preview.ts` already solves exactly
this (ADR-0046 Amendment 6, commit `6efa5963`) and is already used by the preview
surfaces — `approvals.ts` simply never adopted it.

**Do not** normalize `content_type` at ingest, and **do not** copy the predicate
into `approvals.ts`. Import the shared one. See ADR-0132 "Alternatives considered".

## Constraints

- **No application code ships outside the rollout doctrine.** `ap_notify` is
  already `live` at both sites — this changes the _content_ of an existing live
  surface, not its audience, so no new `rollout_surfaces` row is needed. Do not
  add one. Mail still routes through `notifyStaff()` (CLAUDE.md #12); do not
  import `@/lib/m365-mail` from feature code.
- **The transport needs no work.** ADR-0114 already handles inline vs upload
  session at `GRAPH_INLINE_SEND_LIMIT_BYTES` (3 MB) with a 35 MB message ceiling.
  Largest original in the table is 877,659 bytes. Do not touch `m365-mail.ts`.
- `src/lib/ap/inline-preview.ts` is a **pure** module (no `server-only`, no node
  imports) — importing it into `approvals.ts` is safe and intended.
- Tests must assert **delivered bytes**, never a content-type allowlist (ADR-0132 D7).
- Production DB is read-only from a session. Do not write to it.

---

## T1 — Adopt the shared content-type predicates (ADR-0132 D2)

**Files:** `src/lib/ap/approvals.ts`

1. Import `isInlinePdf`, `isInlineImage`, `normalizeMime` from `./inline-preview`.
2. In `stampOneOriginal`, replace the two anchored comparisons with
   `isInlinePdf(att.content_type, att.filename)` and
   `isInlineImage(att.content_type, att.filename)`.
3. `stampImage` takes a concrete content type — pass the **canonical** type, not
   the stored one. `inline-preview.ts` already exports `effectiveInlineContentType`
   for this; use it rather than deriving a second mapping.
4. Also route `isLikelyInlineImage` (the sub-50 KB signature-logo filter) through
   `normalizeMime` so a parameterized `image/jpeg; name="sig.jpg"` is still caught.

**Verify:** `npx vitest run src/lib/ap` green. Then a new case proving an
`application/octet-stream` + `.PDF` attachment reaches `stampOntoOriginalPdf` and
**not** `stampApproval` (spy/mock the two renderers and assert which was called).

---

## T2 — Sniff the bytes, and let them win (ADR-0132 D3)

**Files:** `src/lib/ap/inline-preview.ts` (or a new `src/lib/ap/detect-type.ts` if
you prefer to keep the pure-client module free of Buffer types — your call, but
**one** module, exported once, used by both callers)

1. Add a magic-byte detector over the original bytes:
   - `25 50 44 46 2D` (`%PDF-`) → `application/pdf`
   - `89 50 4E 47 0D 0A 1A 0A` → `image/png`
   - `FF D8 FF` → `image/jpeg`
   - `52 49 46 46 …. 57 45 42 50` (`RIFF….WEBP`) → `image/webp`
   - otherwise → `null` (unknown; fall through to MIME, then extension)
2. In `stampOneOriginal`, resolve the effective type as **sniff → MIME →
   extension** and dispatch on that. The bytes are already in hand at this point
   (`getApAttachmentBytes` runs immediately above) — do not re-fetch.
3. Log the resolution once per attachment at `info` when the sniffed type
   **disagrees** with the stored `content_type`. This is the observability that did
   not exist: today the substitution is completely silent.

**Verify:** unit tests feeding a real `%PDF-1.4` buffer labelled
`application/octet-stream`, a JPEG labelled `application/pdf`, and a text buffer
labelled `application/pdf` — assert the chosen path each time.

---

## T3 — A cover page never travels alone (ADR-0132 D4)

**Files:** `src/lib/ap/approvals.ts`

For a genuinely non-overlayable original (CSV, Office, unknown binary after T2):
keep the stamped cover page **and** attach the original file itself.

1. Extend `StampedArtifact` (or add a sibling shape) so one source attachment can
   yield **two** mail attachments: the stamped cover PDF and the untouched
   original.
2. The original keeps its own filename; give it its **corrected** content type
   (sniffed from T2, falling back to the stored value).
3. Feed both into the `attachments:` array. Note the existing
   `contentType: 'application/pdf'` hard-coding at the `notifyStaff` call site —
   it must become per-artifact, not a constant.
4. Run the original through `dedupeFilename` too, so a cover and an original that
   collide on name do not clobber each other in the MIME part list.
5. Update the cover-page copy in `src/lib/ap/stamp.ts` — the sentence _"Retrieve
   the original via the DR3-Vision AP queue"_ is now false when the original is
   attached beside it. Replace with wording that says the original is attached to
   this message. Keep the sentence only for the R2-unavailable degradation, if you
   keep that path at all after T4.

**Verify:** a test with a `text/csv` attachment asserting **two** mail attachments,
one of which is the byte-identical original.

---

## T4 — Fail loud instead of sending an empty notice (ADR-0132 D5)

**Files:** `src/lib/ap/approvals.ts`, plus the `ApMailOutcome` type and its readers

1. Add `refused_no_original` to `ApMailOutcome`.
2. Delete the `.catch(() => null)` around `buildDecisionStamp` that currently lets
   the mail proceed with no attachment. Distinguish:
   - request has **no** file attachments → body render, unchanged, still sends;
   - request **has** file attachments but no stamped original could be produced →
     **send nothing**, return `refused_no_original`, leave `decision_mail_sent_at`
     NULL.
3. Page on that branch, matching the existing sibling alarms in the same function:
   topic `dr3-vision-system`, priority `high`, tags `['error','ap','dr3-vision']`,
   `clickUrl` = `apRequestUrl(requestId)` (tier-1, ADR-0036),
   fingerprint `ap-decision-mail-no-original:<requestId>`, cooldown 6 h.
   Body carries **row id + status only** — never vendor, amount or filename
   (ADR-0045).
4. Check every caller of `sendDecisionEmail` handles the new outcome:
   `src/lib/ap/second-approval.ts:271`, `src/lib/ap/approvals.ts:630`,
   `src/app/api/ops/ap/[id]/resend/route.ts:22`. **The decision must still stand**
   in all of them — a refused mail never rolls back a committed decision.
5. Confirm (do not assume) that a `refused_no_original` row is picked up by
   `isDecisionMailUnsent` / `isDecisionMailStuck` in `src/lib/ap/decision-mail.ts`
   and therefore by the queue badge and the 06:00 digest. It should be, because
   those key on state, not cause — assert it in a test rather than reasoning about
   it.

**Verify:** tests for the refusal path, the body-only path, and the sweep pickup.

---

## T5 — The tests that keep it fixed (ADR-0132 D7)

**Files:** `src/lib/ap/approvals.test.ts` (or a new `decision-mail-attachments.test.ts`)

1. Table-driven over every production shape: `application/pdf`,
   `application/pdf; name="x.pdf"`, `application/octet-stream` + `.PDF`,
   `image/jpeg`, `image/png`, `text/csv`, unknown binary. For each, assert the
   attachment set handed to the transport **contains the original document's
   bytes**. Assert bytes, never the type table.
2. The ADR-0132 regression pin: one `application/octet-stream` `.PDF` plus a
   sub-50 KB `image001.jpg` sibling ⇒ exactly one attachment, PDF overlay, not a
   cover page. Name the ADR in the test description.
3. Keep Playwright mocked — no real Chromium (see `stamp-render-gate.test.ts` for
   the established mock shape). pdf-lib is pure JS and runs for real.

**Verify:** `npm test` green, `npx tsc --noEmit` clean, `npx eslint` zero warnings
(warnings are errors here).

---

## T6 — Ship

1. Conventional commit referencing ADR-0132. **No `[skip-deploy]`** — this one
   deploys.
2. `swarmpilot_deployer` auto-deploys from `main`. Confirm the live version:
   `ssh 10.99.0.2 'docker logs dr3-vision-app --since 10m 2>&1 | grep -o "\"version\":\"[^\"]*\"" | tail -1'`
   and check it matches the merged SHA. Do not report success from a green CI run.
   (`docker logs --since` on this host rejects `30d`-style durations — use hours.)
3. Update `CHANGELOG.md` (Pacific date) and mark the T-items done in
   `docs/OPEN-ITEMS.md` § 0.BU.

---

## T7 — Repair the 9 (ADR-0132 D6) — **BILL'S GO REQUIRED, DO NOT RUN UNASKED**

Re-sending mails accounting a second copy of an invoice they already actioned.
Bill decides whether they get a heads-up, and whether all 9 or only the recent ones
are worth it.

On his go, for each id: `POST /api/ops/ap/{id}/resend` (AP-approver session; the
route rebuilds artifacts from R2 through the fixed dispatch).

```
0e0db7a1-c2e6-44f2-a365-c84ec00c6039   2026-09-09 15:05 PT  InterState Oil Co
8b344a95-f6de-45e9-99b3-3a656528e317   2026-09-03 09:43 PT  Vulcan Incorporated
6cc11851-9383-41fe-ada1-1c88ec3fa822   2026-08-14 13:21 PT  Ramos Oil
04ea4530-c3d6-49ad-976f-b87dd703fb26   2026-08-13 05:35 PT  Ramos
618296f6-dfd3-4c0c-b3dd-2d8830e31679   2026-08-07 12:10 PT  United Truck And Trailer Repair
041d2f45-83cb-4f82-8c34-03eb7f8b8a31   2026-07-30 09:36 PT  (vendor not recorded)
c263d22f-54a0-48aa-a59c-e401a9a6a374   2026-07-28 05:44 PT  (vendor not recorded)
513ea80b-5c55-46e9-a914-31f4faf3aadf   2026-07-27 12:01 PT  Ramos Oil
81903703-5d63-4df0-a59f-e60c002a76a9   2026-07-27 12:01 PT  Ramos Oil (duplicate submission)
```

**Verify per re-send:** the container log line shows the send delivered, and
`ap_requests.decision_pdf_sha256` **changed** for that row (a changed hash is the
proof the artifact was rebuilt rather than re-attached from the old cover page).
`decision_mail_sent_at` re-stamps.

Consider whether `81903703` / `513ea80b` (the same invoice submitted twice) should
both be re-sent — probably not; ask.

## The 14 mixed cases

Requests that received a correct stamped invoice **plus** a spurious cover page
(`text/csv` companions, or a mislabelled second attachment). Lower harm — the
invoice did arrive. T1–T3 fix them going forward. Whether to re-send is Bill's
call and is **not** part of T7 unless he says so.

## Out of scope

- Converting CSV/Office originals to PDF for overlay (ADR-0132 alternatives —
  rejected; revisit only if the CSV volume grows).
- Capturing Graph's `isInline`/`contentId` into an `ap_attachments.is_inline`
  column to retire the 50 KB size heuristic — a real durable follow-up already
  named in ADR-0046, unchanged by this work, still open.
- Anything in `m365-mail.ts`.
