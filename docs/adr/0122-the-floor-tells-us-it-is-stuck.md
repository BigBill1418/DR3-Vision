# ADR-0122 — The floor tells us it is stuck

- **Status:** Accepted
- **Date:** 2026-08-20
- **Follows:** ADR-0121 §Follow-ups item 1; ADR-0100 / ADR-0094 §P0
- **Grading:** ADR-0036 (transport), ADR-0037 (noise)

## Context

ADR-0121 was the fix. This is the instrument, and it exists because of the
single most uncomfortable measurement in that incident: **the outage produced no
signal at all.**

For 90 minutes on 2026-08-20 the Woodland floor could not advance a load, and
every monitor the fleet owns was green. `/api/healthz` answered in 0.13 s.
Postgres was idle — zero advisory locks across ~600 samples at 250 ms, zero
waiters, zero long transactions. Check-ins were still succeeding: `cfc91dbe`
(H-137887) was created at 1:00:56 PM PT, _during_ the reported outage. Photos:
12 captured, 12 uploaded. There was no error rate to spike, no latency to climb,
no queue to back up.

That is not a gap in the monitoring. It is the shape of the defect. **A trapped
operator does not make requests** — being unable to act is precisely what
"trapped" means — so the class of defect ADR-0094 measured at 43 of 89 scheduled
slots is, by construction, invisible to every request-driven signal we have.

ADR-0100 already built the instrument for this: `DeadEndBeacon`, mounted inside
the branch it measures, reporting through `/api/operator/<site>/dead-end`. It was
mounted on the list surfaces — hauls, queue, conflicts, inbound, the closed-load
branch of the workflow shell — and on **none of the seven `stage-*.tsx` files**,
which is where the work actually happens. Mounted on stage 1, it would have fired
at 12:36:35. The floor discovered the defect at 12:52, and the discovery mechanism
was Bill's phone.

## The decision

**D1 — Detect zero live controls by MEASURING, not by declaring.**

Every existing `DeadEndBeacon` mount sits inside an `if` a human decided was a
dead end. That works for a branch whose whole purpose is to say "there is nothing
here". It cannot work for a stage, because a stage is never _supposed_ to be a
dead end — the 2026-08-20 screen believed it was a working BOL capture screen. No
hand-placed beacon would have been written for it, and none was.

So each control registers its own liveness, next to where it renders, and the
boundary fires when **every registered control is dark**. The same expression
that feeds the button's `disabled` prop is the value registered, so the report
cannot drift from the DOM:

```tsx
const continueReason: StageDisableReason | null = isPending
  ? 'pending' : !hasFile && photoCount === 0 ? 'no_photo' : null;
useLiveControl('bol_continue', continueReason);
…
<button disabled={continueReason !== null} …>
```

**D2 — Register a REASON, not a boolean, and treat two of them as transient.**

Every tap on this floor passes through an all-disabled frame while a Server
Action is in flight. A detector that could not tell "busy" from "trapped" would
page on every tap and be muted inside an hour — and then the real page would not
arrive either. `pending` and `uploading` suppress the verdict; every other reason
is a state the operator cannot leave by waiting.

The reason set is also the diagnostic. `no_live_controls` with
`{photo_capture: photo_present, photo_add_another: not_captured, bol_continue:
no_photo}` is the 2026-08-20 trap, stated in full, in the log line and in the
page body. The first question anyone asks is "which control, and why" — this
answers it without a reproduction attempt.

**D3 — One boundary at the dispatch site, not seven mounts.**

`load-workflow.tsx` produces the stage node and the stage id from ONE expression
and wraps the result. A per-file mount is seven places to forget, and an eighth
stage added next month would ship uninstrumented — which is exactly how
`DeadEndBeacon` came to be absent from all seven in the first place. The boundary
renders `{children}` and no DOM node, asserted in the suite rather than in prose.

**D4 — Registration, not a DOM scan.**

The obvious implementation is to walk the subtree and count
`button:not([disabled])` — which is what `stage-reentry.test.tsx` does. It was
rejected on two grounds and the second is disqualifying:

1. `photo-input.tsx` renders `<input type="file" className="hidden">`, which is
   never `disabled`. A naive selector counts it as live and the detector never
   fires: a guard that measures nothing, which is worse than no guard because it
   reads as coverage.
2. Excluding it requires CSS visibility, and **jsdom does no layout**. The
   detector would take a different branch under test than in production, so no
   test could falsify it. An instrument nobody can prove wrong is not an
   instrument.

The suite closes the loop from the other side instead: it mounts the real
compositions and asserts the detector's verdict against a button count taken from
the rendered DOM, in **both directions**, on every case. Both directions were
falsified by mutation before this shipped (§Verification).

**D5 — This one dead-end state pages. The others still do not.**

`dead-end.ts` states plainly that a dead-end render is not actionable within five
minutes and is a dashboard tile, not a page. That grading stands for every state
in the union except this one, and the distinction is real rather than convenient:

- `slot_withdrawn`, `load_closed`, `already_worked`, `no_portal_feed` and the
  rest describe a **situation in the yard**. The screen has a card explaining it
  and a Link to the queue. Nothing is broken.
- `no_live_controls` describes **the application failing to offer a next
  action**. Nobody on the floor can clear it, working harder does not resolve it,
  and it appears in no operational metric.

ADR-0037's five-question gate, answered: actionable in 5 minutes (the click is
the trapped load); customer-visible (a load that cannot leave `arrived` is a
truck on the dock and a delivery that never reaches MyMRC); no self-heal is
possible (a hard refresh renders the same dead screen — proven on the day);
deduplicated at the root cause (fingerprint is the (load, stage) pair, so the
three operators who took H-137810 over in turn would have produced ONE page);
tier-1 destination.

`high`, not `urgent`: one truck, not the fleet. Under quiet hours a `high`
buffers to the 07:00 digest, which is right — there is nobody on the dock at 3 am
to be trapped.

**D6 — Rule #5, stated rather than skirted.**

CLAUDE.md hard rule #5 confines ntfy to system-level events; ADR-0088 D4 applied
that to a manager who had not typed a number and was right to. This is the other
kind. The defect is in the software, its only manifestation is an ABSENCE of
requests, and it is invisible to every system-health check the fleet runs. That
is a system event by any reading that is about substance rather than wording.

## Alternatives rejected

- **A hardcoded `hasNoControls` flag per stage.** It is the declaration problem
  again: a human deciding in advance which combinations are dead. The 2026-08-20
  combination is one nobody predicted, in a file nobody thought was dangerous.
- **A Prometheus threshold rule instead of a page** (ADR-0094 §P0's original
  shape: same object, same user, 3+ dead ends in an hour). Correct for the list
  surfaces where a dead end is common and mostly benign. Wrong here: on the day,
  the FIRST fire was already a stopped floor, and waiting for a third would have
  spent another hour.
- **A new Prometheus label for `stage`.** `deadEndRenders` is labelled
  (surface, state, site). A fourth label multiplies the series count for every
  existing caller and quietly changes what shipped queries mean. Loki carries the
  stage and the reason snapshot at full fidelity, which is the split ADR-0100
  argued for in the first place.
- **Firing the page from the browser.** The client already cannot be trusted with
  identity here (ADR-0100), and a client that can page is a client that can page
  Bill 400 times.

## Consequences

- **Behaviour-neutral on the floor.** No control changes state, no layout moves,
  no copy is added. Every `disabled` prop is truth-equivalent to what shipped in
  #286, and the pre-existing suites — `stage-reentry.test.tsx`,
  `photo-input.limit.test.tsx`, `photo-input.auth.test.tsx`,
  `load-workflow.test.tsx` — were not modified and are the standing proof.
- **A second live instance of the ADR-0121 trap is now visible, and is NOT fixed
  here.** ADR-0121 recorded stage 2 (weight) as unaffected because it "escapes
  via its own None button". True of the `choose` screen. The `add` sub-screen has
  no way back to `choose`, so an operator re-entering a load whose weight ticket
  is already on the server and tapping "Add weight" finds capture withheld,
  "add another" unrendered and Continue held by `!hasPhoto` — which typing a
  weight cannot satisfy. It is the same trap one stage over and it is armed in
  `main` today. Fixing it is a behaviour change and belongs with ADR-0121
  §Follow-ups item 2; this PR makes it page instead of hiding.
- **`dr3-vision-floor` is a NEW topic, and a new topic is a subscription
  Bill has to add.** This is the one residual risk and it is worth being blunt
  about. The ntfy server's `auth.db` has no `user_subscription` table — account
  subscription sync is not enabled — so subscriptions live on the device and
  **cannot be verified server-side.** `dr3-vision-loads` and `dr3-vision-deploys`
  have been registered since 2026-05-06 and have never had a publisher; a topic
  nobody has added is a silent black hole, which is exactly what ADR-0088 D4
  refused to create. ADR-0121 named this topic deliberately and it is used as
  named, but **the alert is not wired until Bill adds `dr3-vision-floor` on his
  phone.** Recorded in `docs/OPEN-ITEMS.md` as an operator action.
- **The obscured fallback topic is a hand-mirrored constant in two repos** —
  `src/lib/ntfy.ts` and `~/noc-master/data/ntfy-fallback-topics.yml`. Nothing at
  runtime notices if they drift, because the fallback hop only runs when the
  primary is already down and ntfy.sh answers 200 for any topic name. Both were
  written in the same change.
- **No ACL work was required.** `dr3-vision-publisher` already holds
  `dr3-vision-* rw` on ntfy.barnardhq.com, verified before publishing.
- **No rollout surface.** ADR-0047's gate wraps `notifyStaff()` and email; its
  own text says "any future staff ntfy — none exist; ntfy stays Bill-only". This
  is Bill-only, so it does not enter the gate.

## Verification

Both directions of the detector were falsified by mutation, against the real
compositions, before this shipped.

Under-fire — `photo-input.tsx` registering `photo_capture` as always-live:

```
× stage 2 (weight) … > add screen with a server photo is a dead end, and the detector says so
  → the screen had ZERO enabled controls and the detector stayed silent: expected +0 to be 1
Tests  3 failed | 14 passed (17)
```

Over-fire — deleting the "some control is live" clause from `isStageDeadEnd`:

```
→ the screen had 1 enabled control(s) and the detector paged anyway:
  expected [ { …(2) } ] to have a length of +0 but got 1     (×6 cases)
```

The route's page condition was falsified the same way; two of its cases could not
fail as first written (one was refused by a sibling condition, one used a subset
matcher) and both are recorded in that file's header rather than quietly fixed.

End-to-end delivery was proven by publishing a real labelled-test page to
`dr3-vision-floor` and reading the message back off the topic — a 200 alone is
not proof, because the helper's ntfy.sh fallback can present a 403 as success.
