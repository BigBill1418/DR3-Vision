# ADR-0129 — The mail that left by hand, and the roster the warning ignored

- **Status:** Accepted, implemented 2026-08-27 (Pacific)
- **Context:** The 2026-08-27 06:00 digest — the first after ADR-0126's sweep
  went live — carried two lines Bill triaged in session: four decided invoices
  with no confirmed decision email, and "2 active approvers have no
  ap_approval_routing row: Daven Stetson, Patrick Dills."
- **Extends:** ADR-0126 (decision-mail blindness), ADR-0066 §1.4 (routing
  totality warning), ADR-0046 §3 amendment (the approver roster as data),
  ADR-0117 (delivery is a fact, not a promise).

## Context

**The four unmailed decisions were not unmailed.** Bill confirmed Mary filed
all four with accounting by hand (two rejections; two approvals — Trailer Proz
$3,315.99 and Carlos Linares Bro $8,950.00). Nothing is owed to accounting and
a re-send would duplicate her filing. But the system had no way to say so: the
only field that clears the sweep, the queue chip, and the digest line is
`decision_mail_sent_at`, and ADR-0117 made that stamp mean exactly one thing —
a transport confirmed a send. Stamping it for a hand filing would launder a
human act into a machine fact, and the next person to audit the mail path
would find a "sent" mail no transport ever saw.

**The routing warning named the wrong population.** W1 enumerated every active
`manager`/`admin` USER, while the permission it warns about —
`canActOnApRequest` — consults the ADR-0046 `ap_approvers` ROSTER (plus
admins). Patrick Dills was never on the roster: he could not first-approve
anything, so there was no admin fallback to warn about, yet the digest called
him an "active approver". The warning and the permission disagreed about who
an approver is; the permission is the authority.

## Decisions

**D1 — An out-of-band filing is its own fact.** Three columns on
`ap_requests`: `decision_mail_filed_out_of_band_at` / `_by` (bare audit-actor
user id, matching `decided_by`) / `_note`. The shared predicate funnel
(`isDecisionMailUnsent`, `isDecisionMailStuck`, `decisionMailUnsentWhere`)
treats a stamped row as not-unsent, so the queue chip, the queue filter/count,
the digest section, and the ntfy fingerprint all clear together — and
`decision_mail_sent_at` stays NULL on these rows forever, truthfully. The
stamp is set by a person's confirmation, never by code inferring one.

**D2 — W1 enumerates the roster, not the roles.** The routing-coverage
warning's population is now `activeApproverUserIds()` (the expiry-aware
ADR-0046 roster) plus active admins — exactly the set that can first-approve.
A manager who is not on the roster is invisible to W1, expired roster rows do
not resurrect their users, and a roster member with no routing row is warned
about whatever their role.

**D3 — The digest's answers executed as data** (one-off
`2026-08-27-adr0129-roster-routing-and-bn1.ts`, dry-run-first, idempotent,
audited): Daven Stetson off the roster by expiry (`active_until = now`, the
Kelsey pattern — the daily expiry job deletes and audits); Patrick Dills onto
the roster and routed Patrick → Rick Albritton via `saveRoutingRow` (24 h
fallback default); the four BN-1 rows stamped out-of-band with the note naming
Mary's filing and Bill's confirmation.

## Alternatives considered

- **Stamp `decision_mail_sent_at` for the hand filings.** Rejected — ADR-0117
  made that stamp transport-confirmed only; a laundered stamp poisons every
  future audit of the mail path.
- **Re-send the four mails.** Rejected by Bill — accounting already has them;
  a duplicate filing creates the reconciliation noise the AP pipeline exists
  to remove.
- **A dismiss/acknowledge flag on the digest line.** Rejected — it would clear
  the surface without recording WHAT was true (who filed, when confirmed), and
  the queue chip and sweep would still disagree with the digest.
- **Remove Daven's roster row outright.** Rejected — expiry-then-reap keeps
  the row's history and reuses the audited deletion path that already exists.
- **Leave W1 role-based and add Patrick to the roster anyway.** Patrick joins
  the roster regardless (Bill's call), but leaving W1 role-based keeps a
  standing false positive for every future manager account that is not meant
  to approve — Daven would have reappeared in the digest the day after his
  roster row expired.

## Consequences

- A future hand-filed decision needs this same stamp; until an admin UI
  exists, that is a one-off script or a direct authorized write. Registered as
  a residual (OPEN-ITEMS 0.BQ) rather than built speculatively.
- The out-of-band columns are invisible in the queue UI (the chip simply
  clears). The record lives in the columns and the audit row.
- W1 no longer watches non-roster managers; a manager who SHOULD approve but
  was never added to the roster is now surfaced by nothing until someone
  notices they cannot act. That was equally true before (the role-based W1
  named them only as a routing gap, not a roster gap) — accepted.

## Verification

- New tests watched red first: out-of-band predicate behavior
  (decision-mail.test.ts), queue badge/filter/count exclusion
  (queue-decision-mail.test.ts), and three W1 roster-semantics pins
  (morning-digest.test.ts). Full AP suite 423 green after.
- The one-off's dry run against production printed the exact four request ids,
  the roster/routing legs, and was applied only after review; post-apply state
  queried back (roster row expired, routing row present, four stamps set).
