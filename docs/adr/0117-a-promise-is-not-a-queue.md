# ADR-0117 — A promise is not a queue

- **Status:** Accepted — 2026-08-19. Approved by Bill in the 2026-08-19 22:30 PT
  transaction-boundary review; shipped the same night.
- **Context:** Post-signature payroll delivery is fired from a bare
  `void (async () => { … })()`. If the process that created that promise dies
  before the promise finishes, the delivery is lost with no record and nothing
  re-drives it. Found in the 2026-08-19 engineering audit (critical #1).
- **Supersedes / amends:** nothing. Extends ADR-0021 (M365 payroll delivery) and
  ADR-0019 §5 (the post-signature chain). Uses the ADR-0078 real-database test
  lane and the compare-and-swap idiom of `correct-count.ts` / `void-count.ts`.

## Context

`triggerPayrollDelivery` (`src/lib/bonus/payroll-delivery.ts`) is deliberately
non-blocking. The signing manager taps a button; the request must return in
milliseconds, not wait on Chromium rendering a PDF and Microsoft Graph accepting
a mail. So the whole chain runs inside a floating promise:

```ts
export function triggerPayrollDelivery(monthId: string): void {
  const requestId = newRequestId();
  void (async () => {
    await generateBonusPdf(monthId);
    // … R2 fetch, reconciliation gates, sendPayrollPdf, markPaid
  })();
}
```

That decision is right and this ADR keeps it. What was never true is the
assumption underneath it — that the promise would always get to run.

**The promise lives only in the memory of one Node process.** It has no ledger
row, no queue entry, no marker of any kind. Anything that ends the process
between the sign latch committing and the chain completing destroys it silently:

- **a deploy.** This stack auto-deploys from `main` on every push; the container
  is recreated. On 2026-08-19 alone, three deploys rolled.
- an OOM kill, a host reboot, a `docker compose up` on a co-tenant change;
- an unhandled rejection anywhere the chain does not already catch.

The sign transaction has already committed at that point. The period is
`signed`. The manager's screen said it worked, and it did — the signature is
real. Only the delivery is gone.

**Nothing notices until the next morning.** The single downstream check is the
t4 escalation tier at 09:00 PT, which pages when a period has not reached
`paid`. That is the payroll deadline itself, not a warning ahead of it, and on a
non-payroll morning no tier runs at all.

### Why one marker is not enough

The obvious repair — "re-drive anything still `signed` with no
`payroll_sent_at`" — is worse than the defect it fixes.

`payroll_sent_at` is stamped by `sendPayrollPdf` *after* Graph returns 202. Between
"we posted the message to Graph" and "we recorded that Graph took it" there is a
window, and the process can die inside it exactly as easily as anywhere else. A
sweep that sees only `sent_at IS NULL` cannot tell that window from "we never
asked" — so it re-sends, and payroll receives the bonus report twice.

A duplicate payroll document is a real-money, real-people error and the system
that produced it cannot take it back. It is strictly worse than a late one.

## Decision

**D1 — Two markers, three states.** A new nullable column
`bonus_pay_periods.payroll_attempt_at`, claimed immediately *before* the Graph
send. With the existing `payroll_sent_at` stamp it makes the two failure shapes
distinguishable:

| `attempt_at` | `sent_at` | Meaning | Action |
| --- | --- | --- | --- |
| NULL | NULL | Nothing was ever asked of Graph | **Re-drive automatically** |
| SET | NULL | We asked; we never learned the answer | **AMBIGUOUS — page, never resend** |
| — | SET | Graph returned 202 + message id | Delivered; nothing to do |

**D2 — The claim is a compare-and-swap, not a read-then-write.** Exactly one
caller may ever burn the marker:

```ts
const { count } = await prisma.bonusPayPeriod.updateMany({
  where: { id: monthId, payroll_attempt_at: null, payroll_sent_at: null },
  data: { payroll_attempt_at: new Date() },
});
return count === 1;
```

This is the house idiom (`correct-count.ts` `applyCorrection`, `void-count.ts`
`voidWrite`). A read-then-write passes a mocked test and still double-sends: the
real-database suite races eight callers and the read-then-write version returns
**8 winners**.

**D3 — The claim is made LATE, after every refusal gate.** Reconciliation
failure, suspected-wrong-$0, missing PDF key and unconfigured R2 all return
*above* the claim. A period blocked by a gate therefore keeps
`attempt_at IS NULL` and stays cleanly re-drivable once the gate clears, rather
than being frozen into the ambiguous state by a claim it never used.

**D4 — An ambiguous send is a person's decision.** Bill's call, 2026-08-19. The
sweep pages `urgent` with the attempt instant and an explicit instruction to
check the payroll mailbox. It never resends. Fingerprinted per period
(`payroll-ambiguous-send:<id>`) so it does not re-page in a loop.

**D5 — The sweep rides the 06:30 PT chain-health cron.** No new container, no
new schedule. That fire is the earliest point in the payroll morning and sits
forty minutes ahead of the t1 escalation tier, so a re-driven delivery has the
whole ladder still in front of it and an ambiguous one puts a person on it two
and a half hours before the 09:00 PT deadline. It also runs on non-payroll
mornings, so a delivery lost on any other day is recovered the next morning
rather than waiting for the fortnight to come round. It is wrapped in its own
`try/catch`: a broken re-drive must never suppress the signature-chain report it
rides on.

**D6 — A 30-minute grace window.** Because the claim is made late — after PDF
generation, which drives Chromium and can take tens of seconds — a delivery that
is running normally has an honest `attempt_at IS NULL`. Without a grace window
the sweep would read that as a lost promise and fire a second delivery alongside
the first. Measured from the later of the two signature instants, which is when
the chain was triggered.

## Alternatives considered

- **Await the delivery in the sign route.** Rejected: it puts Chromium and Graph
  on the request path of a floor-adjacent manager action, and a Graph timeout
  would turn a successful signature into a failed HTTP request. The signature
  and the delivery have different latency budgets and different failure
  consequences; coupling them trades a recoverable problem for an unrecoverable
  one.
- **A real job queue (BullMQ / pg-boss / a `delivery_jobs` table).** Rejected as
  disproportionate. This is one job, at most 52 fires per site per year. A queue
  adds a dependency, a worker process, its own failure modes and its own
  monitoring surface to make one function durable — and would still need exactly
  the attempt/stamp pair to avoid double-sending, because the ambiguity is in
  Graph's boundary, not in the scheduling.
- **A single `payroll_state` enum column.** Rejected: it re-states information
  the two timestamps already carry, and the timestamps are independently useful
  (the attempt instant goes into the page body verbatim, and the operator needs
  it to search the mailbox). A third representation of the same fact is a third
  thing that can disagree.
- **Re-drive on `sent_at IS NULL` alone.** Rejected — this is the duplicate-send
  defect described above. Recorded here explicitly because it is the obvious fix
  and the reason it is wrong is not obvious.
- **Backfill `payroll_attempt_at` on existing rows.** Rejected. Every `paid`
  period already has `payroll_sent_at` and is never examined; every period still
  `signed` is genuinely un-attempted as far as this system can prove. Stamping
  `now()` across the table would assert attempts that never happened and convert
  every one of them into an urgent page on the first sweep.

## Consequences

- A lost delivery is now recovered automatically within one day instead of never.
- A genuinely ambiguous delivery becomes a named, urgent, actionable page
  instead of silence — and is never resent.
- **The recovery latency is up to ~24 hours** (worst case: a delivery lost just
  after 06:30 PT waits for the next fire). This is an accepted residual, recorded
  in `docs/OPEN-ITEMS.md`. It is bounded and visible, where the previous
  behaviour was unbounded and invisible. Shortening it means a more frequent
  sweep, which is a schedule change and not a code change.
- A period blocked by a refusal gate (reconciliation, wrong-$0, R2) is re-driven
  daily and re-pages daily until the gate clears. That is intended: a signed
  period with no payroll is an open problem, and the page is fingerprinted and
  cooled.
- `claimDeliveryAttempt` is exported solely so the real-database suite can race
  the real implementation. A test that re-types the `updateMany` into its own
  body would measure its own transcription and stay green against a
  read-then-write. It must not gain a second caller.
