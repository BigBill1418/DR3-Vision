# Contributing to DR3-Vision

Working conventions that are not code. Everything here is enforced by people
reading it, not by CI — where a rule graduates to CI, this file says so and points
at the check.

Read `CLAUDE.md` first; it is the orientation and carries the hard rules. This
file carries the process rules that sit on top of them.

---

## The shipping window: floor-facing changes deploy BEFORE 12:00 PT

**Rule.** A change that alters behaviour on any `/operator` surface — the floor
iPads — merges and deploys **before 12:00 noon Pacific**, or it waits for the next
morning. Anything that misses the window sits on its branch overnight.

**Two exceptions, and only two:**

1. **Active incident fixes.** The floor is blocked *right now*. Ship it. This rule
   explicitly does not slow incident response — 2026-08-11's 55-minute
   report-to-merge (ADR-0091) is the standard to keep, not to trade away.
2. **Changes that cannot reach the floor.** Manager/admin surfaces, ops tooling,
   docs, and anything `[skip-deploy]`. If it cannot change what an operator sees
   tomorrow at 07:00, the window does not apply.

### Why noon

Evening ships are first exercised by the floor the next morning, and the interval
between "a change lands" and "the floor finds what it broke" is currently **one
night** with no verification step in between. ADR-0094 §RC-3 measured it:

> On Monday 2026-08-10, four behaviour-changing PRs merged into the floor
> surfaces at **13:59, 16:29, 17:34 and 19:54 PT**. At **07:50 PT the next
> morning**, Pablo was stranded — by the 16:29 ship. ADR-0091 traces the causal
> chain explicitly.

And the same pattern one weekend earlier: four PRs covering the entire P2–P5 floor
campaign merged in a **43-minute window between 02:34 and 03:17 on Saturday
2026-08-08**. ADR-0084's own verification section records what that cost — *"No
Postgres was reachable from the build host … It has not been executed locally;
that is the honest status"* — a database test shipped un-run at 2:34 AM.

Shipping before noon leaves the rest of the working day for the change to be
exercised while the people who wrote it are awake and the floor is still staffed.
It costs a few hours of latency and removes the single highest-correlation factor
in the 8/10–8/11 incident cluster.

**Noon, not 15:00.** ADR-0094 §P4 proposed a 15:00 cutoff. Bill set it at noon on
2026-08-11. Noon leaves a genuine afternoon of overlap with the floor rather than
the last hour of it; 15:00 would have permitted the 13:59 ship that is inside the
measured cluster.

### What this is not

- **Not CI.** Nothing blocks a 9 PM merge today. It is a convention, and it is
  written down here so that breaking it is a decision somebody made rather than a
  thing that happened.
- **Not a substitute for the smoke check.** ADR-0094 §P3 — a floor-shaped check
  that signs in as a real operator and asserts no surface presents an open object
  with no route, run at 06:00 PT and post-deploy — is the mechanism that would
  make this rule mostly unnecessary. It is not built. Until it is, this rule is
  what stands between an evening merge and an operator.
- **Not retroactive absolution.** The week-one dead-end slice (PRs #248, #251 and
  the telemetry) was itself shipped late in the evening of 2026-08-11, which this
  rule would have deferred to the morning. That is recorded rather than hidden:
  the work was approved for that evening, the changes are additive (they add
  routes and explanations to states that previously had none, and none removes an
  existing control), and the residual risk is real and is stated in
  `docs/OPEN-ITEMS.md` 0.AY. A rule whose first act is to exempt its own author
  is not a rule, so: this was an exception, taken knowingly, and the mitigation is
  a floor check the following morning.

---

## Documentation discipline

Every code or feature change is recorded in the same change:

- **Behaviour change** → a dated entry in `CHANGELOG.md`. Dates are **Pacific**,
  always — the fleet hosts and git both stamp UTC, so an evening merge lands on
  the next UTC day and would be mis-dated by a day if taken from the commit.
- **Non-obvious technical decision** → an ADR under `docs/adr/`. **Claim the
  number first** (see `docs/adr/README.md`); `0067`, `0069`, `0087` and `0097`
  have all been claimed twice, the last of them by two PRs **19 seconds apart**.
- **Forward promise** → a row in `docs/adr/PROMISES.md`. Prose commitments do not
  execute: ADR-0094 §RC-4 counted ~42 promises across 13 floor ADRs carrying zero
  issue numbers, one of which (the health pill) was cited as a live control by two
  later ADRs and had never shipped — for four months.
- **Loose end** → `docs/OPEN-ITEMS.md`.

Two CI checks back this up (ADR-0098):

| Check | Mode |
| --- | --- |
| `node scripts/check-adr-citations.mjs` | **hard fail** — every `ADR-NNNN` / `Amendment N` in `src/` must resolve to a real file and section |
| `node scripts/extract-adr-promises.mjs --check` | warn — a new ADR stating a commitment with no `PROMISES.md` row gets an annotation |

---

## Floor surfaces have a higher bar

Anything under `src/app/operator/` is used by people wearing gloves, on a shared
kiosk, outdoors, in three languages, often offline.

- **Never ship a control whose only outcome is a refusal** (ADR-0074 Am.1). A
  state with no legal action gets a *named, translated* explanation plus a route
  out — never a bare paragraph, and never a button the server will reject.
- **Never render a raw enum, a thrown `Error.message`, or an untranslated
  string.** Server Action throws reach the browser REDACTED in production, so
  `setError(e.message)` renders Next's redaction text (audit D-11).
- **Every instant is Pacific-pinned** through `@/lib/format`. The container runs
  UTC; `toLocaleTimeString()` reads the *device* clock on a shared iPad.
- **Add copy to all three locales in one commit.** `locale-parity.test.ts` is
  CI-blocking.
- **New actionless state?** Mount a `<DeadEndBeacon>` beside it (ADR-0100) so it
  is countable. The discovery mechanism for this defect class used to be Bill's
  phone.
