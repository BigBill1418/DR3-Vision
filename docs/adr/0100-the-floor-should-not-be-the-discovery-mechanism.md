# ADR-0100 — The floor should not be the discovery mechanism

**Date:** 2026-08-12 (Pacific)
**Status:** Accepted, implemented.
**Implements:** ADR-0094 §5 **P0** (dead-end telemetry) and **P4** (the shipping window).
**Builds on:** ADR-0022 §3/§4 (Loki logging, Prometheus metrics), ADR-0037 (notification grading), ADR-0074 Am.1, ADR-0091, ADR-0099.
**Deliberately does NOT do:** page anyone, add a table, or build a dashboard. §D2, §D5.

---

## Context

ADR-0094 answered Bill's question — _"why do these issues keep happening"_ — and
its answer was not "many bugs". It was one defect class, discovered one branch at
a time, at the rate the floor encounters new kinds of mess:

> The domain model has **no state for divergence** → so a diverged object falls
> through every `if` branch → so it lands in a default render path → and the
> default render path shows what it knows and offers nothing, **because a card
> with no modeled state has no modeled action.**

It then ranked seven remedies by leverage per hour and put one first, ahead of
every fix:

> **P0 — Instrument the dead end. (1 day) — DO THIS FIRST**
> … **Why first:** today, the discovery mechanism for this entire defect class is
> _Bill's phone_. This converts it into a metric. It requires no domain redesign,
> it works on every branch including the ones not yet found, and it turns RC-5's
> maturation curve from a surprise into a readout. It would have surfaced the
> H-136980 class on 8/11 morning rather than at 17:18 via a phone call.

This ADR is P0, plus P4 (free, process-only), which ADR-0094 sequenced second for
the same reason: it costs nothing and removes the highest-correlation factor in
the incident cluster.

**P0 buys no fix.** It buys knowing, one working day ahead of a phone call. That
is the whole claim and it should not be oversold.

---

## D1 — Two events, not one

- **A dead-end render** — a surface showed a state that offers no control.
- **A classified write refusal** — an operator _acted_ and was told no, with a
  named reason (`wrong_day`, `signed_out` — see `write-refusal.tsx`).

Separate counters and separate `evt` values, because they answer different
questions: _what are people stuck looking at_ versus _what are people being
stopped from doing_. Folded into one metric, neither is readable.

## D2 — A log line and a counter. Not a table.

The repo already ships both halves of an ops surface the fleet watches: pino →
Alloy → **Loki** and prom-client → **Prometheus/Grafana** (ADR-0022 §3, §4). A
structured line plus a labelled counter is queryable tonight with no migration and
nothing new that can be down.

A `dead_end_events` table was the alternative and loses on every axis that matters
this week. It needs a migration; it needs a retention policy (these are
high-frequency _renders_, not audit facts — hard rule #6 is about the audit log,
and conflating the two would bury the rows that matter under UI telemetry); and it
would still need a Grafana panel before anyone could read it. Loki gives
full-fidelity events with every field for ad-hoc questions, Prometheus gives the
cheap aggregate for a tile and for the future threshold rule. ADR-0094's bar was
_"log + queryable, no dashboards required tonight"_, and this clears it.

**Label cardinality is a designed property, not a hope.** `surface` and `state`
are CLOSED TypeScript unions, validated again at the API boundary against runtime
arrays. The ceiling is 9 surfaces × 9 states × 2 sites. The object id — `H-136980`,
a load uuid — is deliberately **not** a label; it rides the Loki line, where it is
free and where the per-object question actually gets asked.

## D3 — Identity is resolved server-side, never accepted from the client

The beacon posts a surface, a state and an object id. It does **not** post a user
id, a role or a site. Those come from the session inside the route.

A telemetry endpoint that believes the client about who it is produces a metric
anyone with a session can forge, and this repo has the receipts for what a lying
counter costs: ADR-0019.5's escalation counters recorded delivery _attempts_ as
successes while every page was being dropped, and nobody noticed for a week.

## D4 — The instrument cannot break what it measures

Three independent guarantees, each tested:

1. `recordDeadEnd` / `recordWriteRefusal` wrap **each sink separately**, so a
   prom-client registry error cannot cost the higher-fidelity Loki line, and a
   logger failure cannot throw into a render.
2. The route answers **`204`, always, with no body**. Nothing the client can do
   with a response, and a failure here must not change what the operator sees.
3. The browser beacon uses `keepalive` (so the report survives the navigation
   that usually follows a dead end) and swallows every rejection. **It does not
   retry and does not touch IndexedDB.** The offline queue is for the operator's
   _work_; telemetry has no business competing with it for the one durable store
   on the iPad (hard rule #9). A dead end hit while offline is a lost datum, not
   a lost count of mattresses.

## D5 — Per ADR-0037: a tile and a digest. Not a page.

A dead-end render fails question 1 of the five-question gate — it is not
actionable within five minutes. It does not page, and this ADR ships no alert
rule.

ADR-0094 §P0 named the one shape that could ever earn `high`: _the same object
dead-ended by the same user 3+ times in an hour_ — the signature of somebody stuck
right now — routed to the load page. That rule is **not built here**. The labels
and the Loki fields are chosen so it can be written later without re-instrumenting
anything, and it is registered as a promise rather than left as a sentence.

## D6 — The beacon sits INSIDE the branch it measures

`<DeadEndBeacon>` renders nothing and mounts within the JSX branch, so it cannot
drift away from the state it counts — unlike a `useEffect` at the top of a
component gated on a hand-restated condition. Same reasoning ADR-0091 used for
`describeConsumedSlot`: put the thing next to the thing, so they cannot disagree.

Deduped on `(surface, state, objectId)` in a module-scoped `Set` for the page's
lifetime. React re-renders freely and `<StrictMode>` double-mounts; counting
renders would measure React, not the yard. Module scope rather than per-component
is deliberate — two cards in the same dead state are two events, one card rendered
fifty times is one.

`WriteRefusalNotice` takes `siteCode` and `surface` as **required** props. An
optional telemetry prop is one the next screen forgets, and a surface missing from
the metric is indistinguishable from a surface where nobody is being refused.

## D7 — The shipping window is noon, and it is a convention

Floor-facing changes merge and deploy **before 12:00 PT** or wait for the next
morning. Two exceptions: active incident fixes, and changes that cannot reach the
floor. Written into `CONTRIBUTING.md`.

**Noon, not the 15:00 ADR-0094 §P4 proposed.** Bill set it at noon on 2026-08-11.
15:00 would have permitted the 13:59 ship that sits inside the measured 8/10
cluster; noon leaves a real afternoon of overlap with a staffed floor rather than
its last hour.

**It is a documented convention, not CI**, and that is stated plainly in the file.
Nothing blocks a 9 PM merge today. The mechanism that would make the rule mostly
unnecessary is ADR-0094 §P3 — a floor-shaped smoke check at 06:00 PT — which is
not built.

---

## Consequences

- Every actionless floor state on `main` now emits `evt=floor.dead_end`, and every
  classified refusal emits `evt=floor.write_refusal`, both queryable in Loki and
  counted in `dr3_vision_floor_dead_end_renders_total` /
  `dr3_vision_floor_write_refusals_total`.
- **The first week of numbers will look worse than this week did.** ADR-0094 §6
  says so explicitly, and it should be read that way when it happens: previously
  invisible dead ends becoming visible is the instrument working, not a
  regression.
- A new actionless state without a beacon is now a _visible_ omission — the
  convention is in `CONTRIBUTING.md` — but nothing enforces it. ADR-0094 §P1's
  chokepoint test is what would; it is not built.

## What this does not fix

- **It fixes nothing.** It is a readout. The 48.3% divergence rate is the yard,
  not the software.
- ~~**`slot_withdrawn` is defined but unwired.**~~ **Closed before merge.**
  ADR-0099 landed first, so its withdrawn cards are wired here: a
  `<DeadEndBeacon>` on the hauls card, and a direct `recordDeadEnd` from the
  queue's server-rendered block. Left visible rather than deleted because the
  ordering dependency between the two changes is the interesting part.
- **The site picker's `no_sites` state is defined and unwired.** That page is
  pre-auth and has no site scope, so the beacon's site-scoped route cannot serve
  it. The state has zero live rows (2 sites seeded) and is latent.
- **No threshold rule, no digest, no tile.** ADR-0094 §P0 asked for a 06:30 PT
  digest and a dashboard tile; this ships the data those would read, not the
  readers.
- **Nothing here samples or rate-limits.** At current floor volumes (~92 writes on
  the busiest day) that is fine. It would not be at 100×, and the closed label
  sets are what keep the _metric_ safe in the meantime — the Loki volume is the
  part that would need attention first.
