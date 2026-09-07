# ADR-0130 — The cooldown that died with the process

- **Status:** Accepted
- **Date:** 2026-09-07
- **Follows:** ADR-0036 (ntfy transport); ADR-0037 (noise policy + the 5-question gate); ADR-0038 (the self-contained MyMRC pager); ADR-0070 / ADR-0089 (mirror freshness); ADR-0102 (the transport that could never find a file)
- **Grading:** ADR-0037 — §5 re-grades every `dr3-vision-system` alert this repo publishes
- **Coordination:** the code half of this ADR was implemented in parallel against **D1–D3 below**.

## Context

Bill reported "tons of alerts about the scraper and data failures." The
`dr3-vision-system` topic held **29 messages in its retained window** (polled
2026-09-07 13:10 PDT, `?poll=1&since=720h`; the server's cache reaches back only
to 2026-08-31 17:04 PDT, so this is a ~7-day window, not 30). **Eighteen of the
29 were published between 05:01 and 13:01 PDT on 2026-09-07** — nine
`MyMRC mirror stopped advancing — woodland [processed]` and nine
`… [outbound]`, one pair per hour, on the hour.

Each of those pages is `fingerprint=mymrc-stale-mirror:woodland:processed`, and
`freshness.ts:46` sets `FRESHNESS_COOLDOWN_MS = 24h`. The policy says one page
per site+feed per day. Twenty-four hours of policy produced nine pages in eight
hours.

### The mechanism

`src/lib/ntfy.ts:152` and its ADR-0038 twin `src/lib/mymrc/ntfy.ts` hold the
cooldown ledger in a module-level `Map`. The comment at `src/lib/ntfy.ts:144-151`
states the assumption plainly:

> One ledger per Node.js process. Multi-replica deployments would each keep their
> own ledger, but DR3-Vision runs a single replica on CHAD-HQ so this is
> sufficient.

The assumption is about REPLICAS. It is true of `dr3-vision-app`, which is one
long-lived process. **It is false of every cron container in this stack**, and
there are nineteen of them. `dr3-vision-mymrc-scrape` is a scheduler that logs

```
[mymrc-cron 2026-09-07T20:00:00.001Z] spawning /app/scripts/mymrc-scrape.mjs
[mymrc-cron 2026-09-07T20:01:20.852Z] scrape exit code 0
```

— a **fresh Node process every hour**. The Map is constructed empty, the first
`cooldownActive()` lookup misses, the page is sent, the Map is written, and 80
seconds later the process exits and takes the ledger with it. The cooldown window
is not 24 hours. It is the lifetime of one scrape, and it therefore never
suppresses anything. The observed inter-message deltas —
`3601, 3604, 3595, 3595, 3604, 3603, 3601, 3593` seconds — are the cron period
with jitter, not a cooldown.

This is not specific to `stale_mirror`. Every alert published from a one-shot
process in this stack has an unenforced cooldown: `auth_failed`,
`contract_drift`, `zero_anomaly`, `deadman`, `dateless_hauls`, `error`, and
anything a future cron publishes. The MyMRC feeds are simply the first condition
that persisted long enough for the absence to be visible.

### The counter-example is already in this repo

`workbook-sync` publishes into the same topic under the same ADR-0037 policy, and
in the same six days of a continuously-failing condition (`consecutive_failures =
380`) it published **one** page. Its cooldown is a column:
`workbook_sources.last_alert_at`, `2026-09-07 13:03:45` — one row, one write, one
page. Same transport, same policy, two storage choices, and two orders of
magnitude of difference in what Bill's phone did. The fix is not new; it is
already deployed six feet away, and the ntfy pager did not use it.

## Decision

**D1 — The cooldown ledger moves into Postgres.** One table, `alert_cooldowns`,
keyed on the fingerprint the caller already computes, holding the instant the
cooldown expires. Postgres is the only state every DR3-Vision process shares,
every cron container already holds `DATABASE_URL`, and the repo has this exact
shape twice already (`alert_digest_logs`, `bonus_daily_report_log` — an
idempotency row behind a unique key).

**D2 — The claim is atomic, not read-then-write.**

```sql
INSERT INTO alert_cooldowns (key, expires_at, last_sent_at, send_count)
VALUES ($1, $2, now(), 1)
ON CONFLICT (key) DO UPDATE
   SET expires_at   = excluded.expires_at,
       last_sent_at = now(),
       send_count   = alert_cooldowns.send_count + 1
 WHERE alert_cooldowns.expires_at <= now()
RETURNING key;
```

A returned row means this caller owns the window and must send. No row means a
live cooldown is held and the caller must suppress. Two processes racing the same
fingerprint cannot both send. A `SELECT` followed by an `UPDATE` reintroduces
exactly the race the in-process Map was hiding, and the hourly cron plus the
long-lived app plus a manual admin re-run are three writers, not one.

**D3 — A ledger failure SENDS; it does not swallow.** If the conditional upsert
throws (database unreachable, migration not yet applied), publish anyway and log
the failure. An alert path must never be silenced by the failure of its own
noise-suppression machinery. The cost of erring toward send is a duplicate
notification; the cost of erring toward suppress is silence during an incident.

**D4 — `send_count` and `last_sent_at` are kept, and they are the instrument.**
The Map could not answer "how many times did we suppress this?" because it held
only an expiry. A row that records how often a fingerprint has fired is what makes
the next ADR-0037 re-grade evidence-based instead of anecdotal.

**D5 — The MyMRC pager takes the ledger as an injected dependency.**
`src/lib/mymrc/*` compiles standalone via `tsconfig.mymrc.json` and cannot import
`@/lib/...` (ADR-0038). `ntfyPager` is currently a module-level `const` with no
database handle. The ledger is therefore passed in — the same way
`checkMirrorFreshness` already takes `prisma` and `pager` — rather than reached
for. A pager that constructs its own Prisma client inside a bundle that is not
allowed to know about `@/` is how the fifth copy of a fix gets written.

### Alternatives considered

| Option                                          | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-process `Map` (status quo)                   | Is the defect. Correct for `app`, silently inert for nineteen cron containers.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Redis `SETNX`** (what `ntfy.ts:149` proposes) | **There is no Redis in this stack** — `docker-compose.yml` declares 25 services and none is Redis; `grep -ri redis` over the repo returns only OpenTelemetry instrumentation packages in `package-lock.json` and two aspirational comments. Adding a container, a healthcheck, an ADR-0057 build-pattern entry and a backup question to hold a few dozen keys that Postgres already holds transactionally is not a trade worth making. A Redis restart also loses the ledger — the same failure class, with a longer half-life. |
| File-backed ledger on a mounted volume          | The cron processes run in **separate containers**, each with its own filesystem. Only `postgres-data` and `mymrc-auth-state` are named volumes, and only the latter is shared with the scraper. This would mean a new shared volume mounted into every cron service, plus lockfile gymnastics to get an atomic compare-and-set across containers, plus it does not survive a host move while the database does. More compose surface than a table, for less correctness.                                                        |
| Server-side dedup at ntfy                       | ntfy has no per-fingerprint cooldown; its dedup surface is topic plus an optional message id. ADR-0037 is our policy and belongs on our side of the transport, where it can be graded, tested and counted.                                                                                                                                                                                                                                                                                                                      |

## The three conditions that were firing, and what each of them actually was

The storm was the delivery mechanism. It is worth separating what was being
delivered, because two of the three underlying conditions were **not** what the
page said they were.

### §3 — `stale_mirror`: the alert is true and the threshold is wrong

`DEFAULT_MAX_AGE_MS = 96h`, justified in `freshness.ts` as _"96h clears a normal
weekend plus a holiday Monday without firing."_ Measured against the live mirror,
**it does not.**

The MyMRC `processed` feed carries **exactly one row per business day** (1,018
rows, one per weekday from 2026-06-01 to 2026-09-03, plus a handful of
Saturdays), and `outbound` carries 6–12 per business day, 1–3 on a Saturday and
none on a Sunday. Records for business day _D_ are first seen at _D+1_ — and
after a weekend, at _D+3_ (`2026-08-14` Fri, `first_seen_at 2026-08-17 15:00`).
`entry_date` is stored noon-anchored (`2026-09-03 12:00:00`), which adds twelve
hours to every measured age.

Reconstructing the age curve hour by hour from `first_seen_at` over
2026-07-31 → 2026-09-07:

| Day            | Peak calendar age | 96h rule | Business days behind | ">2 business days" rule |
| -------------- | ----------------- | -------- | -------------------- | ----------------------- |
| Fri 2026-07-31 | 254 h             | **FIRE** | 9                    | **FIRE**                |
| Tue 2026-08-04 | 99 h              | **FIRE** | 2                    | ok                      |
| Mon 2026-08-17 | 99 h              | **FIRE** | 2                    | ok                      |
| Mon 2026-08-31 | 75 h              | ok       | 1                    | ok                      |
| Mon 2026-09-07 | 104 h             | **FIRE** | 1                    | ok                      |

The 2026-07-31 fire is the genuine nine-day freeze this guard was written for.
**The other three are false.** An ordinary Monday peaks at 83–99 h against a 96 h
threshold — a margin of a few hours — so whether Bill's phone rings on any given
Monday is decided by what time on Saturday MyMRC happened to post Friday's row.
Three false pages in thirty-eight days, all on a Monday or Tuesday, is not a
tuning problem; it is a units problem. **A feed that only advances on business
days cannot be measured in calendar hours.**

**D6 — Freshness is measured in business days, not calendar hours.** Stale means
the newest business record is more than **2 business days** behind today, where
business days are Mon–Fri minus an explicit holiday list the operator owns.
Against the same 38 days of live data this rule fires **once** — on the real
outage — and never otherwise. It is also FASTER on a real freeze: three business
days behind is reached on the Friday of a Wednesday freeze, where 96 h waits for
the fourth calendar day. Quieter and earlier, from the same data.

**D7 — The 2026-09-07 page was reporting a real gap, and the scraper was not the
cause.** The mirror is genuinely missing Friday 2026-09-04: every previous Friday
since 2026-06-05 carries 1 processed row and 8–11 outbound rows, and 2026-09-04
carries none. The scraper is provably not responsible:

- the list pass paginates **newest-first** (`stop=page_cap` after 4 × 200), so the
  800-id window truncates the OLD tail — a record created on 2026-09-04 would be
  at the top of page 0, not past the cap;
- `rows_upserted = 800` on every run — the walk is doing its work;
- `details=0` is **not** a symptom. Detail coverage is `1018/1018` processed and
  `4789/4789` outbound. `details=0` means "nothing new to fetch," which is the
  healthy steady state; the same run fetched `details=3` for `haulsCompleted`,
  which did have new records.

The `hauls` feed **does** hold a delivered record for 2026-09-04, so trucks
arrived. Processed and outbound entries are posted at the source with a one-day
lag by a person, and Friday before a holiday weekend is exactly when that person
does not post. **Calibrated: I expect Friday's rows to land on Tuesday
2026-09-08.** If they have not by Wednesday 2026-09-09, that is a real upstream
gap and the business-day rule fires on its own — which is the point of the rule.

**D8 — One condition pages once.** `processed` and `outbound` freezing together
is one upstream stoppage, and it published two pages an hour. The page is emitted
per site and names the stale feeds, not per site+feed (ADR-0037 Q4 — deduplicate
against root cause).

### §4 — `workbook sync not_found`: ADR-0102, a second time, in the same row

The page said 337 consecutive failed polls, last successful read 6 days ago. It
was right about the symptom. Its recommended actions — "check for a rename, a
typo, a stray copy, or a moved folder" — are the same actions ADR-0102 §1 already
recorded as the wrong place to look. There are again **two independent defects,
either sufficient alone**, and both were found by enumerating the live drive
read-only through the same Graph transport the sync uses.

**Defect A — the folder never rolled over.** The live row holds

```
folder_path = DR3/Woodland/Woodland Operations/2026 Daily Logs/August 2026 Woodland
```

with the month **already expanded**. ADR-0102 §5 specified the tokenised value
`…/{YEAR} Daily Logs/{MONTH_TITLE} {YEAR} Woodland`, and `engine.ts:296` correctly
calls `resolveMonthlyFolderPath(source.folder_path, monthAnchor)` — but that
function expands tokens, and a string with no tokens comes back unchanged. **The
code shipped; the production row was never migrated to it.** So on 2026-09-01 the
file name rolled to `SEPTEMBER` and the folder stayed `August`, and the transport
has been asking for September's file inside August's folder ever since. That is
precisely the failure ADR-0102 §137 predicted in writing —
_"a static `folder_path` is correct for at most one month and then silently
wrong"_ — landing thirty days later because the fix was written but not applied.

**Defect B — Kelsey named the file `SEPT`.** Live listing of
`…/2026 Daily Logs/September 2026 Woodland`:

```
FILE   692880  2026-09-04T17:40:04Z  SEPT 2026 DAILY LOG WOODLAND.xlsm
```

The naming pattern `{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm` expands `{MONTH}` to
`SEPTEMBER`. **Fixing the folder alone would still return `not_found`.** And the
file is live — 692,880 bytes, last modified **2026-09-04 10:40 AM PDT**. The floor
has been filling it in all along, and Vision has ingested none of it since
2026-09-01.

Three of the seven months on that drive do not match the pattern:

| Month     | Actual file name                              | Matches `{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm`? |
| --------- | --------------------------------------------- | ------------------------------------------------- |
| March     | `MARCH_2026 DAILY LOG TEMPLATE WOODLAND.xlsm` | no                                                |
| April     | `APRIL 2026 DAILY LOG WOODLAND.xlsm`          | yes                                               |
| May       | `MAY 2026 DAILY LOG WOODLAND(1).xlsm`         | no                                                |
| June      | `JUNE 2026 DAILY LOG WOODLAND.xlsm`           | yes                                               |
| July      | `JULY 2026 DAILY LOG WOODLAND.xlsm`           | yes                                               |
| August    | `AUGUST 2026 DAILY LOG WOODLAND.xlsm`         | yes                                               |
| September | `SEPT 2026 DAILY LOG WOODLAND.xlsm`           | **no**                                            |

**D9 — An exact-name match against a human-named file is the wrong contract.**
4 of 7 is not a naming convention; it is a coincidence that held four times. The
discovery falls back to a **single tolerant match within the resolved folder**:
one `.xlsm` whose name contains the year and a prefix of the month name, ignoring
case, `_`, and a trailing ` (n)` / `(n)` copy suffix. Exactly one candidate ⇒ use
it and record the name actually used. Zero or more than one ⇒ `not_found`, and
**the page lists what IS in the folder** so the reader can see `SEPT` against
`SEPTEMBER` without opening SharePoint. ADR-0102's lesson was that collapsing two
distinct causes into one empty list cost six weeks; a page that cannot say what it
did find repeats it.

**D10 — The folder pattern is re-tokenised in production and guarded.** A
`folder_path` that contains a month name but no `{` token is a latent
time-bomb — correct this month, silently wrong next month. The admin surface
rejects it on save, and the ledger row carries the RESOLVED folder path so a
future reader can see where the transport actually looked.

### §5 — `doc-ingest discovery gap`: a real signal that pages one scan too early

The page is honest: _"The reachability probe could not run, so Vision CANNOT
currently tell whether it is missing documents."_ The cause is upstream —
`POST /search/query → HTTP 500 InternalServerError, target
XapSearchWorkflowProviderV3` — and Microsoft's own message is _"The call failed,
please try again."_

Measured on the ledger: **8 errored scans out of ~2,400 over 26 days (0.33%)**,
and `gap_count = 0` with `reachable_count = watched_count = 11` on **every**
successful scan since 2026-08-17. The container log shows 6 failed sweeps in 793
(0.76%) over the last 200 h, five of them a client-side `This operation was
aborted`. The probe runs every 15 minutes and the next attempt after each failure
succeeded.

That fails ADR-0037 **Q3 — has the system tried to self-heal first?** It pages on
the first miss of a check that retries in fifteen minutes and succeeds 99.7% of
the time.

**D11 — Transient probe failure is a dashboard tile until it is a pattern.** The
"probe could not run" page fires only after **3 consecutive failed scans** (~45
minutes of genuine blindness) at `default`. A real finding — `gap_count > 0`,
documents reachable that nothing is watching — stays a `high` page on its leading
edge, because that one is actionable and cannot self-heal.

## §6 — The ADR-0037 grading matrix

Every alert this repo publishes to `dr3-vision-system`, re-graded. `Cooldown` is
the D1 durable window; every row is per-fingerprint.

| Alert (`kind`)                        | Was          | Priority    | Cooldown | Gate note                                                                                                                                                                         |
| ------------------------------------- | ------------ | ----------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth_failed`                         | high / 30 m  | **high**    | **6 h**  | Q1 yes — Bill re-enters the login at `/admin/mrc-scrape`. Blocks every feed.                                                                                                      |
| `contract_drift`                      | high / 30 m  | **high**    | **24 h** | Q1 no (needs a code change) but it is the leading edge of total blindness. Daily is enough.                                                                                       |
| `zero_anomaly`                        | high / 30 m  | **high**    | **12 h** | Q1 yes — verify the feed by hand. Q3 satisfied: it fires against a prior non-zero run.                                                                                            |
| `deadman` (no success in 26 h)        | high / 30 m  | **high**    | **12 h** | Q3 satisfied by construction — 26 h of self-heal has already elapsed.                                                                                                             |
| `stale_mirror`                        | high / 24 h¹ | **default** | **24 h** | Q2 no — internal reconciliation input, never customer-visible. **Escalates to `high` at ≥5 business days.** Business-day threshold (D6); one page per SITE naming the feeds (D8). |
| `dateless_hauls`                      | high / 24 h¹ | **default** | **24 h** | Q1 is "ask MRC", i.e. same-day. Residual is 0/7,314 so any fire is genuinely new.                                                                                                 |
| `error` (unhandled sync failure)      | high / 30 m¹ | **default** | **6 h**  | Q3 — one hourly retry is free. Promote to `high` after 3 consecutive.                                                                                                             |
| `workbook not_found`                  | high / DB    | **high**    | **24 h** | Q1 yes and it is silent data loss. Already durable — keep. Message must list the folder contents (D9).                                                                            |
| `workbook forbidden` (403)            | high / DB    | **high**    | **12 h** | Grant revoked; nothing ingests until an operator acts.                                                                                                                            |
| `doc-ingest` probe failure            | default / —  | **default** | **6 h**  | **Only after 3 consecutive failed scans** (D11). Below that it is a dashboard tile.                                                                                               |
| `doc-ingest` real gap (`gap_count>0`) | default / —  | **high**    | **24 h** | Q1 yes — a reachable document nothing is watching is a real hole.                                                                                                                 |

¹ nominal only — published from a one-shot cron, so the cooldown was never
enforced. This column is the whole reason for D1.

**Nothing in this repo publishes `urgent`.** ADR-0037 reserves `urgent` for
customer impact now or imminent data loss, at a target of ≤2/week. Every alert
above is an internal ingestion signal about a system that bills monthly. The
existing `URGENT: bonus signatures still pending` page (priority 5, seen
2026-09-01) is the one legitimate `urgent` in the topic and is out of scope here.

## Consequences

- **Bill's phone stops repeating.** A persisting `stale_mirror` becomes at most
  one page per day per site instead of 24, and under D6 the three false Mondays
  in the last five weeks would not have paged at all.
- **The cooldown becomes auditable.** `send_count` and `last_sent_at` mean the
  next re-grade reads rows instead of guessing.
- **A new failure mode is created and accepted:** if Postgres is down, the
  cooldown is not enforced and alerts may duplicate (D3). That is the correct
  direction to fail, and a database outage has louder symptoms than a repeated
  ntfy message.
- **Two open items go to an operator**, recorded in `docs/OPEN-ITEMS.md` §0.BR:
  the September workbook file name, and the Friday 2026-09-04 MyMRC gap to
  re-check on 2026-09-08.
- **ADR-0102 is amended in practice, not in text.** Its folder-rollover decision
  was correct and was never applied to the production row. D10 adds the guard
  that would have caught that, and this is the second incident in this repo whose
  root cause is _"the ADR shipped, the data did not."_ That pattern is worth
  watching for on its own.

## Amendment 1 — what implementation changed (2026-09-07)

D1–D11 all shipped. Five things the code settled differently from, or more
precisely than, the decision text above. Recorded here rather than as a separate
file, per repo convention.

**A1.1 — the holiday list was already there, and it is NOT the federal set.**
D6 needed "an explicit holiday list the operator owns" and P-65 recorded that
nobody had said whether DR3 observes the federal holidays. It is answered, from
the primary source: `site_holidays` already exists, is already populated in
production for both sites across 2026 and 2027, and already contains
**2026-09-07 Labor Day** — the one that mattered. It backs the AP escalation
clock, the throughput-gap watchdog, the audit sweep and the bonus EOD check, so
D6 inherits the operator's calendar instead of inventing a second one.

It holds **six** closures, not eleven: `prisma/seed/README.md` states _"The six US
federal holidays observed at both DR3 sites … Bill confirmed both sites use the
same six (Q19 in the charter)."_ That is the correct list for this rule and
populating the other five federal days would make it **worse**: marking a day the
floor actually works as a non-business day under-counts the deficit and delays a
real freeze. The §3 replay was re-run against these six (not the eleven Terry
used) and the result is unchanged — one fire, on the real outage.

Residual: the seed covers 2026–2027 only, matching the contract term. From
2028-01-01 the set is empty until someone appends it, which makes the rule
slightly MORE eager (weekends still excluded), never silently disabled.

**A1.2 — D6 was applied to the pager, and deliberately NOT to two downstream
guards.** `src/lib/cor/inbound-gate.ts` and `src/lib/loads/eod-inventory.ts` both
imported `DEFAULT_MAX_AGE_MS` so they "cannot drift into disagreeing about when
intake has stopped." D6 changes the units, which would have silently re-decided a
`409` that blocks a COR from being filed and a why-suspect flag on an operator
figure. Neither is a notification, and neither was in scope for a
notification-noise ADR. Both now carry their own explicit calendar constant
(`COR_INBOUND_STALE_MS`, `INBOUND_STALE_DAYS`) with the decoupling stated at the
constant, and behave exactly as they did before. Converting them is probably
right — under calendar hours the COR gate refuses to file on an ordinary Monday
for the same reason the pager false-fired on one — and is its own decision,
recorded in `docs/OPEN-ITEMS.md`.

**A1.3 — two detail differences inside D2's shape.** The claim is still one
atomic conditional upsert, claim-or-refuse. (i) `$3` carries the caller's instant
rather than Postgres `now()`: there is no second clock to disagree with (app and
database are containers on one host), and an injectable instant is what lets the
suite replay twenty-four hourly ticks and assert exactly one claim, which `now()`
makes untestable. (ii) The verdict is the affected-row count, not `RETURNING key`
— identical information, and it keeps the injected `CooldownDb` to ONE required
method, which is the fail-closed-on-compile seam.

**A1.4 — D8's fingerprint change orphans ledger rows, and that needs nothing.**
`mymrc-stale-mirror:<site>:<feed>` becomes `mymrc-stale-mirror:<site>`. The old
keys are never claimed again and the D1 reaper deletes rows more than seven days
past expiry, so there is no migration. The first page under the new key fires
immediately rather than inheriting the old window — one clean page, then daily,
which is the intended behaviour.

**A1.5 — D11 needed a resolve, not just a counter.** `pageAfterOccurrences: 3`
alone does not mean "3 consecutive": `occurrences` has no decrement, and only
resets because the OPEN row is closed. `runReachabilityScan` therefore now
RESOLVES the probe-failure row on any scan that returns, which is what makes the
count consecutive. Verified read-only on production 2026-09-07 before splitting:
every `discovery_gap` row in the ledger is `status = 'resolved'` with
`occurrences = 1` and every one is a probe failure — 8 pages, 9 errored scans out
of 2,480 over 26 days (0.36%), each followed by a success. There is no OPEN row,
so the split orphans nothing and the migration adds an enum value only, with no
backfill: historical rows keep the kind the system actually believed at the time.
