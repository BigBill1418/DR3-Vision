# ADR-0136 — An invoice is approved once

- **Status:** Accepted, implemented 2026-09-23 (Pacific)
- **Context:** Bill, 2026-09-23, on OPEN-ITEMS §0.BX BX-7: invoice 6646 (United
  Fleet Maintenance, Unit #161053, $201.84) is approved twice. Find out how, whether
  it could have been paid twice, and block it from happening again.
- **Extends:** ADR-0046 (AP approval mailbox — the decision mail is accounting's
  instruction to pay), ADR-0046 Amendment 5 (structured Approve, the variance gate
  this guard is modelled on).

## Context

**It was two requests, not one request approved twice.** Two different emails
(different `internet_message_id`s, different Outlook conversations), both
forwarded by Gloria Salpino (AP), carrying byte-identical invoice PDFs
(`original_attachment_sha256` `5317303b…` on both):

| Request    | Received (PT)      | Approved (PT)              | Explanation typed                              |
| ---------- | ------------------ | -------------------------- | ---------------------------------------------- |
| `3fbc015c` | 2026-08-10 2:40 PM | 2026-08-13 5:32 AM, Morena | "Calibrate in house scale."                    |
| `4ab3c44e` | 2026-09-01 3:27 PM | 2026-09-02 6:14 AM, Morena | "Check on females lights of the tractor truck" |

The first explanation belongs to a different invoice: Morena approved a Grainger
notice at 5:30 AM with exactly that sentence, two minutes before 6646. Gloria's
second forward reads _"Resending this invoice for approval note correction."_ So the
second request was a deliberate re-send to fix the note — and Vision treated it as
a new invoice, because the only duplicate guard was `internet_message_id` UNIQUE and
a re-forward is a new message. Both decisions mailed a stamped "APPROVED" invoice to
Gloria with Mary Scott (GP filing) on CC.

**Vision has no payment path.** There is no QuickBooks, Great Plains, ACH or export
integration; payment is keyed by hand in GP from the decision mail. Whether 6646 was
paid twice is therefore a GP question, not a database one.

**6646 is not alone.** A scan of every approved request with the key below found
seven more invoice numbers approved twice, and Vision's own approval mail forwarded
back into the inbox and approved again (OPEN-ITEMS §0.BX BX-8 has the list).

## Decision

1. **The key.** `ap_requests` has no invoice-number column; the number lives in the
   subject. `extractInvoiceNumber` reads it (`Invoice: 6646`, `Invoice #: T705145`,
   `Your Invoice IM25013731`, `Inv 12513`, `invoice 13389- 1 of 4`, …; fixtures are
   real production subjects). Two requests are the same invoice when the numbers are
   equal **and** the vendors are compatible — same first five letters, or a shared
   significant word — because the typed vendor on 6646 was "United" once and "united
   fleet maintenance" the next time. Loose on purpose: a false match costs one
   sentence, a missed one can cost a payment.
2. **The second key — a forwarded approval.** A subject containing
   `DR3-Vision AP decision (approved …) — <original subject>` is Vision's own decision
   mail, forwarded back. The approved original is found by that subject, no invoice
   number needed. A forwarded **rejection** is a resubmission and is not matched.
3. **The guard.** On every Approve filed against a DR3 site, `decideRequest` looks for
   another request already `approved` or `pending_second_approval` under either key.
   If one exists the Approve is refused (409, `ApDuplicateInvoiceError`) and the
   refused attempt is audited (`outcome: refused_duplicate_invoice`). Reject, Hold and
   NOT-DR3 are untouched. Re-approving the **same** row was already impossible — the
   conditional flip only matches an actionable status — and a test now pins that.
4. **The door.** The AP panel shows where and when the invoice was approved, and the
   approver may approve anyway with a **required** reason (`duplicateOverrideReason`).
   The reason, the invoice number and the matched request ids ride the winning
   decision's audit row (`duplicate_override`). No schema change.
5. **The line accounting reads.** An approved decision mail whose invoice is also
   approved on another request carries _"⚠ Invoice N was ALSO approved in
   DR3-Vision (date PT). Pay it once."_ This covers the deliberate re-send the door
   lets through and every pre-guard pair on a Re-send.

## Consequences

- The 6646 shape (re-forward to correct a note) now needs one typed reason, and Mary
  sees the "pay it once" line on the second mail.
- **Residual — no key in the subject.** A re-forward whose subject carries no invoice
  number and is not a forwarded approval (`FW: Ramos/EFuel`, `FW: Invoice(s) Posted`,
  `FW: Kelliher Machine Invoice-Green Baler` re-sent as `… Invoice 0174`) is not
  caught. The scan found three such pairs by identical PDF bytes, but that hash is only
  computed when a decision is stamped, after the approval. Hashing attachments at
  intake would close it; not built. **Closed by the addendum below** (hashed at the
  Approve, not at intake).
- The check runs outside the decide transaction, like the variance gate. Two approvers
  approving two copies of the same invoice in the same second can both win; the
  decision mail line still flags the pair.

## Addendum — 2026-09-23 (Pacific): the third key is the invoice file

Bill, 2026-09-23 ~10:52 PM PDT: "push on" — close the residual above.

**When the hash existed.** `ap_requests.original_attachment_sha256` is written only when
the decision mail is stamped (`sendDecisionEmail`, after the Approve), and it records only
the FIRST stamped original. Nothing hashed a file at intake. Half the approved requests
(85 of 179) carry two or more stampable files, so the first-original column alone would
miss a duplicate that is the second file, and a request waiting for its second signer has
no stamp yet. So the key needed per-file hashes that exist before the Approve.

**Decision.**

1. **`ap_attachments.sha256`** (migration `20260864_adr0136_ap_attachment_sha256`,
   indexed). No intake change: the Approve guard computes it. `invoiceFileHashes`
   reads each of the request's invoice files from R2, hashes it, and records the hash
   (only a NULL is ever written). Every request that reaches `approved` or
   `pending_second_approval` passes through that guard, so its files are hashed from
   then on; the 2026-09-23 backfill
   (`scripts/one-off/2026-09-23-ap-attachment-sha256-backfill.mjs`) hashed every file
   stored before.
2. **What counts as the invoice file.** Stored `kind='file'` rows, minus signature/logo
   images (`signature-images.ts`): images under 50 KB (the stamp's rule, moved there) and
   Outlook body images named `image00N.jpg/png`. The second rule is load-bearing:
   production has the same 69,918-byte `image002.jpg` on 12 approved requests and an
   80,204-byte `image001.jpg` on 7 — above the 50 KB line, and they would have matched
   every forward from the same AP clerk.
3. **The match.** Another request that is `approved` or `pending_second_approval` and
   has an invoice file with the same sha256, or whose `original_attachment_sha256`
   equals one (the fallback for an approval whose files were never hashed). No vendor
   check: identical bytes are the same document. Same refusal (409), banner, audited
   override (`same_file_request_ids` on both the refusal and the `duplicate_override`
   audit), and the decision mail's line.
4. **The wording says it was the same file.** "The same invoice file was already approved
   … The attached file is identical, byte for byte, to the one approved there. One file
   can cover several invoices or be a statement — if so, approve anyway and say so." The
   banner marks each such match "same file". When the only match is by file, the
   request's own invoice number is not reported as "already approved" (invoice 13423's
   PDF is byte-identical to 13422's; "invoice 13423 was already approved" would be false).
5. **An unreadable file never blocks an Approve.** The key is computed without it and a
   warning is logged; the number and forwarded-approval keys still run.

**Replay against production history (2026-09-23, read-only: every stored file hashed,
each approval checked against the approvals before it).** The file key catches every
subject-key pair that had the same PDF, plus five the subject key missed:

| Approved (PT)       | Request / subject                                  | Twin approved (PT)                                    |
| ------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| 2026-07-20 11:43 AM | `82c1fd09` "Inter State Oil"                       | `a01cbb13` 11:30 AM, $403.01                          |
| 2026-07-27 12:01 PM | `81903703` "FW: Invoice(s) Posted-Ramos/E-fuel"    | `513ea80b` same minute, $1,023.16                     |
| 2026-08-14 1:21 PM  | `6cc11851` "FW: Ramos/E-Fuel Invoice IN-0320844"   | `244e14c1` "FW: Ramos/EFuel" 08-11 9:15 AM, $1,902.68 |
| 2026-09-21 1:07 PM  | `01e83eb3` Xtraction invoice 13423 ($676.20)       | `53ddca05` invoice 13422, 1:00 PM, $548.10 — same PDF |
| 2026-09-22 11:52 AM | `99873399` "…Green Baler Invoice 0174" ($4,005.00) | `317ab9d0` "…Green Baler" 08-24 10:17 AM              |

The subject key alone still owns two that are not the same bytes: Xtraction 13422's second
copy (`6fb945b5`, its PDF is 13423's) and the forwarded-approval echoes (Kelliher
`900f473a`, Allied U047M248 `8aa1d792`). Shared files between an approved and a REJECTED
request (DR3 105730/105731, `5312.jpg`, `Invoice 19…29.pdf`) are not matches, by design.

**Residual.** The same invoice re-scanned or re-exported (different bytes) under a subject
with no number. The check still runs outside the decide transaction.

## Amendment 2 — 2026-10-14 (Pacific): an already-approved invoice is rejected at intake

(The 2026-09-23 addendum above is Amendment 1.)

**What happened.** 2026-10-13, 3:27–4:13 PM PT: AP re-forwarded ~28 United Fleet
Maintenance invoices (6652..6821) that had been approved in September. Each re-forward
is a new message, so each became an ordinary pending request, was announced to the
approvers, and was then rejected by hand ("already approved by X on 09-09"). This ADR's
guard only ran when someone pressed Approve, so the approvers did the matching. Of the 26
requests in that batch, 23 match an approved request by subject invoice number + vendor;
only 8 by identical file, because nothing hashed a file at intake. The per-invoice email
flood from the same batch was fixed separately (ADR-0066 amendment, 2026-10-13: one
new-request notice per poll).

**Decision (Bill, 2026-10-14, chosen over flag-and-hold).**

1. **Reject at intake.** `src/lib/ap/auto-reject-duplicate.ts` runs right after
   `ingest.ts` creates a request (after its attachments and insert audit). It runs the
   same `findApprovedDuplicates`, but **acts on only two of its keys** (see "Which keys
   may reject" below): the invoice number with a confirmed vendor, and Vision's own
   approval mail forwarded back. On a hit it rejects through
   `decideRequest`, the one decision path. So the `won` audit row, the stamped original
   and the decision mail are the ones a human Reject produces. It does not create a
   second rejection path.
2. **Who decided.** `decided_by = 'system:ap-duplicate-guard'`. `decided_by` is bare text,
   but `audit_log.actor_user_id` is a users FK, so `decideRequest` now writes a `system:`
   actor as `actor_label` (the convention used by `system:ap-poll` and others). Every place
   that resolves a decider's name (decision mail, stamp, queue detail, history) shows it
   as **"DR3-Vision duplicate check (automatic)"**, not "another approver".
3. **The note** says what was matched: `Auto-rejected: duplicate of already-approved
request <id> (invoice <n> | its own approval mail, forwarded back, approved <date> PT by <name>).` The
   site is the original's site. A decision without a site is refused (operator directive
   2026-07-15), and the duplicate belongs to the same books.
4. **The second audit row** has `outcome: 'auto_rejected_duplicate'`,
   `matched_request_ids`, `same_file_request_ids`, `invoice_number`, `forwarded_approval`,
   `rejected_against`, `rejected_on` (`invoice_number` | `forwarded_approval`) and the
   mail outcome.
5. **Not announced, not pending.** `ingestMessage` returns `auto_rejected`. The request
   is never added to the poll's batched new-request notice. The poll counts it in
   `requestsCreated` (the row exists) and in a new `autoRejected` count shown on the
   `[ap-poll] … ok` log line and in the route's result. There is no ledger column for it,
   deliberately: no migration.
6. **The same-file key exists at intake.** `ingest.ts` records each stored file's
   sha256 as it writes the file. This was the gap in Amendment 1, where the hash was only
   computed when someone approved.

**Which keys may reject (revised after independent review, 2026-10-14).** The
Approve-time guard's keys are loose on purpose: a person reads the prompt, and a false
match costs one sentence. At intake nobody reads it first, so only the strong keys act:

- **Invoice number + CONFIRMED vendor.** The loose `vendorsCompatible` treats a blank
  vendor on either side as "can't rule it out", so a number match with no vendor would
  match the same number at any vendor. Auto-reject needs `vendorConfirmed`: a vendor on
  BOTH the new request (the extracted `best_vendor`) and the original, and the names
  agree (`vendorsConfirmed`). A number match whose vendor is blank is accepted only when
  a byte-identical invoice file corroborates it. Otherwise the request stays pending
  (`vendor_unconfirmed`). Measured 2026-10-14: all 22 hand-rejected requests received
  2026-10-13 PT carried an extracted vendor and match on number + confirmed vendor, so
  this rule still rejects the whole batch.
- **Vision's own approval mail forwarded back.** Unambiguous; no vendor needed.
- **Never the file alone.** One PDF can legitimately be two approvals (a vendor
  statement covering several invoices: Amendment 1, and the Allied statement on
  OPEN-ITEMS BX-8). A same-file match with no number match, including the same file
  under a DIFFERENT invoice number, stays pending (`file_only_match`) for the
  Approve-time prompt, where the audited override is the way through.

**Safeguards.** This ADR's loose key is biased toward false matches. A false match used to
cost one sentence (the audited override). Here it costs a rejected invoice, so:

- **Kill switch.** `AP_AUTO_REJECT_DUPLICATES=false` (or `0`) in the app env turns
  intake rejection off. It defaults to on, and turning it off gives back the old
  behaviour: the copy stays pending and the Approve-time guard still refuses it.
- **Correction and resubmission wording stays with a person.** A subject or body
  containing `correction`, `corrected`, `revised`, `revision`, `resubmit`/`re-submit`/
  `resubmission`, `updated invoice`, `amended`/`amendment`, `credit memo`,
  `reissue`/`reissued`/`re-issued` or `replacement` is never auto-rejected (word-bounded;
  `replacement` will also hold back a service order that mentions a part replacement,
  the safe direction). Invoice 6646's
  "-Note Correction" re-forward, the case that started this ADR, was legitimate. None
  of the 26 requests from 2026-10-13 contains these words, so the batch would still have
  been rejected.
- **Only a terminal approval counts.** A `pending_second_approval` original can still
  be overridden to rejected, and if it is, the new copy is the one to keep. The
  original must also be site-filed. A NOT-DR3 original leaves the copy pending.
- **It never throws, and it reports what committed.** `decideRequest` commits the
  rejection and its audit row before it builds and sends the decision mail. A throw from
  that post-commit work used to come back as `decide_failed`, and ingest then announced
  an already-rejected request as new work. Now the guard reads the row back after any
  throw: `rejected` by the guard means the verdict is `rejected` with mail `failed`
  (`decision_mail_sent_at` stays NULL, so the ADR-0126 sweep and the Re-send button
  are the repair). Anything else leaves an ordinary pending request and logs a warning.
  The Approve-time guard is still in front of it.
- **At most 10 auto-rejections per poll** (`AUTO_REJECT_CAP_PER_POLL`, `poll.ts`). Each
  one stamps the original, writes R2 and sends a mail, which takes seconds. A batch of
  ~28 in one poll could outrun the cron's 300 s fetch deadline
  (`scripts/ap-poll-cron.mjs`), and the cron would then fire a second, overlapping poll.
  When the cap is reached, the loop stops before the next message. The remaining messages
  stay unmoved in the source folder and the delta token is not saved, so the next poll
  (10 minutes later) re-lists them and handles them the same way. Messages already
  processed were moved to Processed, and `internet_message_id` UNIQUE makes any re-listed
  one a cheap duplicate. A 28-message batch therefore clears in 3 polls (~20 min), and
  `deferredToNextPoll` and the log line say so. **Why a cap and not an advisory lock:**
  Prisma pools connections, so a session-level `pg_advisory_lock` can be released on a
  different connection than the one that took it. A correct lock would have to hold one
  transaction open across minutes of Graph and R2 calls. Overlap was already safe (UNIQUE
  intake key, CAS decision), and the cap removes the cause of overlap, which is a poll
  that runs too long.

**The mail.** It is the existing decision mail, sent from the app's M365 sender
(`@svdp.us`). For a mailbox request it goes To the forwarding AP address (internal
`@svdp.us`, validated at intake) and CC to the `ap_decision_recipients` roster
(accounting). Body: Decision REJECTED, the original's site, Approver "DR3-Vision duplicate
check (automatic)", the decided time, and the note naming the approved request. The
stamped original is attached. This is what the approvers' hand rejections sent on
2026-10-13, but it now says that it was automatic and what it matched. It carries no
"approved" or "pay" wording. Each duplicate gets one mail, as each hand rejection did.

**Residuals.** A batch of N duplicates still sends N rejection mails (to AP and
accounting); a batched rejection digest would need its own decision. Two invoices that
genuinely share a number at vendors whose names share a significant word (or the same
first five letters) would be rejected. Such a false rejection can be reversed with the kill switch and
AP's re-send. A request with no extracted vendor (local extraction alone names no vendor;
only the Claude fallback does) is auto-rejected only on a corroborating file or a forwarded
approval, so such duplicates fall back to the Approve-time guard. The capped tail of a
large batch is not visible in Vision until the next poll ingests it (up to 10 min per 10
messages). A same-file-only duplicate is no longer auto-rejected and depends on the
Approve-time prompt, by design.
