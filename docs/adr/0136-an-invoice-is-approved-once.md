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
  intake would close it; not built.
- The check runs outside the decide transaction, like the variance gate. Two approvers
  approving two copies of the same invoice in the same second can both win; the
  decision mail line still flags the pair.
