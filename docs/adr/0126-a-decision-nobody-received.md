# ADR-0126 — A decision nobody received

- **Status:** Accepted
- **Date:** 2026-08-25
- **Follows:** ADR-0114 (a refusal is not a delivery); ADR-0046 §3 (decision mail); ADR-0047 (notifyStaff chokepoint); ADR-0066 §1.7 (the 06:00 digest)
- **Grading:** ADR-0036 (transport), ADR-0037 (noise)

## Context

Two AP rejections were decided in Vision and accounting was never told:

| Request                                | Rejected   | Mail |
| -------------------------------------- | ---------- | ---- |
| `1ee8e502-f15c-4e15-9b78-1415f2251847` | 2026-07-31 | none |
| `74daa199-6b6a-4974-90f8-b156183b1722` | 2026-08-19 | none |

Both were refused by the Graph transport as oversize, so `sendDecisionEmail`
returned `'too_large'` and `decision_mail_sent_at` was never stamped. Neither was
re-sent. The first sat for nineteen days.

ADR-0114 fixed the CAUSE — the upload-session transport shipped 2026-08-19 and
that particular refusal cannot recur. **This ADR is not about that cause**, and
treating it as the fix is the mistake worth naming: `sendDecisionEmail` has at
least five ways to return without stamping, and ADR-0114 closed exactly one.

1. `refused_no_recipients` — pages today.
2. `too_large` — pages today; cause closed by ADR-0114.
3. `failed` (transport delivered to nobody) — `log.warn` only.
4. `'disabled'` (M365 unset or credentials unresolved) — **returned in complete
   silence**: no error log, no page, no stamp.
5. A crash between the decide commit and the send — leaves no trace at all.

From outside, all five are the same object: a decided row, and an accounting
inbox that never received anything. The uncomfortable part of the review is that
the two known orphans were found by **a human reading rows** — no monitor, no
digest line, no badge, nothing on any dashboard was capable of reporting them.
Fixing the fifth cause would still leave four, and the sixth cause has not been
written yet.

There was one existing surface for it: the words "decision email NOT confirmed
sent", rendered **inside the detail pane** of a single request
(`ApQueueClient.tsx`). Finding the two orphans through that surface would have
required opening every decided request one at a time. Nobody does that, which is
why nobody did.

## The decision

**D1 — Detect the STATE, not any one cause.** The sweep asks a single question:
_is this row decided, with no evidence its notice went out?_
(`status IN ('approved','rejected') AND decision_mail_sent_at IS NULL`). That is
true regardless of which of the five paths produced it — including paths added
after today. No new column: `decision_mail_sent_at` already carries the fact, and
the absence of a stamp already IS the signal.

**D2 — It rides the 06:00 digest (ADR-0066 §1.7), not a new scheduler.** The
digest already fires daily, already reaches Bill by pref, and already has the
DB. It gets a section AND a `warnings` line — both, because a warning sends when
the queue is otherwise empty, and an all-quiet queue is precisely the condition
under which an unmailed decision would otherwise stay invisible: nothing pending
means nothing else would have sent the digest at all. An unmailed decision raises
the digest to `high` at **any** age; the 3-day bar exists because a pending
invoice is merely slow, whereas an undelivered decision is already broken.

**D3 — The page is graded `high` with a week-long, set-keyed cooldown.** Against
the ADR-0037 five-question gate: actionable in five minutes (re-send from the
queue) — yes; customer-visible — no, which is why it is `high` and not `urgent`;
self-healed first — n/a, nothing retries; deduplicated — yes, see below; routes
usefully — tier-1 deep link for a single row, tier-2 AP queue for several.

The fingerprint is derived from the **sorted set of stuck request ids**. This is
the difference between a real dedup key and a decorative one: a constant key
would swallow a genuinely new failure for a week, and a per-run key (the digest
day, a timestamp) would defeat suppression entirely and page every morning
forever about a row whose fix is a human decision. Set-keyed, the same backlog
stays quiet and a NEW stuck decision changes the key and pages that morning.

Suppression is only safe because **the page is not the durable surface**. The
digest line reappears every single morning until the row clears, and the badge is
on the row itself. Two caveats recorded honestly: `publishNtfy` holds cooldowns
in-process, so an app restart re-pages once (erring toward one extra page, the
correct direction); and the digest is weekday-only, so a Saturday failure is
reported Monday — accepted, because the alternative is a second scheduler with a
second calendar, which ADR-0066 §1.5 exists to prevent.

**D4 — One predicate, three readers.** `src/lib/ap/decision-mail.ts` owns the
rule; the digest sweep, the queue list badge and the detail view all import it. A
badge that disagreed with the 06:00 alarm would teach operators to trust neither.
The grace window is layered on top for the sweep ONLY — the badge deliberately
has none, because the badge is passive and a grace there would hide a real
failure for twenty minutes from the one person able to act on it immediately.

**D5 — A decided row with a NULL `decided_at` counts as stuck.** That combination
should be impossible. If it occurs we cannot tell when it was decided, and "we
cannot tell" must surface rather than fall through the grace check into permanent
invisibility — the same shape of silence this ADR exists to end.

**D6 — The queue list shows it.** A red `mail not sent` chip on the row, and a
`mail not sent` filter tab that renders **only when the count is non-zero** (or
is the active tab). A permanent zero-state tab is clutter that trains the eye to
skip it; a tab that appears exactly when something is wrong is a signal.

**D7 — `'disabled'` stops being silent.** It now logs at error and pages, keyed
on the OUTAGE (`ap-decision-mail-disabled`) rather than the request that happened
to hit it — a credential expiry takes out every decision mail at once, and a
per-request key would page once per decision for the duration. It stays fail-OPEN
(a mail outage must never roll back a committed decision); only the silence ends.
D1 remains the backstop that catches it even if this page is missed.

**D8 — The CC set is audited.** `notify_staff` recorded `intended`/`actual` TO
addresses and dropped CC entirely — so during this review, _"was Mary actually
copied?"_ was **not answerable from data**. The AP decision mail puts the
forwarder in TO and the `ap_decision_recipients` roster in CC, meaning the audit
recorded the one address nobody was asking about and omitted the one everybody
was. Now recorded as `cc` + `cc_count`. Absent on pre-existing rows; readers must
treat a missing key as _unknown_, never as _no CC_.

**D9 (cosmetic) — the NOT-DR3 reason renders once.** A NOT-DR3 filing put
`decision_note` in the location slot; on a reject `effectiveNote` resolved to the
same value and emitted it again as "Note:". Mary received every NOT-DR3 rejection
with its reason stated twice, which reads as two facts and invites a hunt for a
difference that is not there. The location slot wins (bolded, mirrored into the
subject).

## Alternatives rejected

- **Re-send automatically on detection.** Rejected. An oversize refusal is not
  fixable by re-sending (ADR-0114), and a decision notice is an accounting
  record — silently re-mailing weeks-old decisions could duplicate a filing Mary
  has already made by hand. Detection is the deliverable; the re-send stays a
  human decision.
- **A `decision_mail_failed_at` / failure-reason column.** Rejected: a second
  representation of a fact the absent stamp already carries, needing a migration
  and a writer on every failure path — including the crash path, which by
  definition cannot write one.
- **A dedicated scheduler for the sweep.** Rejected per ADR-0066 §1.5 — a second
  calendar is a second thing to get wrong across the DST seam.
- **Alerting only, no digest line.** Rejected: an ntfy cooldown long enough to
  not be noise is long enough to lose the only notice. The digest is the surface
  that repeats until cleared.
- **A permanent "mail not sent (0)" tab.** Rejected — see D6.

## Consequences

- The two orphans in the table above **will appear in the first digest after
  deploy and will page once**. That is the instrument working, not a regression.
  They are deliberately NOT re-sent here — Bill is deciding that separately — and
  they will keep appearing every morning until he does.
- `buildApMorningDigest` runs one additional indexed-status query per fire, and
  the AP queue list runs one additional `count()` per load. Both are trivial at
  this table's size.
- An existing digest test (`is empty even with DECIDED history in the table`) had
  fixtures whose decided rows left `decision_mail_sent_at` null. Its subject —
  closed work does not reopen the digest — is preserved by stamping the fixtures;
  "closed" now means the notice actually went out. A sibling test pins the
  unmailed case.

## Follow-ups

1. **`notifyStaff` passes `cc` through in PILOT mode.** Confirmed by reading
   `notify-staff.ts`: the TO set reroutes to admins, but `args.cc` is forwarded to
   the transport unchanged in both modes — so a surface in pilot still copies its
   real CC roster. It does not bite today (`ap_notify` is live at both sites), and
   it was left alone here because changing it silently alters who receives the
   equipment-request mail. D8's audit now makes it visible in the data. Needs its
   own decision.
2. The `failed` path (transport delivered to nobody) still only `log.warn`s.
   D1 catches it the next morning, which is why this is a follow-up and not a
   blocker, but it is the last decision-mail path with no immediate signal.
