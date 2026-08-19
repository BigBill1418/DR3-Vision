# ADR-0111 — The probe was wrong, not the password

- **Status:** Accepted, implemented 2026-08-18 (Pacific)
- **Context:** Live incident 2026-08-18 — `dr3-vision-mymrc-scrape` paged with
  `mymrc: still logged out after fresh login (admin)`; the working theory was an
  expired credential, then a Salesforce identity-verification challenge.
- **Supersedes / amends:** nothing. Extends ADR-0057 (the AdminSession self-heal)
  and ADR-0037 (the notification noise policy, Q3).

## Context

At 3:51:08 PM Pacific the MyMRC scrape worker announced that it had logged in and
was still logged out. The stored admin credential
(`mymrc_admin_credentials`, created 2026-07-22, never rotated) became the prime
suspect, followed by a Salesforce Experience Cloud device-verification challenge
— an unfamiliar container IP triggering an emailed code that a headless browser
can never answer.

Both theories were wrong, and one live observation killed them before any code
changed: **Bill's browser worked, and so did the scraper.** The 4:00 PM cycle,
nine minutes after the page, ran fully clean on the same stored credential — all
four feeds, mirror freshness green, exit 0.

So the question was never "why can't it log in". It was "why does it sometimes
believe it hasn't".

### What the measurement showed

A single controlled login (headless, from the scraper image, captured to HTML +
screenshot) landed **authenticated**: the post-submit page carried the
"Switch Account" banner and the "viewing as DR3" context, with no verification
challenge, no authentication error, and no lockout notice anywhere on it.

The decisive run re-used **one** authenticated session across twelve navigations,
spending no further logins, and read the auth state twice per navigation — once
the way production reads it, once after letting the page settle:

| Read                                         | Verdict                   |
| -------------------------------------------- | ------------------------- |
| At `domcontentloaded` (what production does) | **logged out in 3 of 12** |
| After `networkidle` + settle                 | logged **in** in 12 of 12 |

The session was authenticated every single time. The probe disagreed 25% of the
time. That is the whole incident.

Note the trials ran at 4:35 PM against a warm, idle portal — **not** during
container start. The race is a property of the check, not of boot; a boot storm
only makes it likelier to lose.

### The mechanism

`/s/` is a Salesforce Aura single-page app. Its authenticated markers — the
"Switch Account" banner, the "viewing as DR3" context, the object nav — are
painted **client-side, after** `domcontentloaded`.

`looksLoggedOut` is a _positive_ test: a session counts as logged in only when an
authenticated marker is present. That hardening was correct and deliberate
(ADR-0038 D4) — it exists because the old negative test let the `/s/home` 404
shell pass as authenticated. But it reaches its verdict two different ways:

1. a real sign-in form is on the page — **decisive**; or
2. the authenticated marker is simply absent — **an assumption**.

On an Aura app those are not the same thing, and the auth verify path read the
DOM at the one moment they are least distinguishable. Confirmed against the live
capture: the shell served at `domcontentloaded` contains **no** sign-in markup,
**no** sign-in URL, and **no** authenticated banner — and an anonymous `/s/`
renders that same shell. A healthy session and a dead one look identical there.

The codebase already knew this. `collectAura` navigates with `networkidle` and
then waits `SETTLE_MS` (6 s) for "late Aura datatable / LDS fetches". Every data
read waits for hydration. Only the auth read did not.

## Decision

**D1 — Separate "the portal is showing me a sign-in form" from "nothing has
rendered yet".** New pure predicate `looksDefinitelyLoggedOut` reports only the
decisive evidence (visible username field, `/s/login` URL, a visible sign-in
control). `looksLoggedOut` is unchanged — it remains correct as a verdict on a
fully rendered page.

**D2 — The auth verdict polls until the page is decided.** `isLoginPage` now
loops: an authenticated marker returns logged-in immediately; decisive
signed-out evidence returns logged-out immediately; otherwise it waits
`authPollMs` (250 ms) and looks again, up to `authSettleMs` (15 s), after which
it reports logged-out. **Fail-loud is preserved** — an undecided page still ends
in `AuthFailedError`, just not on the first glance. The bound is a poll _count_,
not wall-clock, so it is deterministic under a fake clock.

This is applied at `isLoginPage`, the single choke point every consumer already
goes through — `bootstrap`, `rebuildAndLogin`, `ensureAuthenticated`, the
list-fetch guard, the backfill client and the record-fields client. Fixing the
three auth-decision call sites individually would have left the other three
reading the DOM at the wrong moment.

**Honest cost:** because an expired session renders the same markerless shell, a
genuinely dead session is _undecided_ rather than decisive and now waits out the
full 15 s budget per verdict before failing. That is paid only on the failure
path, and it is the price of not killing healthy sessions. It is pinned by a
test so the cost is visible if the budget is ever raised.

**D3 — A session that never starts must appear in the ledger.**
`openAdminSession` throws before the first feed row is written, so a tick that
never got a session wrote **nothing** to `mymrc_sync_runs`. The ledger read 100%
green straight through this incident; the only evidence was a container log,
which the next redeploy destroys — and did. Session failures now write a
`feed='__session__'`, `status='auth_failed'` row. No schema change: `feed` is
free text.

**D4 — Page after self-heal has had its chance, not before.** The auth page fired
on the _first_ failed tick, gated by a cooldown `Map` held in the per-tick
process — a process that exits after every tick, so the map was empty every time
and gated nothing. The ledger from D3 supplies real cross-tick memory: a session
failure pages only when it is the second within an hour. A blip that heals at the
next cycle stays silent; a genuinely dead session still pages on the retry ~9
minutes later. This is ADR-0037 Q3 ("has the system tried to self-heal first?"),
which the old behaviour failed. The bookkeeping **fails open** — if the ledger
write or count throws, it pages anyway. Broken bookkeeping must never be able to
silence a real outage.

**D5 — The boot scrape stops racing its own stack.** `BOOT_DELAY_MS` was 5 s,
which put the boot scrape inside the stack recreation window. Both boot scrapes
observed on 2026-08-18 failed there, each differently: the 3:50 PM one lost the
hydration race above, and the 4:38 PM one had `chrome-headless-shell` take
SIGSEGV about two seconds after container start while ~20 sibling containers
were still being recreated. Both healed at the next top-of-hour on an unchanged
credential. The delay is now 90 s (override `MYMRC_BOOT_DELAY_MS`), clearing the
observed ~17 s of container churn plus migrate/healthcheck settling, with
headroom.

## Consequences

- The intermittent `still logged out after fresh login` page is removed at its
  source, not suppressed. ADR-0057 fixed the _dirty-context_ half of the live
  alternating `ok`/`auth_failed` flap; this fixes the half that was left — the
  measurement itself.
- Fewer logins against the portal. A false "the persisted session is logged out"
  discarded a perfectly good session and forced an unnecessary fresh login; that
  pre-check is the same read, so the reduction applies there too.
- `mymrc_sync_runs` now records a failure class it was previously blind to.
  Queries that treat the table as the health record become trustworthy — but note
  that any query grouping by feed will now see a `__session__` feed.
- A single transient session failure no longer pages, which is a deliberate
  ~9-minute delay in the worst case (a genuinely dead credential is reported on
  the retry rather than immediately). The ADR-0089 freshness deadman remains the
  backstop for a sustained outage.
- The 90 s boot delay means a redeploy populates the queue ~85 s later than
  before. The hourly anchor is unchanged.

## Alternatives considered

- **Navigate the verify with `networkidle` + `SETTLE_MS`, matching `collectAura`.**
  Simplest, and it would work — but it pays a fixed ~6 s on every verdict
  including the healthy ones, and `networkidle` is unreliable on Aura, which
  long-polls. Polling for the marker returns as soon as the answer is known.
- **Wait on a Playwright locator for the banner.** Idiomatic, but it splits the
  auth definition in two: the locator and the `looksLoggedOut` predicate would
  have to be kept in agreement, and the predicate is the thing the tests pin.
  Polling the existing predicate keeps one definition of "logged in".
- **Rotate the credential.** The first theory, and it would have "worked" in the
  sense that the next cycle would have been green — as it was anyway, nine
  minutes later, with no rotation. It would have consumed Bill's time, changed a
  working secret, and left the actual defect in place to page again.
- **Retry the whole tick on `AuthFailedError`.** Treats the symptom, doubles the
  login count against the portal, and keeps a wrong measurement in the system.
- **Suppress or lengthen the alert cooldown.** Would have hidden a real defect.
  The alert was not too loud; it was correct about something being wrong and
  wrong about what.

## Verification

- 12-trial live measurement above: 3/12 false negatives pre-fix on a session
  authenticated 12/12.
- Regression test drives the exact live shape — three unhydrated reads, then the
  banner — and asserts one login and no purge. **Falsified**: reverting
  `isLoginPage` to its single read makes it fail with the incident's own string,
  `mymrc: still logged out after fresh login (admin)`.
- The unhydrated-shell fixture is taken from the live capture and carries a
  guard test asserting it contains no sign-in or banner token. The first draft of
  that fixture described the sign-in markup in its own header comment, which the
  predicates scan; the test caught it asserting the opposite of its purpose.
- Full `src/lib/mymrc` suite green (453 tests) plus the new paging tests.
