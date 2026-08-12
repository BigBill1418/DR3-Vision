# ADR-0071 Amendment 1 — the monitor that could not say it was alive

**Status:** accepted, implemented 2026-08-11 (PT)
**Amends:** ADR-0071 (processor production quota alert). Does not change the quota,
the miss rule, the suppression rule, or who is emailed.
**Related:** ADR-0019.4 (`bonus_chain_health_runs`, the same shape for the same
reason), ADR-0095 (record the delivery, not the attempt), ADR-0037 (alert policy).

## The question

> "Tell me if the processor performance monitor is actually working — we are
> supposed to get alerts about staff not meeting required processing — yet I have
> seen nothing." — Bill, 2026-08-11 ~10:24 PM PT

## The answer

It was never broken, and it never fired. `processor_quota_config.enabled` has been
`false` since the feature shipped on 2026-07-31 — deliberately, because ADR-0071
found that a quota of 75 flags most of the floor and reserved the number for Bill.
Nothing went wrong. What went wrong is that **the system could not say any of
that**, and twelve days of correct behaviour were indistinguishable from an outage.

Ground truth, taken live 2026-08-11 ~10:40 PM PT:

| Probe                              | Result                                           |
| ---------------------------------- | ------------------------------------------------ |
| `processor_quota_config`           | 1 row · Woodland · `enabled = f` · 75 · 2        |
| `processor_quota_logs`             | **0 rows** — no week ever evaluated              |
| `dr3-vision-processor-quota`       | **Up**, next tick 06:00 PT, scheduling correctly |
| `POST /api/internal/bonus/…-quota` | **HTTP 200**, token present (64 chars)           |
| Recipients                         | 3 rows, all addresses correct                    |

The cron was healthy the whole time. It fired, hit a route that returned
`{"outcomes":[]}`, and wrote nothing.

## The mechanism

One clause:

```ts
const configs = await db.processorQuotaConfig.findMany({
  where: dryRun ? {} : { enabled: true },   // ← matched zero rows
  ...
});
```

With the only config disabled, the live run matched nothing, never entered the
loop, and never reached the code that writes a record. That output is byte-identical
to a run against a dropped table, and to no run at all.

ADR-0071 §4 saw this exact hazard and wrote it down:

> "The cost of silence is that 'nobody missed twice' and 'the cron never ran' look
> identical from an inbox. So a suppressed week **still writes a
> `processor_quota_logs` row**."

The reasoning was right; the guard was placed one gate too low. It protected the
suppressed week, which is only reachable **after** the `enabled` filter has already
been passed. The gate that was actually shut had no guard behind it at all.

This is worth naming precisely, because the ADR predicted the failure class,
implemented a guard for it, verified the guard, and still shipped the failure. A
guard is only as good as its position on the path: **it must sit at the earliest
point where the code can decide to do nothing**, not at the first place where
doing nothing is interesting.

## Decisions

### 1. `enabled` gates sending. It does not gate evaluating, and it does not gate the query.

Every config is now read and evaluated on every run. Evaluation is read-only and
costs one indexed query. `enabled` is checked at the single place it means
something — immediately before anything irreversible. A disabled site produces an
honest outcome (`skipped: 'disabled'`) carrying the count the digest _would_ have
sent, and mails nobody.

The benefit beyond liveness: the heartbeat can now answer "what am I not being
told?" without switching the alert on to find out.

### 2. The heartbeat is a run record, not a week record

`processor_quota_runs` gets one row per **live** run — including the run that
evaluated nothing because every site is off, and the run that threw (written from
a `finally`).

It is deliberately **not** keyed on `(site, week)`. That key belongs to
`processor_quota_logs`, where an existing row means _already sent, do not send
again_. A heartbeat sharing it would claim every week it skipped while disabled,
and the morning Bill enables the alert it would find the week already claimed and
stay silent. The guard would have eaten the thing it guards. There is a test whose
only job is to hold that line.

Dry runs write no heartbeat. Their contract is "change nothing", and an operator
trying thresholds from `/admin` must not be able to forge evidence that a cron is
running.

### 3. Three states, not two

`loadProcessorQuotaHealth()` feeds a `processor-quota` subsystem on
`/api/health/subsystems`:

- **green** — a site is enabled and the monitor ran recently. Silence can be
  trusted to mean everyone met quota.
- **amber** — the monitor is running and is deliberately emailing nobody (all
  sites off, or none configured). Nothing is broken; a person chose this.
- **red** — never ran, or stale beyond **36 h**.

Amber is the state that did not exist, and it is the state the system was actually
in. Collapsing it into green is how the silence happened; collapsing it into red
would page somebody about a setting.

Staleness is evaluated **before** the enabled count, because a stopped cron on an
enabled site is the genuinely dangerous failure — managers read no-email as
"everyone met quota" — and reporting it as "switched off" would describe a broken
system as a deliberate one.

**36 h, not 24.** The cron fires daily, so a 24 h budget has zero slack: a deploy
recreating the container across the fire minute, or the 25-hour Pacific day at the
DST fall-back, would flip a healthy monitor red. 36 h tolerates one entirely missed
fire, which is the point at which the daily-firing self-heal has itself failed.

### 4. Eugene was not passing the quota — it was not being looked at

ADR-0071 seeded Woodland only and scoped every query by `site_id`. That scoping is
correct and stays. The unstated consequence: with no Eugene row, `findMany` returns
no Eugene config, and Eugene's 3–4 processors were invisible to the feature
entirely. At the configured threshold, 2 of them would have flagged in the week of
2026-08-03.

Eugene is seeded **disabled**, exactly like Woodland. This mails nobody today and
makes the site visible on `/admin/processor-quota` so its threshold can be tried
against real weeks first. Recipients are deliberately **not** seeded — ADR-0071's
own hardest-won finding is that a guessed address does not fail loudly.

Consequence handled: the admin page's `findFirst()` was safe only while exactly one
row existed. Unordered across two rows it silently changes which floor it is
describing. It is now an ordered `findMany` with the site in the URL.

### 5. Not done: enabling the alert

Enabling it would mail three managers a list naming 18 of 21 Woodland processors.
That is the irreversible action ADR-0071 explicitly reserved for Bill, and nothing
found tonight changes who should make it. See below.

## What the silence cost, measured

Woodland, at the configured 75 units / 2 misses, per completed week (on-roster
processors, as the email would have named them):

| Week starting | Processors seen | Would have been emailed |
| ------------- | --------------- | ----------------------- |
| 2026-06-29    | 9               | 3                       |
| 2026-07-06    | 17              | 6                       |
| 2026-07-13    | 19              | 5                       |
| 2026-07-20    | 18              | 11                      |
| 2026-07-27    | 23              | 13                      |
| 2026-08-03    | 21              | **18**                  |

Eugene would have flagged 2 in the week of 2026-08-03 (of 3 seen).

Six digests, and the trend is the wrong way: the most recent names **86% of the
floor**. Woodland's median daily output across this span is **64 units against a
75 quota** — the threshold sits above typical performance, so under-quota is the
normal day, not the exception. (Eugene's median is 83, comfortably above.)

Sensitivity, Woodland, mean processors flagged per week:

| Quota | ≥2 misses | ≥3 misses | ≥4 misses |
| ----- | --------- | --------- | --------- |
| 75    | 9.3       | 6.8       | 5.3       |
| 65    | 7.7       | 5.5       | 4.2       |
| 60    | 6.3       | 4.2       | 3.2       |
| 55    | 5.5       | 3.8       | 2.5       |
| 50    | 4.5       | 2.8       | 1.8       |
| 45    | 3.7       | 2.2       | 0.8       |

ADR-0071's read stands and is now confirmed over six weeks instead of one: the
sensitivity comes as much from **2 misses in a 5-day week** as from the quota.
Both are settings; neither needs a deploy.

## Verification

21 new tests. Every guard falsified before being kept — broken on purpose,
observed red, restored:

| Break                                                       | Went red |
| ----------------------------------------------------------- | -------- |
| restore `where: { enabled: true }` (the original defect)    | ✅ 2     |
| heartbeat write removed                                     | ✅ 3     |
| disabled path writes a week log (claims the week)           | ✅ 1     |
| liveness collapses "switched off" into green                | ✅ 1     |
| staleness check defeated (dead enabled cron reads as "off") | ✅ 2     |

**A defect found by falsifying rather than assuming.** The first attempt to break
the `enabled` filter came back **green**, which would have been reported as "the
guard holds". It did not hold — the test double's `findMany` ignored its `where`
argument and handed back the config row regardless, making it _more permissive than
Postgres_. The twelve-day silence was therefore not merely untested, it was
untestable: no arrangement of that fixture could observe a disabled row. The double
now applies `where.enabled` the way the database does, and only then does the break
go red. A mock that cannot express the bug cannot guard against it.

Full suite: 5,362 passing.

## Needs Bill

1. **The quota number and the miss threshold** — still the open decision from
   ADR-0071, now with six weeks of evidence instead of one. Until it is settled the
   digest stays off and the health pill stays amber, which is now honest rather
   than silent.
2. **Whether Eugene should alert at all**, and if so, to whom. Its config exists and
   is empty of recipients by design.
