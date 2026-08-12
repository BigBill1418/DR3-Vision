# Floor dead-end state inventory — every state a floor surface can render

**Date:** 2026-08-11 (Pacific)
**Audit window:** repo at `origin/main` `02c3981`; production verified against
`dr3-vision-app` / `dr3-vision-postgres` on CHAD-HQ, database `dr3_vision`.
**Scope:** the code-level half. A separate pass covers the systemic/process
question. This document answers one question exhaustively: _where else can a
floor-facing surface show an operator information and attach no action?_

**Definition used throughout.** A **dead end** is a rendered state that names a
condition and offers no way to resolve it. A dead end **with** an explanation and
an escalation path ("not turned on yet — ask a manager") is acceptable and is
classified as such. A **bare dead end** — a sentence with no control, no reason,
and no named person — is the defect. A **silent no-op** — a control that resolves
to nothing — is the worst case, because the operator cannot tell the app from
their own mistake.

---

## 0. Immediate risk — does anything strand the floor tomorrow morning?

**No. Nothing found in this audit will strand a truck at 07:00 PT on 2026-08-12,
and no immediate unblock is proposed.** That conclusion is measured, not assumed:

| Check                                                     | Result at 2026-08-11 17:44 PT                                    |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| Slots dated tomorrow (2026-08-12 PT)                      | 8 — 7 `Confirmed` + 1 `Delivered`, all uncancelled               |
| …last synced                                              | all at 2026-08-11 17:00 PT (current scrape)                      |
| …consumed already                                         | 0 of the 7 `Confirmed`                                           |
| Open dock loads right now                                 | 1 — H-136980, `in_progress`, Janette Tomas, since 17:37 PT       |
| Slots in the day-bound trap that a truck may still honour | 2 (H-135474 appt 7/27, H-134621 appt 7/24 — both >2 weeks stale) |
| Appointment/mirror drift rows                             | 1 (H-136980, and it is already consumed, so it routes)           |

The one live open load (H-136980) is **consumed**, and the consumed path is not
day-bounded, so it keeps its Resume route across Pacific midnight. It is safe.

**The standing risk that could bite on any given morning** is §3 D-2 below (the
scrape's stale-haul sweep cancelling a slot before its truck arrives). It has
fired **16 times pre-appointment** in the last three weeks — roughly 0.75/day —
and there is no mitigation in place. It did not arm itself for tomorrow, but it
is the highest-probability repeat of this week's incidents.

---

## STATUS — week-one remediation (2026-08-11/12, Pacific)

This document was written at `origin/main` `02c3981` and reached `main` for the
first time with the remediation itself. Status is tracked HERE, in the inventory,
rather than in a separate register — `docs/OPEN-ITEMS.md` is 2,024 lines and
ADR-0094 RC-4 measured what that costs: ~42 forward promises across 13 floor
ADRs, **not one carrying an issue number**.

| #    | Status                                                                                                                                   | Where               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| D-1  | **PARTLY CLOSED** — the day-bound half shipped as ADR-0096 (`reconcilableExpectedLoadId`). The `cancelled` discriminator ships with D-2. | ADR-0096 (#241)     |
| D-2  | **CLOSED**                                                                                                                               | ADR-0099            |
| D-3  | **CLOSED** — `src/app/operator/not-found.tsx`. Shipped WITHOUT the iPad hand-check the finding asked for; see the note under D-3.        | dead-end batch      |
| D-4  | **CLOSED**                                                                                                                               | dead-end batch      |
| D-5  | **CLOSED** — both surfaces, one commit                                                                                                   | dead-end batch      |
| D-6  | **CLOSED**                                                                                                                               | dead-end batch      |
| D-7  | OPEN — not in week-one scope                                                                                                             | —                   |
| D-8  | **CLOSED** before this batch                                                                                                             | `write-refusal.tsx` |
| D-9  | **CLOSED**                                                                                                                               | dead-end batch      |
| D-10 | OPEN — error-contract batch (M)                                                                                                          | —                   |
| D-11 | OPEN — error-contract batch (M)                                                                                                          | —                   |
| D-12 | OPEN — error-contract batch (M)                                                                                                          | —                   |
| D-13 | OPEN — error-contract batch (M)                                                                                                          | —                   |
| D-14 | **CLOSED** — fail-closed adopted as the house rule                                                                                       | dead-end batch      |
| D-15 | **CLOSED**                                                                                                                               | dead-end batch      |
| D-16 | OPEN — error-contract batch (S)                                                                                                          | —                   |
| D-17 | **CLOSED** — and two tests that PINNED the defect were corrected; see below                                                              | dead-end batch      |
| D-18 | **CLOSED**                                                                                                                               | dead-end batch      |
| D-20 | **CLOSED**                                                                                                                               | dead-end batch      |
| D-21 | **CLOSED**                                                                                                                               | dead-end batch      |
| D-22 | **CLOSED** — and the finding's stated mechanism was WRONG; see below                                                                     | dead-end batch      |
| D-23 | **CLOSED**                                                                                                                               | dead-end batch      |
| D-24 | **CLOSED**                                                                                                                               | dead-end batch      |
| D-25 | **CLOSED**                                                                                                                               | dead-end batch      |
| D-26 | **CLOSED**                                                                                                                               | dead-end batch      |

**Sixteen of the twenty-five closed** (D-2, D-3, D-4, D-5, D-6, D-8, D-9, D-14,
D-15, D-17, D-18, D-20, D-21, D-22, D-23, D-24, D-25, D-26 — eighteen counting
D-8 and the ADR-0096 half of D-1). The nine left open are D-1's residual, D-7,
D-10 – D-13 and D-16: the error-contract batch, all M, all deliberately deferred.

### Three corrections the remediation forced on this document

1. **D-22's mechanism was mis-stated.** The finding says uploads-blocked rows
   "fall to the catch-all `why_refused`". They do not: `listConflicts` filters
   strictly on the `conflict:` prefix (`offline-queue.ts`), so a `blocked:` row
   **never reaches the conflicts screen at all**. The sentence was not losing a
   race with the catch-all — there was no surface for it to lose on, and blocked
   photos had no screen anywhere. Fixed by adding `listBlocked()` and its own
   section, and by routing the chrome's uploads-blocked pill at it.

2. **A fourth copy of the status map existed, with a dangerous fallback.**
   D-4 named `held-by-panel.tsx` as the map to reuse. `open-loads.tsx` carried a
   five-entry copy whose fallback was `queue.open_status_in_progress` — i.e. a
   closed load was labelled "Counting", the exact confident-wrong-answer
   ADR-0074 Am.1 fixed one directory away. Its own comment named the hazard and
   kept it. All three copies are now one module with an enum-walking guard.

3. **Two existing tests pinned D-17 as the contract.**
   `photo-input.auth.test.tsx` asserted `toContain('mint failed (403)')` and
   `toContain('mint failed (500)')` — i.e. the suite REQUIRED the untranslated
   developer string to reach a trilingual floor iPad. Their intent (a 500 is
   still an error; a 403 must not offer a sign-in) was right and is preserved;
   the evidence is now the translated sentence, plus an explicit assertion that
   the raw token is gone.

### One thing measured here that changes D-2's severity

The finding reports 69 auto-cancellations, 16 of them pre-appointment. Re-run at
2026-08-11 22:04 PT, the audit trail also shows **67 of those 69 were later
UN-cancelled by a subsequent scrape** — 30 of them by the very next hourly pass.
Only 2 in the entire history were genuine retirements. The sweep was not retiring
dead hauls; it was FLAPPING. See ADR-0099.

---

## 0b. Findings at a glance

25 live findings. "Live rows" = rows or paths currently in that state in
production, measured 2026-08-11 17:44 PT.

| #    | Finding                                                      | Sev      | Live rows                              | Effort |
| ---- | ------------------------------------------------------------ | -------- | -------------------------------------- | ------ |
| D-1  | "View only" is three refusals under one label                | HIGH     | 2 actionable (+689 inert)              | S      |
| D-2  | Scrape cancels a slot before its truck arrives               | HIGH     | 16 historical firings; 2 cancelled now | M      |
| D-3  | `notFound()` escapes the operator layout (5 call sites)      | HIGH     | path defect                            | S      |
| D-4  | `Unhandled status` — bare developer string, no control       | MED-HIGH | 0 — **one void away**                  | XS     |
| D-5  | "Already worked" with no units and no date                   | LOW-MED  | 2                                      | XS     |
| D-6  | Site-level empty states end the conversation                 | LOW      | Eugene, on ramp                        | XS     |
| D-7  | Five refusals compressed to `{"error":"error"}`              | MED      | all write paths                        | S      |
| D-8  | Online `date_not_today` is a true silent no-op               | MED-HIGH | 4 clients; every cross-midnight page   | S      |
| D-9  | Manager-hold screen can become unescapable                   | MED      | path defect                            | XS     |
| D-10 | `stack_index_conflict` retries into itself forever           | MED      | path defect                            | S      |
| D-11 | Six `setError(e.message)` render Next's redaction            | MED      | all stage errors                       | M      |
| D-12 | Four stage actions have no `catch` at all                    | MED      | path defect; every offline tap         | M      |
| D-13 | Queued 5xx retries forever, reaches no screen                | MED      | unknown (device-side)                  | M      |
| D-14 | Conflicts screen claims "nothing stuck" on IndexedDB failure | LOW-MED  | path defect                            | XS     |
| D-15 | Copy names a destination, withholds the link                 | LOW      | 3 strings                              | XS     |
| D-16 | Eight disabled buttons with no adjacent reason               | LOW      | 8 sites                                | S      |
| D-17 | Untranslated English technical strings; 403 → infinite Retry | LOW-MED  | 3 sites                                | XS     |
| D-18 | Site picker: no empty state **and** no chrome exit           | LOW      | 0 — latent                             | XS     |
| D-20 | Cancelled `window.prompt` gives zero feedback                | LOW      | 2 sites                                | XS     |
| D-21 | "Count removed." terminal card, no control                   | LOW-MED  | path defect                            | XS     |
| D-22 | `why_upload_blocked` written, unreachable                    | LOW      | dead copy                              | XS     |
| D-23 | Two surfaces render the iPad's own clock, not Pacific        | LOW-MED  | 2 sites                                | XS     |
| D-24 | Add-concern control vanishes after one use                   | LOW      | path defect                            | XS     |
| D-25 | Unsent stack looks identical but has no Remove               | LOW-MED  | offline only                           | XS     |
| D-26 | Chrome's two most useful sentences are in `title=`           | LOW-MED  | always                                 | XS     |

Thirteen of the twenty-five are XS. The copy-and-route batch (item 6 in §5) closes
eleven of them in one PR.

## 1. The family, stated once

Both incidents this week and every finding below are the same shape:

> The affordance is computed from a field that something else can change, and the
> surface that loses the affordance does not say so.

- **Incident 1 (ADR-0091)** — the field was `assigned_operator_id`, absent from
  the card's data. Fixed by `describeConsumedSlot`, with `it.each` chokepoint
  guards over both rendering surfaces.
- **Incident 2 (ADR-0074 D5)** — the field is `expected_arrival_at`, and the
  bound is the current Pacific day. Durable fix in flight by another agent;
  **this audit deliberately does not touch it.**

What the inventory below adds is that `expected_arrival_at` and `cancelled_at`
are **not stable inputs**. A background job rewrites both, several times a day,
under an operator who is looking at the screen. That is D-2, and it is the
finding with the most live rows behind it.

---

## 2. State matrix — surface × state

Legend: **CONTROL** = a route or working handler is attached · **EXPLAINED** =
no control, but names why and who to ask (acceptable) · **BARE** = no control, no
reason (defect) · **NO-OP** = a control that resolves to nothing (worst).

### 2.1 `/operator/[site]/hauls` — the open portal-haul list

| #   | Condition (`hauls-client.tsx`)                         | Operator sees                                   | Verdict              |
| --- | ------------------------------------------------------ | ----------------------------------------------- | -------------------- |
| H1  | `!live` (rollout gate, page.tsx:102)                   | "Not turned on yet — ask a manager"             | EXPLAINED            |
| H2  | `consumedLoad && open`, holder = viewer (:184)         | "Resume — yours" → `/load/<id>`                 | CONTROL              |
| H3  | `consumedLoad && open`, holder ≠ viewer (:184)         | "Started by {name}" → held-by panel + Take over | CONTROL              |
| H4  | `consumedLoad && !open`, units + date known (:203)     | "Already worked — 159 units, 5 Aug"             | EXPLAINED            |
| H5  | `consumedLoad && !open`, units or date null (:174)     | "Already worked"                                | **BARE** (D-5)       |
| H6  | `expectedLoadId` non-null (:210)                       | "Check in" → `startLoadAction`                  | CONTROL              |
| H7  | **else** (:220) — not today, undated, **or cancelled** | "View only"                                     | **BARE** (D-1 / D-2) |
| H8  | `rows.length === 0 && hasAnyHauls` (:320)              | "No matches" + Clear button on screen           | CONTROL              |
| H9  | `rows.length === 0 && !hasAnyHauls` (:320)             | "No portal hauls for this site."                | **BARE** (D-6)       |

**H7 is the branch that carries three unrelated conditions under one four-letter
label.** `portal-hauls.ts` reaches it three ways: appointment not on the current
Pacific day (:381), no `expected_loads` sibling at all, and — the one nobody has
written down — `cancelled_at !== null` (:363, a bare `continue` that emits no
verdict). The operator gets the identical two words for all three.

### 2.2 `/operator/[site]/queue`

| #   | Condition (`queue/page.tsx`)              | Operator sees                                                     | Verdict        |
| --- | ----------------------------------------- | ----------------------------------------------------------------- | -------------- |
| Q1  | `!queueLive` (:98)                        | "Not turned on yet — ask a manager"                               | EXPLAINED      |
| Q2  | consumed + `worked` (:252)                | "Already worked …" read-only card                                 | EXPLAINED      |
| Q3  | consumed + `resume`/`held` (:267)         | link to `/load/<id>`                                              | CONTROL        |
| Q4  | not consumed (:284)                       | `QueueRow` → `startLoadAction`                                    | CONTROL        |
| Q5  | `loads.length === 0` (:189)               | "Nothing expected today" + last-sync time, inside pull-to-refresh | EXPLAINED      |
| Q6  | **`cancelled_at !== null`** (:127 filter) | **the row is not rendered at all**                                | **BARE** (D-2) |

**Q6 is the sharpest asymmetry in the codebase.** The queue filters cancelled
slots out (`cancelled_at: null`); the hauls screen renders them as "View only".
So a truck whose slot was cancelled is _invisible_ on one surface and
_unexplained_ on the other. This is structurally the same split that ADR-0091
called out — "one surface had a way out and the other did not" — except here
neither surface has one.

### 2.3 `/operator/[site]/load/[id]` — the workflow

| #   | Condition                                         | Operator sees                                                     | Verdict                          |
| --- | ------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------- |
| L1  | gate off (`page.tsx:60`)                          | "Not turned on yet"                                               | EXPLAINED                        |
| L2  | `!load \|\| site mismatch` (:117)                 | `notFound()` → **root 404, outside the operator layout**          | **BARE** (D-3)                   |
| L3  | `heldByOther`, takeable (:136)                    | held-by panel + Take over + Back to queue                         | CONTROL                          |
| L4  | `heldByOther`, `!takeable` (:235 of panel)        | "Ask a manager" + Back to queue link                              | EXPLAINED                        |
| L5  | `submitted` / `rejected` (`load-workflow.tsx:83`) | "Load submitted" + **Back to queue**                              | CONTROL (fixed by ADR-0074 Am.1) |
| L6  | **status not in `STAGE_STATUSES`** (:130)         | `<p>Unhandled status: voided</p>` — **that is the entire branch** | **BARE** (D-4)                   |
| L7  | the five open statuses                            | the seven stages                                                  | CONTROL                          |

**L6 is the branch ADR-0074 Amendment 1 fixed for `submitted`/`rejected` and did
not fix for the rest of the enum.** Its sibling three lines above carries the
comment _"A dead end with reassuring copy is worse than a bare dead end"_ and a
`<Link>` to the queue. L6 got neither.

### 2.4 Write-path states (from the API sweep)

| #   | Condition                                                                 | Operator sees                                                                    | Verdict          |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------- |
| W1  | 401/403/404 from any auth or rollout guard                                | `{"error":"error"}` → "Save failed"                                              | **BARE** (D-7)   |
| W2  | `422 date_not_today` online (count, dropoff, processed, inbound)          | "Save failed", forever, on every retap                                           | **NO-OP** (D-8)  |
| W3  | `422 date_not_today` **queued offline**                                   | named reason + "Re-submit to today" button                                       | CONTROL          |
| W4  | 404 `hold_not_found` / 409 hold not pending                               | "Save failed" on both controls, no route out of the hold screen                  | **NO-OP** (D-9)  |
| W5  | 409 `stack_index_conflict`                                                | redacted message; `nextIndex` unchanged → every retap re-earns the same 409      | **NO-OP** (D-10) |
| W6  | Server Action throw, production build                                     | Next redacts `e.message`; six `setError(e.message …)` sites render the redaction | **BARE** (D-11)  |
| W7  | `stage-bol` / `stage-door` / `stage-decision` / `stage-weight`-skip throw | no `catch` at all → route error boundary; stage state destroyed                  | **BARE** (D-12)  |
| W8  | queued write fails 5xx / R2 non-conflict                                  | stays `active` forever; never reaches the conflicts screen; backoff inert        | **BARE** (D-13)  |
| W9  | queued write fails 4xx                                                    | conflicts screen, named reason, Retry/Discard                                    | CONTROL          |

### 2.5 Remaining floor surfaces — condensed

Full branch-by-branch enumeration was produced for all 25 remaining files; the
states that are **not** CONTROL or EXPLAINED are listed here. Everything omitted
is correctly controlled.

| Surface                        | State                                                                                                                    | Verdict                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `/operator` site picker        | `sites.length === 0` — no branch exists; heading renders over an empty `<ul>` (`page.tsx:34-45`)                         | **BARE** (D-18)                 |
| `/operator/[site]` name picker | `!site → notFound()` (:31)                                                                                               | **BARE** (D-3)                  |
|                                | `operators.length === 0` (:76) — "Ask a manager to add you in the portal"                                                | EXPLAINED                       |
| `/[site]/[userId]` PIN         | `notFound()` × 2 (:30, :42-49) — incl. an operator deactivated mid-shift                                                 | **BARE** (D-3)                  |
| `keypad.tsx`                   | `busy` — whole pad at 40% opacity, no "Signing in…" (:103,107,110)                                                       | disabled, unexplained (D-16)    |
|                                | locked account and wrong PIN share `keypad.error_incorrect` (:57-62)                                                     | EXPLAINED (weak)                |
| `/today` hub                   | `cards.length === 0` (:169-180) — page itself is **never** gated; only the balance tile reads `IPAD_TODAY_SUMMARY`       | EXPLAINED ✅                    |
| `/inbound`                     | `initialRows.length === 0` (:94-96) "No recent inbound days." bare `<p>`                                                 | **BARE** (D-6)                  |
|                                | `per_load_locked` (:200) names the queue in prose, no link                                                               | (D-15)                          |
| `/count`                       | `phase === 'held'` (:329-404) — control + `hold_remote_note` off-ramp                                                    | CONTROL ✅                      |
|                                | `discard()` prompt cancelled (:231) — returns silently, zero feedback                                                    | **NO-OP** (D-20)                |
| `void-client`                  | `phase === 'done'` (:121-130) "Count removed." terminal card, no control                                                 | **BARE** (D-21)                 |
| `/dropoff`                     | no 401/`isSignedOut` branch anywhere (:112,131,151,159); body never parsed                                               | **BARE** (D-7/D-8)              |
| `/processed`                   | `closed` (:90-96) "Today is closed. Ask an admin to reopen it."                                                          | EXPLAINED ✅                    |
| `/queue/conflicts`             | IndexedDB throws (:66-72) → renders "Nothing is stuck"                                                                   | **ERROR SWALLOWED** (D-14)      |
|                                | `date_not_today` on **inbound/processed** scope — Retry that cannot succeed, no "a manager must fix this" (:233)         | **BARE** (D-8)                  |
|                                | `why_upload_blocked` defined in all three locales, never returned by `reasonLabel` (:167-186)                            | dead copy (D-22)                |
|                                | `whenLabel` (:189) — device-local `toLocaleString()`                                                                     | TZ defect (D-23)                |
| `open-loads.tsx`               | every branch links                                                                                                       | CONTROL ✅                      |
| `stage-finish`                 | after one concern the add-concern control disappears, unexplained (:93,153-157)                                          | **BARE** (D-24)                 |
| `review-panel`                 | `tmp-` stack renders identically to an acked one but silently has no Remove (:277,295)                                   | **BARE** (D-25)                 |
|                                | `!correctable` (:353-360) — control withheld, cause stated, self-heals by polling                                        | **reference implementation** ✅ |
| `photo-input`                  | 401 → `photo.signed_out` + hand-off to the chrome sign-in link                                                           | **reference implementation** ✅ |
|                                | 403 → falls to "Retry {{label}}" forever (:73-76)                                                                        | **NO-OP** (D-17)                |
| `connection-state`             | `uploads_blocked_detail` and `never_synced` live in `title=` attributes (:109-115) — **never surface on a touch iPad**   | invisible copy (D-26)           |
|                                | `last_sync` (:114) — device-local `toLocaleTimeString()`                                                                 | TZ defect (D-23)                |
| `floor-nav.ts`                 | `siteCode === null` (`/operator`) → `backHref: null`, `showLogOut: false` (:57-59)                                       | no chrome exit — compounds D-18 |
|                                | a new route not added to `WORK_SEGMENTS` (:27-36) falls through to the userId branch → black chrome, no Back, no Log Out | latent BARE generator (§6)      |

---

## 3. Ranked dead ends — repro, live rows, fix shape

Ranked by **expected floor cost** = (will it strand a real truck or operator?) ×
(how many rows/paths are live in it now).

---

### D-1 — "View only" is three different refusals wearing one label

**Severity: HIGH (strands a truck). Live rows: 2 actionable + 691 inert.**

`hauls-client.tsx:220-230`. The else-branch renders `floor.hauls.view_only` — two
words, no reason, no date rule, no person to call — for a row that failed _any_
of three unrelated tests in `portal-hauls.ts`.

**Repro.** A truck arrives a day after its appointment. Operator searches the
haul number on `/hauls`. Card renders with the appointment date and "View only".
Tapping does nothing. This is incident 2, 2026-08-11.

**Live rows.** 691 uncancelled/unconsumed past-dated slots at Woodland, but only
**2** are still `Confirmed` in the mirror (H-135474 appt 2026-07-27, H-134621
appt 2026-07-24) — the other 689 are `Delivered` and inert. So the _day-bound_
part of this is a 2-row trap today, not a 691-row one.

**Fix shape.** _A durable fix for the day-bound case is in flight by another
agent — do not duplicate it._ What that fix must **also** cover, and what this
audit adds: the branch needs to know **which** of the three conditions it is in.
Have `portal-hauls.ts` return a discriminated `reason`
(`'not_today' | 'no_sibling' | 'cancelled'`) alongside the null id, exactly as
`SiblingVerdict` already models the consumed case, and let the card say the
matching sentence. The existing `describeConsumedSlot` module is the precedent:
one shared function, both surfaces, a union so an unhandled case is a type error.

**Effort:** S (½ day) _on top of_ the in-flight day-bound fix.

---

### D-2 — The scrape cancels a slot before its truck arrives, and both surfaces go quiet

**Severity: HIGH (strands a truck; no mitigation). Live rows: 16 historical firings, 2 currently cancelled.**

`src/lib/mymrc/upsert.ts:282-311`. Every scrape sweeps `expected_loads` in the
window `[startOfUtcDay(now), +7 days]` and sets `cancelled_at = now` on any
uncancelled row absent from that pass. The code's own comment two blocks up
(:222-224) admits the input is unreliable: _"MyMRC sometimes drops then re-adds a
haul during operator edits."_ Between the drop and the re-add the floor is blind,
because:

- the queue filters `cancelled_at: null` → **the row vanishes entirely** (Q6);
- the hauls screen hits `continue` at `portal-hauls.ts:363` → **"View only"** (H7).

**Measured in production.** 69 auto-cancellations total; **16 fired before the
appointment**, i.e. while the truck could still show up. The worst:

| Haul     | Auto-cancelled      | Appointment         | Lead time     | Had a load worked? |
| -------- | ------------------- | ------------------- | ------------- | ------------------ |
| H-136271 | 2026-08-03 17:00 PT | 2026-08-10 07:00 PT | 158 h early   | no child           |
| H-135933 | 2026-07-30 17:00 PT | 2026-08-06 15:00 PT | 166 h early   | no child           |
| H-135570 | 2026-07-28 19:00 PT | 2026-08-04 15:00 PT | 164 h early   | no child           |
| H-136699 | 2026-08-10 11:00 PT | 2026-08-10 14:00 PT | **3 h early** | worked             |

13 of the 16 have **no `inbound_loads` child at all** — the haul reads
`Delivered` in MyMRC but was never worked through the iPad workflow.

**Precise scope — this strands CHECK-IN, not resumption.** Once a load has been
started, `listSiteOpenLoads` (`open-loads.ts:150-158`) rescues it: that listing is
deliberately unbounded in time and filtered only on a non-terminal dock status, so
the queue's "unfinished work" block shows it regardless of what happens to the
parent slot. The exposure is the window _before_ the first tap — which is exactly
where a truck on the dock lives.

Note that `open-loads.ts:22-23` **already names this cancellation as a real
production event** — "`cancelled_at: null` — MyMRC can cancel the expected row
after the dock work is already done", one of three filters that stranded three
Woodland loads on 2026-07-30. ADR-0065 Am.1 applied that insight to the
_post-start_ case and closed it. Nobody applied it to the _pre-start_ case, and
that is D-2.

**Secondary defect in the same block.** The window uses `startOfUtcDay(now)`
(:286), not the Pacific day every read surface bounds on. Between 17:00 PT and
midnight the sweep's "today" is already tomorrow — the exact UTC/Pacific class
ADR-0065 was written to eliminate, still live in the write path. Worth
contrasting: the _read_ helper `currentPacificDayWindow` is DST-correct in both
directions and carries a documented regression test for the fall-back
zero-width-window defect (`time.ts:222-238`, next fall-back 2026-11-01). The
sweep is not on that helper.

**Fix shape.** Three parts, smallest first:

1. Make a cancelled slot **legible instead of absent**: render it on the queue
   with its own sentence ("MyMRC withdrew this haul at 4:00 PM — if the truck is
   here, call the office") rather than filtering it out. This is the ADR-0074
   Am.1 principle ("a vanished row tells the operator standing next to the truck
   nothing at all") applied to the one predicate that still deletes rows.
2. **Do not cancel a slot whose appointment has not passed** on a single missing
   scrape pass. Require N consecutive absences, or restrict the sweep to rows
   already past their appointment. One flaky list view should not retire a truck.
3. Switch the window to the Pacific day helper (`currentPacificDayWindow`) so the
   sweep and the queue agree on "today".

**Effort:** M (2–3 days incl. tests + an ADR). Part 2 alone is S and removes most
of the risk.

---

### D-3 — `notFound()` on a floor route escapes the operator layout

**Severity: HIGH when hit (hard strand on a kiosk iPad). Live rows: n/a — path defect.**

There is **no `not-found.tsx` anywhere in the app** — only `global-error.tsx` and
the ADR-0065 Am.1 `operator/error.tsx`. The build confirms only Next's
auto-generated `/_not-found/page`. Five floor routes call `notFound()`:
`load/[id]/page.tsx:52,117`, `queue/page.tsx:86`, `[site]/page.tsx:31`,
`[site]/[userId]/page.tsx:30,48`.

Because the default not-found renders inside the **root** layout, it does not get
`operator/layout.tsx` — so it has no `FloorChrome` (Back, Log Out), no
`I18nProvider`, no green palette. That is precisely the screen ADR-0065 Am.1
described and fixed _for thrown errors only_: "a black, English-only … screen
with ZERO navigation on a SHARED iPad."

**Repro.** Signed-in operator opens `/operator/woodland/load/<any-uuid-not-in-db>`
— reachable from a stale PWA restore, a bookmark, or a load hard-deleted between
render and tap. Expect: English "404 This page could not be found", no Back, no
Log Out. Recovery requires force-quitting the PWA.

**Confidence note.** This is a **structural** finding, verified by file absence
and the build manifest. I could **not** drive it end-to-end: every unauthenticated
probe of the route is intercepted by the auth redirect (confirmed — a request to
`/operator/woodland/load/<zeros>` returns `307 → /operator/woodland`), so I could
not reach line 117 without an operator session. **Worth ten minutes of hand
verification on a real iPad before acting.**

**Fix shape.** Add `src/app/operator/not-found.tsx` mirroring `error.tsx` —
FloorChrome inherited from the route-group layout, translated copy, and a
`<Link>` to `/operator/<site>/today` via `resolveFloorNav`. Consider whether
`load/[id]:117` should render "this load is not at this site" instead of 404 at
all; ADR-0091 already argued the load page is site-scoped, and the page's own
comment at :30 says a 404 "is indistinguishable from 'your load is gone', which
is alarming rather than informative" — a principle it then applies only to the
rollout gate.

**Effort:** S (½ day).

---

### D-4 — `Unhandled status` is a bare developer string on a floor iPad

**Severity: MEDIUM-HIGH (armed, blast radius total). Live rows: 0 today — but one void away.**

`load-workflow.tsx:130-132`:

```tsx
if (!STAGE_STATUSES.includes(load.status)) {
  return <p>{t('workflow.unhandled_status', { status: load.status })}</p>;
}
```

The whole branch. No Link, no button, not even a wrapping element. The copy
interpolates a raw enum token — "Unhandled status: voided" — and the Spanish
catalog translates it just as uselessly ("Estado no manejado: voided").

**Which statuses land here:** `verified`, `voided`, `submitted_to_mymrc`,
`processed`. `submitted`/`rejected` are caught three lines above and _do_ get a
Back-to-queue link.

**Reachability, measured.** `voidLoad` (`load-service.ts:932-944`) sets
`status: 'voided'` and nulls `expected_load_id` but **leaves
`assigned_operator_id` intact**. So the operator who voids a load remains its
holder, `heldByOther` is false, and one Back tap after the void redirect lands
them on this paragraph with no way off it. Production has **0 voided loads and 0
void audit rows** — the void panel is live in the workflow and simply has not
been used yet. The first operator to use it hits this.

The 627 `verified` loads do **not** reach here: all 627 carry
`assigned_operator_id IS NULL`, so they route to `HeldByPanel` (which has a
Back-to-queue link and a correct `queue.open_status_verified` label). That is
luck from a different code path, not coverage.

**Fix shape.** Give the branch what its sibling already has: the existing
`queue.open_status_*` labels (the catalog already contains
`open_status_voided` = "Closed as a mistake", `_verified`, `_submitted_to_mymrc`,
`_processed`) plus a `<Link>` to the queue. `held-by-panel.tsx:44-57` already
maintains the full enum→label map **and** an enum-walking test guard for exactly
this failure — reuse both rather than writing a third copy.

**Effort:** XS (1–2 hours). Highest value-per-hour item in this document.

---

### D-5 — "Already worked" with no units and no date

**Severity: LOW-MEDIUM. Live rows: 2 (`rejected` children).**

`hauls-client.tsx:174` and `queue/page.tsx:262`. The fallback when `totalUnits`
or `workedAt` is null. Reachable for a `rejected` child (never submitted, so
`submitted_at` is null). Production has 2 `rejected` inbound loads, one of them
on a cancelled slot. The operator learns the slot is spent but not what happened
or who to ask.

**Fix shape.** Say the status, not just "worked" — the `STATUS_KEY` map already
has `queue.open_status_rejected` = the right words. Same one-line pattern as D-4.
**Effort:** XS.

---

### D-6 — Site-level empty states end the conversation

**Severity: LOW (cosmetic-to-confusing). Live rows: Eugene, permanently.**

`floor.hauls.empty_no_hauls` ("No portal hauls for this site.",
`hauls-client.tsx:320`) and `floor.inbound.empty` ("No recent inbound days.",
`inbound-client.tsx:95` — an early return that replaces the entire screen body).
Both are bare `<div>`/`<p>` with no next action and no explanation.

For Eugene this is the _permanent_ state of the hauls screen — the MyMRC mirror
is Woodland-only by contract — so a Eugene operator who taps through sees a flat
refusal with no indication it is by design. (Eugene's `ipad_hauls` is `pilot`, so
today they get the EXPLAINED gate copy instead; this becomes live-visible the
moment that surface is ramped.)

**Fix shape.** One clause naming why ("this site has no MyMRC portal feed") in
the house `not_activated_body` style. **Effort:** XS.

---

### D-7 — Five distinct refusals are compressed to `{"error":"error"}` before the client sees them

**Severity: MEDIUM (masks every other finding). Live rows: all floor write paths.**

`src/lib/loads/route-helpers.ts:169-173` maps a thrown `Response` by reading
**`statusText`**. Every auth and activation guard throws a **body-only**
`Response` with empty `statusText`:

- `auth-helpers.ts:137` 401 unauthenticated · `:140` 403 wrong role ·
  `:147` 404 unknown site · `:151` 403 operator not at this site
- `route-helpers.ts:62` 403 rollout gate not activated

All five arrive at the floor client as `{"error":"error"}` → "Save failed". The
file's own comment at :86-90 documents this trap and it was fixed only for
`assertCurrentPacificDay` and `readIdempotencyKey`. **No client-side branching can
recover these** — the information is destroyed server-side. This is why so many
rows in §2.4 read "Save failed": in several cases the client is not being lazy,
it is being starved.

**Fix shape.** Throw with `statusText` set (or, better, return the typed
`{error: code}` shape the rest of the surface uses) at those five sites. Then the
existing per-endpoint `errorMessage()` mappers — `inbound-client.tsx:87-92` is
already the good example — can name them.
**Effort:** S (½ day), and it is a **prerequisite** for D-8 and D-9 being fixable.

---

### D-8 — The online `date_not_today` refusal is a true silent no-op

**Severity: MEDIUM-HIGH (repeating tap that can never work). Live rows: every screen left open across Pacific midnight.**

`route-helpers.ts:84-91` refuses any write whose day is not the current Pacific
day. The offline path handles this **well**: `CONFLICT_DATE_NOT_TODAY`
(`offline-queue.ts:58`), a named reason, and a "Re-submit to today" button
(`conflicts-client.tsx:250-259`). The **online** path has none of it —
`count-client.tsx:151-155` and `dropoff-client.tsx:151-155` render
`t('floor.common.save_failed')` and change nothing else.

**Repro.** Operator opens `/operator/woodland/count` at 23:50 PT, is interrupted,
enters counts at 00:05 PT. The server-rendered `countDate` is now yesterday. Save
→ "Save failed". Retap → "Save failed". No refresh, no message naming the day, no
route. This is the midnight-boundary sibling of incident 2, on the write side.

**All four write clients are affected, and none maps the code:**

| Client                       | Error map                                      | `date_not_today` handled? |
| ---------------------------- | ---------------------------------------------- | ------------------------- |
| `inbound-client.tsx:87-92`   | `per_load_exists`, `office_owned`, split regex | no                        |
| `count-client.tsx:151-156`   | `manager_approval_required`, `pool_mismatch`   | no                        |
| `processed-client.tsx:59-65` | `closed`                                       | no                        |
| `dropoff-client.tsx:151-155` | **never parses the body at all**               | no                        |

**The sentence already exists and is already translated into all three locales.**
`floor.conflicts.why_wrong_day` — _"It was for a different day, so it was not
sent. The iPad only files today."_ — is wired into the offline replay path only
(`conflicts-client.tsx:168`). The four live paths never learned it.

**A related negative finding, verified rather than assumed.** I checked whether
any day list renders a _selectable_ past day whose save the server would then
refuse — the obvious sibling defect. **It does not.** `inbound/page.tsx:47` calls
`listFloorInboundDays(siteId, userId, **1**)`, and `floor-inbound.ts:322-325`
bounds the window to today with an explicit no-future-days upper bound; the 14-day
default is never reached from any floor surface. `/count`, `/processed` and
`/dropoff` all pin `pacificDayISO(new Date())` server-side. The UI and the server
pin agree. The exposure is purely the stale-page case above.

**Fix shape.** Map `date_not_today` in all four clients to the existing
`why_wrong_day` string, plus the "Re-submit to today" control the conflicts
screen already implements (`conflicts-client.tsx:250-259`). Every piece of this
fix is already in the repo; it just never crossed from the offline path to the
online one. Same gap for **401** — `photo-input.tsx:73` classifies it and says
"sign in"; none of the four write clients do.
**Effort:** S.

---

### D-9 — The manager-hold screen can become unescapable

**Severity: MEDIUM. Live rows: path defect.**

`count-client.tsx:329-404`. When `phase === 'held'` the only controls are Approve
and Discard. If the hold was already released or discarded from a manager
desktop, Approve returns 404 `hold_not_found` and Discard returns 409 — and both
render `t('floor.common.save_failed')` (:209, :244). There is no `reset()` and no
branch back to `'entry'`. The operator retypes a PIN into a screen that cannot
succeed; escape requires the chrome Back pill.

**Fix shape.** On 404/409 from either control, drop back to `'entry'` with a
sentence ("a manager already handled this hold"). **Effort:** XS.

---

### D-10 — `stack_index_conflict` retries into itself forever

**Severity: MEDIUM. Live rows: path defect (needs two operators on one load).**

`stage-stacks.tsx:65,95`. `nextIndex` is derived from local state, and on failure
`optimistic()` is not called — so the local list is unchanged, `nextIndex`
recomputes identically, and every subsequent tap re-earns the same 409 behind a
redacted banner.

**Fix shape.** On 409, `router.refresh()` to re-derive the index from server
truth (the load page already selects `load_stacks` with a monotonic index), and
say "another device added a stack — refreshed". **Effort:** S.

---

### D-11 — Six `setError(e.message)` sites render Next's redaction text

**Severity: MEDIUM. Live rows: all stage error paths.**

`stage-stacks.tsx:118,148`, `stage-weight.tsx:107`, `stage-finish.tsx:64,79`,
`stage-reject.tsx:54`, `void-load-panel.tsx:127`, `review-panel.tsx:139`. In
production the `e.message` branch always wins (the thrown value _is_ an `Error`),
so the translated fallback beside it is dead code and the operator sees Next's
redaction string. `use-claim-loss-guard.ts:18-21` documents this exact fact —
_"a Server Action's throw reaches the browser with its message REDACTED in
production builds"_ — and `held-by-panel.tsx:118-133` already demonstrates the
correct pattern (a returned discriminated union, never a thrown message).

**Fix shape.** Convert these actions to the `TakeoverActionResult` return-value
pattern already proven in `load-claim.ts`. **Effort:** M.

---

### D-12 — Four stage actions have no `catch` at all

**Severity: MEDIUM. Live rows: path defect; every offline tap.**

`stage-bol.tsx:40-45`, `stage-door.tsx:33-37`, `stage-decision.tsx:31-35`,
`stage-weight.tsx:50-55` (the "None" button). Any throw — a moved claim, a
de-activated surface, a `TransitionError`, **or simply being offline** — blows
past to `operator/error.tsx` and destroys the stage's local state. These four are
also the only stage writes with neither `useClaimLossGuard` nor `enqueueAction`,
so an offline "Start unload" tap is silently lost.

**Fix shape.** Give them the `stage-stacks` treatment: offline → enqueue, online
→ `claimLost()` probe, else a named error. **Effort:** M.

---

### D-13 — A queued write that fails 5xx retries forever and reaches no screen

**Severity: MEDIUM. Live rows: unknown (needs a device query).**

`offline-queue.ts:977-981` classifies only 4xx (≠408) as terminal. A 500, a
network error, or an `R2 PUT <status>` failure (:1093, :1213 — not
conflict-prefixed even for a 403 from R2) keeps `state: 'active'`, so the row
never appears on the conflicts screen (`listConflicts` filters on `isConflict`,
:669-672) and only inflates the chrome's ordinary "N waiting to send" pill.

Worse, backoff is inert: `isReady` (:942-946) measures against `queued_at`, but
`markActionAttempt` (:788-796) never updates it, and `backoffSeconds` caps at 60.
Any row older than a minute is ready on **every** sweep. This is the shape of the
97-photo incident the module header describes, reproduced for the 5xx class.

**Fix shape.** Refresh `queued_at` on each attempt (the upload path already does,
accidentally, at :1078), and surface a "stuck, not conflicted" state after N
attempts so it reaches the conflicts screen an operator can act on.
**Effort:** M.

---

### D-14 — The conflicts screen says "nothing stuck" when IndexedDB is unreadable

**Severity: LOW-MEDIUM. Live rows: path defect.**

`conflicts-client.tsx:66-72` catches an IndexedDB failure and renders
`t('floor.conflicts.empty')` — **"Nothing is stuck. Everything you entered has
been sent."** That is not an empty state, it is an affirmative claim of safety
made on the strength of a read that failed. The operator arrived _because_ the
chrome badge said items are stuck; the screen then contradicts the badge with no
error.

**The same asymmetry, in the same repo, on the same kind of call.**
`review-panel.tsx:115-117` catches the identical class of failure and **fails
closed** — `.catch(() => setUnsent(1))`, which withholds the fix controls and
renders the explanatory `load_review.unsent` block. Two components, opposite
policies, no ADR reconciling them. `use-connection-state.ts:126-130` has the same
fail-open shape (`queueCounts()` throws → counters keep their last values →
chrome renders "Connected").

**Fix shape.** Distinguish "empty" from "could not read" — the third state — and
adopt `review-panel`'s fail-closed policy as the house rule. **Effort:** XS.

---

### D-15 — Copy that names a destination and does not link to it

**Severity: LOW. Live rows: 3 strings.**

- `floor.inbound.per_load_locked` — "…counted truck-by-truck **on the queue**"
  (`inbound-client.tsx:200`), bare `<p>`, no link.
- `floor.inbound.err_per_load` — "…**Confirm it on the queue.**" (:88/:101), same.
- `floor.processed.err_closed` — "Today is closed. Ask an admin to reopen it."
  (`processed-client.tsx:93`) — an early return that collapses the whole form.

The first two name a real route and withhold it. The third is EXPLAINED (it names
who) but still replaces the entire screen.

**Fix shape.** Add the `<Link>` the sentence already promises. **Effort:** XS.

---

### D-16 — Eight disabled buttons with no adjacent reason

**Severity: LOW individually; compounding with D-17.**

`stage-bol.tsx:39`, `stage-door.tsx:32`, `stage-weight.tsx:96` (two independent
reasons, neither named), `stage-reject.tsx:108` (two, neither named),
`stage-finish.tsx:143`, `stage-stacks.tsx:242` ("you voided every stack" is never
said), `stage-stacks.tsx:295,329`, `inbound-client.tsx:220`,
`dropoff-client.tsx:228` (photo covered, label choice not).

The repo already contains the correct pattern twice — `review-panel.tsx:229-231`
(`weight_range_hint`) and `void-load-panel.tsx:93-95` (`note_required`).

**Fix shape.** A hint line under each. **Effort:** S for all of them.

---

### D-17 — Untranslated English technical strings on a trilingual iPad

**Severity: LOW-MEDIUM. Live rows: 3 sites.**

`photo-input.tsx:189,208,255` — `setError(e instanceof Error ? e.message : 'upload failed')`,
rendering raw strings like `mint failed (403)` (:174, :241). Bypasses i18n
entirely on a floor that runs en/es/ur. Compounds D-16: `onCaptured` is not
fired, so the parent's Continue stays disabled with nothing connecting the two,
under a button reading "Retry BOL photo".

**Fix shape.** Translate; special-case 403 the way 401 is already special-cased
at :73-75. `conflicts-client.tsx:181` already has the right sentence for a
cross-site/wrong-role 403 (`why_other_operator`) — the live path never learned it.
**Effort:** XS.

---

### D-18 — The site picker has no empty state and no chrome exit

**Severity: LOW today (2 sites seeded). Live rows: 0 — latent.**

`operator/page.tsx:34-45` renders `{sites.map(...)}` with **no zero-length
branch**: an empty `Site` table produces the heading "Choose your site" over an
empty list and nothing else. Compounding it, `floor-nav.ts:57-59` returns
`backHref: null, showLogOut: false` for `/operator` — so unlike every other floor
screen, the chrome band offers no exit either. This is the **only page in the app
with neither an empty state nor a chrome escape.**

Production has 2 sites (woodland 8 active operators, eugene 1), so this is latent.
It is listed because every sibling surface (`[site]/page.tsx:76`,
`today/page.tsx:171`, `inbound/page.tsx:36`) _does_ have the branch — the site
picker is the one that was missed, and the `floor-surface-coverage` guard cannot
see it (it tests page-level chrome, not branch-level content).

**Fix shape.** An empty branch in the house `not_activated_body` style.
**Effort:** XS.

---

### D-19 — _(withdrawn — merged into D-14; number retired, not reused)_

---

### D-20 — Cancelling a `window.prompt` gives zero feedback

**Severity: LOW. Live rows: path defect.**

`count-client.tsx:231-232` and `conflicts-client.tsx:80-81`: tap Discard, hit
Cancel on the native prompt, and the handler returns silently — `busy` was never
set, so nothing on screen changes at all. Defensible (the prompt is its own
feedback) but it is a true silent path and worth knowing about.
**Effort:** XS if addressed.

---

### D-21 — "Count removed." is a terminal card that depends on a refresh landing

**Severity: LOW-MEDIUM. Live rows: path defect.**

`void-client.tsx:121-130`. `phase === 'done'` renders a bare `<section>` with one
sentence and no control; the panel only becomes useful again when the
`router.refresh()` fired at :110 re-renders it. If that refresh is slow or fails,
the operator is looking at an inert card.
**Fix shape.** A "Done" / "Count again" control, as every other terminal phase in
`count-client.tsx` has (:270, :299, :317). **Effort:** XS.

---

### D-22 — A written explanation that can never render

**Severity: LOW. Live rows: dead copy.**

`floor.conflicts.why_upload_blocked` ("Photo storage was unreachable. It is safe
to try again now.") exists in all three locales but `reasonLabel`
(`conflicts-client.tsx:167-186`) never returns it. Uploads-blocked rows fall to
the catch-all `why_refused` — "The server would not accept this" — which is both
less true and less actionable than the sentence someone already wrote.
**Effort:** XS.

---

### D-23 — Two places render the iPad's own clock instead of Pacific

**Severity: LOW-MEDIUM. Live rows: 2 render sites.**

`conflicts-client.tsx:189` (`new Date(ms).toLocaleString()`) and
`connection-state.tsx:114` (`toLocaleTimeString()`). Everywhere else on the floor
is Pacific-pinned server-side through `@/lib/format` — precisely because ADR-0065
Am.1 found the container's UTC clock telling a Woodland operator a 15:00Z
appointment was "3:00 PM". These two escaped that sweep and read the _device_
clock, so a shared iPad with a drifted or mis-zoned clock mis-times exactly the
two screens an operator consults when something is already wrong.
**Fix shape.** Route both through the Pacific-pinned formatter. **Effort:** XS.

---

### D-24 — The add-concern control disappears after one use, unexplained

**Severity: LOW. Live rows: path defect.**

`stage-finish.tsx:93` requires `!concernSaved`, so after saving one concern the
button is simply gone (:153-157 shows only "concern recorded"). An operator with
a second thing to report has no affordance and no sentence telling them why.
**Effort:** XS.

---

### D-25 — An unsent stack looks identical to a sent one but has no Remove

**Severity: LOW-MEDIUM. Live rows: path defect (offline only).**

`review-panel.tsx:277,295`. A `tmp-` (not yet acked) stack renders the same as a
real one, and its Remove button is silently withheld. The reasoning at :273-277 is
correct — offering a control that would 404 is worse — but the operator is told
nothing, so an identical-looking row inexplicably lacks the button its neighbour
has. One sentence from being an explained dead end, and the file already contains
the model for that sentence twelve lines below (D-27).
**Effort:** XS.

---

### D-26 — The two most useful sentences on the chrome live in `title=` attributes

**Severity: LOW-MEDIUM. Live rows: always.**

`connection-state.tsx:109-115`. `uploads_blocked_detail` ("{{count}} photos are
waiting. **Counts are still saving normally.**") and `never_synced` are rendered
as HTML `title` attributes. A `title` requires a hover — **it never surfaces on a
touch iPad.** So the operator sees "Photos can't upload — tell a manager" and
never sees the reassurance that their counts are fine, which is the half that
determines whether they keep working or stop and phone.
**Fix shape.** Render the detail as visible text under the pill. **Effort:** XS.

---

## 4. What I verified, and how

- **Repo:** `origin/main` `02c3981`, read in an isolated worktree
  (`/home/bbarnard065/dr3-audit-deadends`). The main checkout carries another
  session's uncommitted work and was not disturbed.
- **Production:** every row count in this document came from
  `docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision` on CHAD-HQ at
  2026-08-11 17:44 PT, not from the repo or from memory.
- **Timezone.** `expected_arrival_at`, `arrived_at`, `unload_started_at` and
  `assigned_at` are `timestamp without time zone` storing **UTC**. My first pass
  bucketed days with `AT TIME ZONE 'America/Los_Angeles'` alone, which
  _interprets_ the naive value as Pacific and was wrong by 7 hours — it inflated
  the D-1 actionable count and mis-dated every appointment. Every figure here is
  from the corrected form,
  `col AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles'`. Flagging it
  because any future query against these columns will hit the same trap.
- **Negative findings worth recording** (hypotheses checked and _disproved_, so
  nobody re-checks them):
  - No floor day list renders a selectable past day (D-8, part A). The inbound
    list is called with `days = 1` and the server pin agrees with the UI.
  - `currentPacificDayWindow` is DST-correct in both directions and carries a
    regression test for the fall-back zero-width-window defect (`time.ts:222-238`).
    The read path is sound; only the scrape sweep is off it (D-2).
  - The i18n catalogs are at **full parity** across en/es/ur (429 keys each),
    guarded by a CI-blocking `locale-parity.test.ts`. No operator will see a raw
    key _from the catalog_; the only untranslated strings on the floor are the
    hardcoded English literals in D-17.
  - The `/today` hub page is **not** rollout-gated — `IPAD_TODAY_SUMMARY` (which
    is `pilot` at both sites) gates only the on-hand tile. The error boundary's
    "Back to my screens" escape therefore lands somewhere useful.
  - `voidLoad` **does** sever `expected_load_id`, so the voided-slot dead end
    described in `consumed-slot.ts:92-102` is genuinely unreachable (0 rows
    confirmed in prod).
- **Not verified end-to-end:** D-3. The auth redirect intercepts every
  unauthenticated probe (`307 → /operator/woodland` confirmed), so I could not
  reach `notFound()` without an operator session. The finding rests on file
  absence plus the build manifest. Hand-check on a real iPad before acting.
- **Not audited:** the in-flight ADR-0074 D5 durable fix (another agent owns it),
  and anything under `/admin` — manager-tier surfaces are out of scope.

## 5. Suggested order of work

1. **D-4** (XS) — one void away from firing, one hour to close.
2. **D-8** (S) — four write clients, one already-translated string, and it is the
   midnight-boundary sibling of this week's incident 2.
3. **D-2 part 2** (S) — stop pre-appointment cancellation; the
   highest-probability repeat of this week.
4. **D-3** (S) — after a ten-minute hand verification.
5. **D-7** (S) — unblocks the rest of §2.4.
6. **The copy-and-route batch, one PR** (XS each): D-5, D-6, D-9, D-14, D-15,
   D-17, D-18, D-20 – D-26.
7. **D-1's `reason` discriminator** (S) — folded into the in-flight day-bound fix.
8. **D-10, D-11, D-12, D-13, D-16** (M) — the error-contract batch.

## 6. Three patterns already in this repo, and the guard that is missing

**The repo already knows how to do this.** Three implementations are exemplary and
should be the templates for every fix above, rather than inventing new copy:

- **`review-panel.tsx:353-360`** — withhold the control, state the cause, and
  self-heal. It polls every 3s so the controls return on their own; no phone call,
  no manual retry. This is the best answer in the codebase to "no control right
  now".
- **`photo-input.tsx:138-156, 300-302`** — classify the specific status (401),
  name the single action that fixes it, and hand off to a control that already
  exists elsewhere (the chrome sign-in link).
- **`count-client.tsx:390-392`** (`hold_remote_note`) — when there genuinely is no
  control on this screen, say who can act **and from where**: "No manager here
  right now? Leave this screen — a manager can approve it from their own
  computer."

**The guard that is missing.** ADR-0091 closed its defect with two `it.each`
guards over the source files — every check-in surface calls `toConsumedLoad`,
every rendering surface calls `describeConsumedSlot`. `floor-surface-coverage.test.ts`
goes further and derives its inputs from the filesystem, so a seventh operator
page is tested automatically. That file's own header states the principle exactly:
_"That proves the six known screens are correct; it cannot prove the claim Bill
actually asked about, which is about EVERY screen."_

Both guards operate at **page** granularity. Every finding in this document is at
**branch** granularity — the page has a way out via `FloorChrome`, and the branch
inside it does not. That is the gap, and it is the same gap one level down.

The generalisation worth building: **a filesystem-derived test that walks every
terminal render branch under `src/app/operator/` and every `LoadStatus`, and
asserts each one contains at least one `<Link>`, `<button>`, or `onClick` — or is
on an explicit allow-list of designed, explained dead ends.** D-4, D-5, D-6, D-15,
D-18, D-21, D-24 and the bare half of D-1 would all have been caught by it before
the floor found them.

That is the difference between fixing twenty-six dead ends and making the
twenty-seventh unbuildable — which is the actual answer to "why does this keep
happening".
