# ADR-0106 — The manager can fix yesterday, inside this month

**Status:** Accepted, implemented (2026-08-18). Amends ADR-0079 D4, which refused
every prior day. The refusal survives — it moves from the day boundary to the
Pacific calendar-month boundary.

**Builds on:** ADR-0079 (the daily capture itself), ADR-0077 D4 ("not recorded"
is not zero), ADR-0065 (Pacific days everywhere).

---

## Context

ADR-0079 D4 decided that a manager may enter and edit **today** freely, and that
any prior day is refused with `409 requires_amendment` naming the office as the
route. The reasoning was sound and is quoted here because it has not changed:
reuse of the bonus amendment workflow was structurally impossible
(`resolveAmendmentApprover` throws `AmendmentWorkflowForbiddenError` for anyone
who is not a bonus payroll signer), and silently accepting backdated changes to a
compliance-adjacent number was never an option. Given those two, refusing loudly
was the smaller, honest move.

What ADR-0079 could not see is what the floor would do with the refusal.

It did not route corrections to the office. It routed them **back to the TEREX
workbook** — the artifact this product exists to retire. The record of that is
already in the repo, written before this ADR was contemplated:

> The team is still logging maintenance in the TEREX workbook (five edits since
> 8/14). Every revision staged … while the team keeps using the sheet, every
> future edit will re-stage and sit. The fix Bill wants is the team moving to
> Vision's equipment entry.
>
> — CHANGELOG 2026-08-17, and OPEN-ITEMS §0.BB

That is the whole defect. A manager who was out Friday, or who finds on Tuesday
that Monday's units were keyed wrong, had exactly two options: leave Vision
wrong, or fix the sheet. Both of them end with the sheet being the authoritative
copy — which is the state "no more sheets" is trying to end. **A refusal the
users can route around is not a control; it is a redirect to the system you were
retiring.**

## D1 — The line moves from "today" to "this Pacific calendar month"

A manager may enter or edit any `throughput_date` from the **1st of the current
Pacific month** through today. A date in a prior month is still refused with the
same `409 requires_amendment`.

The month is the right unit because it is the unit the operation already closes
on. The workbook is organised as monthly tabs (`Jul26`, `Aug26`); the
reconciliation and the guardrail thresholds run monthly; and a manager can still
honestly reconstruct a day inside the month they are living in — the bins, the
tickets and the operators are all still to hand. Last month is a different
question, and it is a question for the office.

"Yesterday only" was considered and rejected: the most common real case is a
Monday correction to Friday's numbers, which is three days back, and a bound that
does not admit the ordinary weekend case would send exactly the same people back
to the sheet for exactly the same reason.

## D2 — The bound is derived from the DAY KEY, never from `appCurrentMonthStart`

`src/lib/time.ts` already exports `appCurrentMonthStart`. It is the wrong
function here, and the reason is worth writing down because it is invisible on 30
days out of 31.

`appCurrentMonthStart` takes an **instant** and runs it through `appToday()`.
This service holds a `@db.Date` **day key** — UTC midnight. Feeding the key
through the helper re-reads that midnight as an instant, which in Pacific is
17:00 on the _previous_ day. Measured, not reasoned:

```
day key                      : 2026-08-01T00:00:00.000Z
appToday(day key)            : 2026-07-31T00:00:00.000Z
appCurrentMonthStart(day key): 2026-07-01T00:00:00.000Z
```

On the first of the month, that mistake puts the floor a **whole month** back and
accepts every day of the prior month — a fail-**open**, on the one day of the
month a hand-test would never cover. A new `monthStartOfDayKey(day)` carries the
day-key arithmetic, and `appCurrentMonthStart` is re-expressed in terms of it, so
the two cannot drift apart:

```ts
export function appCurrentMonthStart(instant: Date = new Date()): Date {
  return monthStartOfDayKey(appToday(instant));
}
```

The test that pins it uses `today: MONTH_START` with a target of `2026-07-31` —
the day immediately before the floor, so an off-by-one has nowhere to hide.

## D3 — A backdated change REQUIRES a reason, stored on the audit row

Any write to a day before today must carry a `reason`. Without one the write is
refused `422` and **nothing is written** — no row, and no audit row claiming one.
The reason is stored on the **audit** row (`prior_day: true`,
`prior_day_reason: '…'`) alongside the actor and the timestamp the audit table
already carries. Who, when, why.

It goes on the audit row and not on the throughput row because it is a fact about
an **edit**, not about the machine's day — and `notes` already means the latter.
A reason written into `notes` would appear on the chart's tooltip and in the CSV
as though it described the shift.

`clean()` collapses a whitespace-only reason to `null`, so the required field
cannot be satisfied with a space bar. A minimum of **4 characters**
(`MIN_PRIOR_DAY_REASON_CHARS`) refuses `.` and `x` — a bare non-empty check is
satisfied by one keystroke, and the entire value of the field is that a future
reader can tell why a day was rewritten. Four characters does not stand between a
manager and a real answer: "sick" and "typo" both clear it.

**A same-day entry is byte-identical to ADR-0079's.** A reason supplied on a
same-day write is ignored rather than recorded, so the trail never carries a why
with no what. This is pinned by asserting the exact key set of the audit payload:

```ts
expect(Object.keys(after).sort()).toEqual(
  ['equipment_id', 'run_hours', 'throughput_date', 'units_processed'].sort(),
);
```

## D4 — No approval gate, and ADR-0079's own finding is the reason

There is no four-eyes step. ADR-0079 D4 established why, and nothing about that
investigation has expired: `resolveAmendmentApprover` sources the approver from
`bonus_signature_chains` — the payroll PDF dual-signature roster — and throws for
any requester who is not on it. A Woodland equipment manager is not necessarily
one, so an approval gate would hand **the exact audience this feature is for** a
403 they could do nothing about. `bonus_amendment_requests` additionally carries
two `NOT NULL` bonus FKs with no polymorphic targeting (OPEN-ITEMS F-2).

The choice was never "gate or no gate". It was "an in-month audited edit, or the
sheet". The audit trail is the control: append-only, actor-stamped, and now
carrying the reason.

## D5 — The month bound holds on the VOID path too

`voidDailyThroughput` had **no date bound at all**. A manager could soft-void any
day, of any month, through `DELETE /…/daily-throughput/[id]` — the UI merely hid
the button for days that were not today.

That was survivable while `upsert` refused every prior day, because the two
verbs were at least not in contradiction. It is not survivable once a month floor
exists on one verb and not its sibling: last month's figure would have been
**uncorrectable but erasable**. A void makes the day read "not recorded"
everywhere — the series, the tile, the CSV — which is the same class of backdated
change the 409 exists to refuse.

So the void path carries the identical predicate: prior month refused `409`,
in-month prior day requires a reason, same-day unchanged. The refusal was
demonstrated before it was fixed — the naive run shows the void **succeeding**
and returning the row:

```
× ADR-0106 — the month bound holds on the VOID path too > REFUSES to void a
  prior-MONTH day, and the row stays live
  → expected { id: 'dt-old', …(10) } to be an instance of
    DailyThroughputAmendmentRequiredError
```

Closing this also exposed that the three existing void tests never passed a
`today` and were therefore reading the **real** wall clock against rows dated
`2026-08-07`. They passed only because the old void path had no clock to
disagree with. They are now pinned to the fixture day.

## D6 — What is NOT touched

The month bound is a **write-path predicate** and nothing else.

- `run_hours` stays `NOT NULL` and DB-checked `> 0, <= 24`.
- The partial unique `(equipment_id, throughput_date) WHERE voided_at IS NULL`
  is untouched, so a day is still one live row and a voided row still releases
  its day.
- No migration. The reason rides the existing `audit_log.after` JSON, which is
  already append-only and already the record of what changed.
- Reads are unchanged: `enteredThroughputByDay`, the cutover semantics of
  ADR-0079 Am.1 D7/D8, and the entered-always-wins rule all behave as before. A
  backdated entry is simply an entered day, which ADR-0079 Am.1 D8 already says
  beats the legacy figure.

## Alternatives considered

**Keep refusing, and fix the habit with training.** Rejected. The habit is
already documented as persisting across five sheet edits in four days
(CHANGELOG 2026-08-17). The refusal is what produces the sheet edit; asking
people to stop doing the only thing the software leaves them is not a fix.

**Allow any prior day, unbounded.** Rejected. A number that can be rewritten
arbitrarily far back is not a record, and the further back the day, the less able
anyone is to reconstruct it honestly. The month is where "I can still tell you
what happened" ends.

**A rolling N-day window (7 or 14 days) instead of the calendar month.** Rejected
as less legible, not less correct. A manager can always answer "is this day in
this month?" by looking at the date; "is this day within 14 days?" requires
arithmetic, and the answer changes underneath a row that was editable yesterday.
The calendar month also matches how the workbook, the guardrail and the close
already partition time.

**Store the reason in `notes` rather than the audit row.** Rejected — see D3.
It would surface an edit-time explanation on the chart tooltip and the CSV as
though it described the machine's shift.

**Fork a four-eyes approval workflow for equipment.** Rejected again, on
ADR-0079's own evidence (D4). One field does not justify a second approval system
that is guaranteed to drift from the first, and the approver source 403s the
audience.

**Leave the void path alone as out of scope.** Rejected — see D5. A bound with a
sibling verb that ignores it is a bound with a documented bypass.

---

## Consequences

- The "go fix it in the sheet because Vision refuses yesterday" habit no longer
  has a cause. A manager corrects Friday on Monday, in Vision, with a reason.
- Every backdated change is answerable: `audit_log` carries the actor, the
  instant, the before, the after, and now the why. Same-day entries carry no new
  keys, so the ADR-0079 audit shape is preserved exactly.
- A day in a prior month still requires the office. The `409` body now also
  carries `monthStart`, so the refusal states the rule rather than only the
  verdict, and the UI names the boundary date instead of "today".
- `monthStartOfDayKey` exists for any future caller deriving a month from a
  `@db.Date`. The trap it removes is real and was measured, not assumed.
- The entry surface gains a reason field that appears **only** when the chosen
  date is backdated, so the ordinary same-day path is still the two-field form it
  has always been.
- Prior-month days remain visible and non-removable in the UI: no button, because
  an affordance whose only outcome is a refusal is worse than none (ADR-0074
  Am.1).
