# ADR-0144 — Floor check-in actions return their refusals; the message is chosen by failure class

- **Status:** Accepted 2026-11-11 (Pacific). Implemented in #321 (cb76fd9), **merged and deployed 2026-11-11 4:40 PM PT** (PR-1 of the 2026-11-10 Woodland follow-up). Closes OPEN-ITEMS 0.HF HF-3 once
  shipped.
- **Context:** Woodland, 2026-11-10: "tap the haul, nothing happens" (ADR-0074 Amendment 2). After #319
  (`821e300`) was deployed, production logged three more `LoadAccessError 401 not_authenticated_as_operator`
  from the hauls page.
- **Extends:** ADR-0078 D11 (typed `LoadAccessError`), ADR-0078 G8c (`?next=` through the name picker),
  ADR-0096 (late-truck reconcile), ADR-0127 (haul-number read-back), floor dead-end audit D-8.

## Context

An operator session idles out after five minutes. An expired session is a **husk**: `session.user` is truthy
but carries no id and no role (`src/lib/session-husk.test.ts`). `ctx()` in `src/app/operator/[site]/actions.ts`
answers it with `LoadAccessError(401, 'not_authenticated_as_operator')`, which is correct.

The defect was on the way back to the client. A server action that **throws** reaches the browser, in
production, as an opaque error with a digest; the status and reason are gone. `QueueRow` and `ReconcileRow`
therefore caught every non-redirect error and printed one sentence. For `QueueRow` that sentence was
`floor.confirm_checkin.mismatch` — "This card changed since the page loaded. Pull down to refresh" — the copy for
a 409. An operator whose session had ended was told to refresh, which cannot fix it, and the
`write-refusal.tsx` signed-out notice named the condition but had no control to fix it.

The floor pages' own signed-out redirects went to `/operator/<site>` without `?next=`, so even an operator who
found the PIN screen landed on the hub afterwards, although the keypad has honoured `next` since G8c.

## Decisions

- **D1 — the two check-in actions return refusals.** `startLoadAction` and `startLoadReconciledAction` return
  `{ ok: false, status, reason }` (`CheckinRefusal`) for a `LoadAccessError` (every `ctx()` and
  `startInboundLoad` refusal: 401/403/404/409) and for the ADR-0065 rollout gate's
  `LoadsInventoryNotActivatedError` (403, reason `surface_not_activated`). On success they still call
  `redirect()`, outside the `try`, so `NEXT_REDIRECT` propagates exactly as before. Any other error (database,
  bug) is re-thrown unchanged. The server checks, the ADR-0127 haul-number comparison, the ADR-0096 day check
  and the write itself are unchanged.
- **D2 — one classifier.** `src/lib/floor/action-outcome.ts` `classifyFloorActionFailure` maps a returned
  refusal or a thrown error to one of: `signed_out` (401), `card_changed` (409 only), `not_allowed` (403/404),
  `app_updated` (Next's `UnrecognizedActionError` — a deploy retired the action id the page was rendered with),
  `no_connection` (the fetch `TypeError` messages of WebKit, Chromium and Gecko, matched exactly so a bug is not
  called a network problem), and `failed` for everything else. Pure function, table-tested.
- **D3 — one notice, chosen by class.** `CheckinFailureNotice` renders the sentence for the class and the
  control that fixes it: sign-in for `signed_out`; reload for `card_changed`, `app_updated` and `failed`; no
  control for `no_connection` (a reload would fail too; the card stays tappable) or `not_allowed` (nothing on
  the iPad fixes it). The "card changed" copy appears **only** on a real 409.
- **D5 — a returned refusal is logged, once.** Returning instead of throwing removes the line Next used to log
  for every thrown action error, and the 2026-11-10 outage was diagnosed from exactly those thrown-401 lines. So
  `refusalOrRedirect` emits one pino `warn` per refusal, replacing that signal:
  `{ evt: 'floor.action_refused', action, status, reason, siteCode, expectedLoadId }`, message
  `floor action refused: <action> <status> <reason>`. `action` is `startLoadAction` or
  `startLoadReconciledAction`. It carries no operator identity (no name, user id or PIN); `expectedLoadId` is a
  record id, as `loadsErrorResponse` already logs. Successes log nothing.
- **D4 — signing in comes back here.** `floorSignInPath(siteCode, here)` (in `src/lib/floor-return-path.ts`,
  re-exported from `src/lib/auth-helpers.ts`) builds `/operator/<site>?next=<here>`, validating `here` with the
  same `resolveFloorReturnPath` the keypad uses and dropping it if it would be refused — so it never emits an
  off-site or cross-site target. It is used by `FloorSignInLink` (a `Link`, 56 px, no form) in the check-in
  notice and in the `write-refusal.tsx` signed-out notice, and by the nine floor pages' signed-out redirects
  (`today`, `hauls`, `count`, `inbound`, `processed`, `dropoff`, `queue/conflicts`, `queue`, `load/[id]`). Only
  the signed-out case (401, including the husk) gets `?next=`; a wrong role or site keeps its old redirect.

## Alternatives considered

- **Keep throwing and read the error on the client.** Not possible in production: Next strips the message and
  any custom fields from a thrown server-action error by design.
- **Return outcomes from every floor action.** Larger and not needed for the incident. The stage writes already
  go through the offline queue's own classification; the check-in pair is where the misleading copy lived. Other
  actions can adopt `CheckinRefusal` when they have the same problem.
- **Sign-in as a form or a client `signIn()` call.** Rule #10 forbids forms, and the floor's sign-in is the name
  picker plus PIN, not a credential the row could submit.

## Consequences

- An idled-out operator who taps Yes reads "Your session ended, so this truck was not checked in" with a
  "Sign in again" control that returns to the same screen after the PIN.
- `floor.hauls.late_failed` is removed; the late-truck row uses the shared copy.
- **Counting gap, admitted.** Before this ADR the only server-side signal for these refusals was Next's own
  log of the thrown error; returning them removed it. D5's `floor.action_refused` line replaces it, and for the
  first time carries the status and reason in fields. There is still no metric counter, and the client-side
  classes `app_updated` and `no_connection` never reach the server, so they are not counted at all (the dead-end
  beacon counts renders, not taps). Tracked with HF-2.
- Not verified on a real iPad or against the deployed app; the unit and page tests use synthetic data.
