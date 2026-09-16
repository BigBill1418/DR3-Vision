# ADR-0133 — The page that carried the session cookie

**Status:** Accepted
**Date:** 2026-09-16 (Pacific)
**Author:** Bill Barnard (found it), implemented same day
**Relates to:** ADR-0038 (the MyMRC pager), ADR-0057 (the admin credential model), ADR-0130 (the durable cooldown ledger + the §6 alert grading matrix), ADR-0037 (fleet notification noise-reduction policy), ADR-0111 (session-failure ledgering), ADR-0086 §6.3 (the only prior statement in this repo that an error body must be redacted)

## Context

At **04:02 PT on 2026-09-16** the ntfy topic `dr3-vision-system` received:

```
[DR3-Vision] MyMRC sync error - woodland [outbound]
```

The body was not a sentence. It was Playwright's **call log** for an
`apiRequestContext.post: Timeout 45000ms exceeded` against the Aura list
endpoint — and a Playwright call log renders **the request headers of the call it
was making**. The `cookie:` header of that request is the live Salesforce session
for Bill's MyMRC admin identity: `sid`, `sid_Client`, `oid`, `BrowserId`,
`renderCtx`. 1,331 characters.

A caught error is not a message. It is a **transcript**, and a transcript of an
authenticated request contains the authentication.

The same string reached **four** durable places in the same instant:

| Where                   | How                                                                    |
| ----------------------- | ---------------------------------------------------------------------- |
| Bill's phone            | the ntfy push notification                                             |
| `ntfy.barnardhq.com`    | the server's 7-day message cache, readable by anyone holding the topic |
| the production database | `mymrc_sync_runs.error`, run `43301773-4252-4124-ba9d-1d2ae7c7bd81`    |
| `docker logs`           | the `mymrc-sync[…]` stdout line, shipped to Loki by Alloy              |

Three things make this worse than a one-off:

1. **It was asserted to be impossible, in two places, by comments.**
   `mymrc_sync_runs.error` carried `// human error text (never contains
credentials)` and `mymrc_backfill_cursors.error` carried `// last human
failure text (never credentials)`. Both claims were false from the day the
   Playwright transport was written, because **nothing enforced them**. A comment
   is not a control.

2. **It is a whole family, not one call.** The 03:01 PT run `d87a0d8c…` failed
   with `locator.fill: Timeout 45000ms exceeded` on the login page — the same
   call-log shape, from `portal-client.ts` (`NAV_TIMEOUT_MS = 45_000`) rather
   than `backfill-portal-client.ts`. Any Playwright timeout on an authenticated
   page can carry the headers. So can a stack, which is what
   `publishUnhandledError` sends as its body.

3. **The page should not have existed at all.** ADR-0037 Q3 — _has the system
   tried to self-heal first? Page on crash-loop, not first restart_ — is not
   satisfied by an alert that fires on the first failed tick of a feed that
   retries every hour for free. `error` did exactly that.

**A related finding, recorded because it will otherwise be re-discovered:** the
ADR-0130 §6 matrix comment in `src/lib/mymrc/ntfy.ts` says of `error` — _"Q3 —
one hourly retry is free. Caller promotes to `high` after 3 consecutive."_ The
`priority` seam is real and `freshness.ts` uses it for `stale_mirror`. **No
caller has ever promoted `error`.** The sentence described behaviour that was
never built, and read as a shipped feature for as long as it existed.

**Prior art checked before writing this ADR.** There is **no** existing
body-content rule to cite: ADR-0045's "no PII" clause governs contact-intake
logging, not notification bodies, and ADR-0038 (which defines this very pager)
states nothing about what a body may carry. The closest existing statements are
**ADR-0086 §6.3** ("the grant must be redacted in every log, Sentry breadcrumb
and error body" — scoped to photo grants), ADR-0067 (the M365 password "never
reaches … a log line"), and CLAUDE.md hard rule #8 (PINs "never logged"). Each is
about **one named secret**. None of them is a rule about **caught errors**, which
is the class that leaked. This ADR is that rule.

## Decisions

### D1 — The boundary rule: no caught error is stored, logged or published unredacted

Not "sanitise the cookie header". The unit of danger is the **caught error
turning into a string**, so that is where the control goes. Every place an
`unknown` becomes text for a sink passes through one function.

### D2 — One pure redactor: `src/lib/mymrc/redact-secrets.ts`

`redactSecrets(text: string): string`. Zero imports, zero I/O, zero clock — the
same shape and the same **forced placement** as `header-safe.ts` (ADR-0019.5) and
`cooldown-store.ts` (ADR-0130): `tsconfig.mymrc.json` pins
`rootDir: ./src/lib/mymrc`, so the alias-less MyMRC bundle cannot import above
it. The implementation lives inside the narrower rootDir and is re-exported
upward as `src/lib/redact-secrets.ts` for the app. Moving it out breaks
`npm run build:mymrc` with TS6059, not the test suite.

It does two things, and the file carries an **ordered pattern list with a
per-pattern note saying what that pattern matched in this leak**:

1. **Drops the header block of a Playwright call log** — every `  - <name>: …`
   bullet after the `Call log:` marker — while keeping the first line (the
   diagnosis) and the `→ POST <url>` line with its query string (which endpoint).
   **Deny-by-default inside the call log**, not an allowlist of the six headers
   that leaked this time: an allowlist cannot see the header a future Playwright
   or a future portal adds, which is the entire failure mode. The dropped run is
   replaced by `[N header line(s) redacted]` rather than deleted silently —
   ADR-0130's "shipped disabled must not look identical to shipped working",
   applied to evidence.
2. **Masks, anywhere in any text**: `00D…!…` Salesforce session ids, whole
   `cookie:`/`set-cookie:` lines, `Authorization:` values, and the
   `sid=` / `sid_Client=` / `oid=` / `BrowserId=` / `renderCtx=` / `password=`
   pairs.

**Idempotence is a tested property, and it is load-bearing:** it is what lets the
producer redact AND every sink redact again without any sink needing to know
whether an earlier one ran. (It is also why the value class deliberately does not
stop at `]` — it must swallow its own `[REDACTED]` output whole.)

Scoping the line-dropper to text containing a `Call log:` marker is deliberate: a
legitimate multi-line message may use `- key: value` bullets, and a redactor that
eats ordinary prose is one authors route around.

### D3 — Applied at **every** sink, not only at the producer

`mymrc_sync_runs.error` (both writers: `sync.ts` and the worker's `__session__`
row), `mymrc_backfill_cursors.error`, every `mymrc-sync[…]` / `mymrc-backfill:`
log line, the top-level `fatal:` stack print, and both ntfy publishers. The
`describe()` helpers in `sync.ts` and `backfill.ts` — the one place each module
turns `unknown` into text — now redact, and the DB writes redact again.

### D4 — The publisher redacts and **caps**, so a forgetful caller cannot re-open this

`ntfyPager` redacts the message it is handed and trims it to **600 characters**
before appending the fingerprint line. D3 is a promise about other files; D4 is
the property that survives someone breaking that promise. The cap is a policy
statement as much as a size: **a page is a pointer, `mymrc_sync_runs.error` is
the record.** 1,331 characters of transcript is unreadable as a notification and
is precisely the shape that hides a credential in its tail.

The same redaction is applied at the app publisher's single choke point
(`src/lib/ntfy.ts`), because `publishUnhandledError` sends a **stack** as its
body and reaches the same topic and the same 7-day cache.

### D5 — The `.mjs` worker takes the redactor INJECTED, and fails **closed**

`scripts/mymrc-scrape.mjs` has no build step and cannot import the TypeScript
helper, so it receives it through the same injected `mymrc` surface it already
receives `syncSite` and `ntfyPager` through. A build whose `dist/mymrc` predates
this change has no `redactSecrets` — and there the worker **withholds the error
text entirely** rather than passing it through. A fail-open fallback would
re-open the hole in exactly the situation nobody is watching. The failure itself
stays loud: the ledger row, the page and the non-zero exit are unchanged; only
the transcript is dropped. `redact` is typed **required** on
`recordSessionFailure` for the same reason `CooldownDb.$executeRawUnsafe` is
required in ADR-0130 — a typed caller that omits it fails at the call site.

### D6 — Re-grade `error` against ADR-0037 Q3: page on the SECOND consecutive failure, `high` on the third

| consecutive `error` runs of one site+feed | before                                 | after            |
| ----------------------------------------- | -------------------------------------- | ---------------- |
| 1                                         | page, `default`, 6 h cooldown          | **log only**     |
| 2                                         | silent (inside the 6 h re-page window) | page, `default`  |
| 3+                                        | silent                                 | page, **`high`** |
| after any non-`error` run                 | streak resets                          | streak resets    |

The streak is derived from **`mymrc_sync_runs`**, not from a counter, for the
reason ADR-0130 records at length: `scripts/mymrc-scrape.mjs` is a fresh child
process every hour, so an in-memory streak is 1 forever. It reads the two rows
the run already fetches `prior` from — one query, not two, and **no new table**.

Keyed on `status === 'error'` rather than "not ok": a `stale_mirror` or
`auth_failed` tick between two errors is a different condition with its own page
and its own grade, and folding them together would let one alert's escalation be
driven by another alert's failures.

**Only `error` is re-graded.** `auth_failed`, `contract_drift`, `zero_anomaly`,
`stale_mirror`, `deadman` and `dateless_hauls` keep their ADR-0130 §6 rows and
their leading-edge paging untouched.

### D7 — The escalation gets its own fingerprint

`mymrc-error-sustained:<site>:<feed>`, not `mymrc-error:<site>:<feed>`.

Publishing the `high` promotion under the fingerprint of the `default` page it
escalates would hand it to that fingerprint's own 6 h cooldown window — claimed
one hour earlier by the page being escalated — so **the promotion would be
suppressed by the very thing it is escalating past**. An escalation is a new
fact; it gets a new key. This is the same trap `freshness.ts` lives with for
`stale_mirror`, now named.

## Alternatives considered

- **Scrub the headers at the throw site in `backfill-portal-client.ts`.**
  Rejected: it fixes the one call that leaked and none of the family. The login
  timeout (`locator.fill`) throws from `portal-client.ts`, and an unhandled stack
  reaches `publishUnhandledError` from anywhere. The unit of danger is the caught
  error, not the endpoint.
- **Stop putting the error text in the page at all — publish only ids and a
  status.** Rejected: it would have prevented this leak and would also have
  removed the single most useful thing in an ingestion page (_what_ broke). The
  600-character cap keeps the diagnosis and removes the transcript. Note this is
  the posture the task brief expected ADR-0045 to already mandate; it does not —
  see Context.
- **An allowlist of headers to keep.** Rejected: the leak class is the header
  nobody enumerated. Deny-by-default inside a call log is the only version that
  survives a Playwright upgrade.
- **Redact only at the ntfy publisher.** Rejected: three of the four places the
  string landed are not the pager. The database copy is the one with the longest
  life.
- **A second implementation of the redactor in `scripts/` so the `.mjs` can
  import it statically.** Rejected: `header-safe.ts`'s own header comment
  documents this defect class being re-discovered four times across the fleet
  because nobody made one implementation. Injection plus a fail-closed default
  costs one parameter.
- **Turn `error` off entirely.** Rejected: it is the only signal for the failure
  modes that are neither auth, drift, zero-rows nor staleness. The grade was
  wrong, not the alert.
- **Escalate by re-using the fingerprint and shortening the cooldown.**
  Rejected: it makes every repeat noisier in order to let one escalation through.
  See D7.
- **A new `mymrc_error_streaks` table.** Rejected: `mymrc_sync_runs` already is
  the streak, indexed on `[site_id, feed, started_at]`.

## Consequences

- One MyMRC feed failing once an hour now produces **one page on the second
  hour** and one more (at `high`) on the third, instead of one page on the first
  hour and then six hours of silence. Steady-state volume goes **down**, and the
  signal that a feed is genuinely stuck arrives with a grade that says so.
- Every ingestion error stored, logged or paged from now on is shorter and, where
  it was a transcript, visibly trimmed (`[N header line(s) redacted]`).
- The two schema comments now describe an enforced property rather than an
  aspiration.
- **Residual, accepted:** container stdout written _before_ this deploy still
  holds one copy of the 04:02 PT text, and it stays there until the log file
  rotates out under the compose `logging` driver's size/count limits. It is not
  worth a log-surgery pass on a running host; the credential itself is invalidated
  by the orchestrating session, which is what makes the copy inert. The ntfy
  server-side copy ages out with the 7-day cache. The database and the run-row
  copies are scrubbed out of band — see `docs/OPEN-ITEMS.md` § 0.BV.
- **Not in scope, deliberately:** the other repos on this fleet publish caught
  errors to ntfy through their own helpers. The boundary rule stated in D1 is
  worth porting; it is not ported here.

## Data assumptions

_(ADR-0131 D4 — the assumptions this decision makes about production data, stated
so a later reader can check whether they still hold.)_

1. **`mymrc_sync_runs` holds one row per site+feed per tick, ordered by
   `started_at`.** D6's streak is read from the two most recent rows for a
   site+feed; if a future writer emits more than one row per tick, or writes rows
   out of order, the streak undercounts and the page arrives late (never early).
2. **`status='error'` is written only by the generic failure branch and by the
   zero-anomaly branch.** A zero-anomaly tick therefore counts toward an `error`
   streak. That is correct — both are failed runs of that feed — but it means a
   zero-anomaly followed by a transport error pages on the _second_ tick, not the
   third.
3. **The MyMRC session cookie is a Salesforce Experience Cloud session and
   matches `00D…!…`.** If MyMRC ever moves off Salesforce, pattern 1 stops
   matching; patterns 3 and 4 (the `cookie:` line and the named pairs) do not
   depend on the shape and still hold.
4. **Playwright prefixes its transcript with a line reading exactly `Call log:`.**
   If an upstream version changes that marker, the line-dropper stops firing and
   the masks alone carry the load — noisier, not leakier.
