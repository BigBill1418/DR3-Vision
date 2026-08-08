# ADR-0084 — a count entered twice can be taken back the same day, and every reader has to agree it is gone

**Status:** Accepted, implemented (2026-08-08)
**Builds on:** ADR-0060 (floor count surface), ADR-0065 (per-surface iPad gates + the Pacific day pin), ADR-0072 (tiered anchor-overwrite guardrail + anchor recovery), ADR-0078 (idempotent floor writes, the `created_at` anchor tiebreak, the honest queue), ADR-0079 D4 (the prior-day refusal shape this borrows)
**Amends:** ADR-0072 §"Recovery, by appending" — see [Reconciling with ADR-0072](#reconciling-with-adr-0072-append-only-was-about-values-not-columns)

## Context

JT, on the floor: _"if we accidentally entered the count twice, we should be able
to remove one."_ Bill scoped it: same-day only on the iPad; a prior day is an
office job.

The count is the **anchor**. `onHand()` selects the latest `physical` snapshot
and every downstream number — the floor balance, the loads/inventory screens, the
EOD block on the daily report, the COR filing that goes to MRC — is computed
_forward_ from it (ADR-0037 D6). ADR-0072 said it in one line and it is still the
whole story: a mistyped count does not produce a wrong count, **it silently moves
the entire floor.**

ADR-0078 closed the _mechanical_ duplicate — a double-tap now claims one
idempotency key and lands one row. It did nothing for the _human_ one: the
operator who keys 2,483 when they meant 2,438, or who genuinely counts twice on a
device that had been on an old bundle. That count is now the anchor and there is
no floor-side way to take it back.

### The re-scope (G3), and why the original target was wrong

The campaign brief pointed this at **bonus entries**. It cannot be, for two
independent reasons, and both were verified against shipped code rather than
assumed:

1. **Operators cannot reach the bonus grid at all.** It is a manager/admin
   surface. The audience JT was speaking for has no path to it.
2. **A duplicate bonus entry is structurally impossible.**
   `@@unique(bonus_employee_id, entry_date)` on `bonus_daily_entries` means a
   second write for the same employee-day is an **UPDATE of the row it would
   duplicate**, not a second row. There is nothing there to void. Prior-day
   changes already route through the ADR-0028 four-eyes amendment workflow.

The only iPad path that can genuinely double-enter a number that moves money is
the **floor physical count**. So the target is `site_inventory_snapshots`.

Recorded because it is the interesting part: the feature as asked for would have
been built, would have passed its own tests, and would have shipped a void button
onto a table where duplication cannot occur — while the surface that actually has
the defect kept it.

## Decision

### D1 — Soft-void. Never a hard delete.

Two nullable columns on `site_inventory_snapshots`: `voided_at TIMESTAMP(3)` and
`voided_by TEXT` (a bare scalar FK → `users.id`, `ON DELETE SET NULL`, no Prisma
relation field — we never navigate user → voided snapshots, and deactivating a
user must never make a physical count unreadable).

`voided_at IS NOT NULL` means **excluded from anchor selection**. The row stays,
and every counted value on it — `units_total`, `units_indoor`,
`units_in_processing`, `program_units`, `non_program_units` — is untouched.

Deleting the row was never a candidate. It is the only record of a number a human
physically counted and that the system may already have reported to MRC. The
audit log is append-only (CLAUDE.md hard rule #6) and an audit row describing a
row that no longer exists is a dangling reference, not a record.

**A nullable timestamp rather than a boolean** so the row and its audit entry
cannot disagree about _when_. A boolean would need a companion timestamp anyway
and admits the state `voided = true, voided_at = NULL`, which means nothing.

A DB `CHECK` (`voided_at IS NOT NULL OR voided_by IS NULL`) refuses a half-written
void. No new index: every anchor selector already resolves through
`(site_id, snapshot_kind, snapshot_at)` and `voided_at IS NULL` is a residual
predicate over a handful of rows — the same reasoning ADR-0078 D1 recorded for
the `created_at` tiebreak.

### D2 — One filter, imported by every reader, enforced by a guard test

An exhaustive audit found **thirteen** non-test read sites on this table, across
five directories, written over eight months by passes that did not know about
each other. Miss one and the floor anchors on a withdrawn count with nothing
anywhere reporting it.

So three things, not one:

1. **`src/lib/inventory/snapshot-void.ts`** exports `NOT_VOIDED`
   (`{ voided_at: null }`), `notVoidedSnapshotWhere()` for computed clauses, and
   `isVoidedSnapshot()` for a row already in hand. Nobody writes the predicate
   inline, so grepping the import finds every participant.
2. **`snapshot-void-readers.guard.test.ts`** parses the **actual source** of every
   `siteInventorySnapshot` read call in `src/` and fails the build naming any
   whose argument does not carry the filter.
3. An explicit, reasoned **allowlist** for the deliberate exceptions, where each
   entry names a `mustContain` token proving the compensating control is still
   present in that file.

#### Why prose was insufficient, demonstrated rather than argued

ADR-0072 already documents that snapshots are append-only and every reader is
supposed to know it; thirteen readers still needed auditing by hand to find out
what they did. A sentence asking the next author to remember `voided_at: null` is
a sentence the next author never reads. A test that reads their code is.

The guard also nearly shipped as theatre, and the way it was caught is the point.
Its first version kept **comments** in the extracted argument text — and every
reader in this repo documents its filter in a comment _on the call_. With
`...NOT_VOIDED` deleted from `running-balance.ts`, the guard read the token out of
the prose explaining the token and passed **8/8**, while the behavioural suite
failed 4 tests naming the withdrawn count's total. A guard that matches its own
documentation is exactly the "reports green while measuring nothing" failure it
exists to prevent. Comments are now stripped, and two self-tests
(`comment ABOVE the call`, `comment INSIDE the call`) pin it.

Two further defences against a scan that quietly measures nothing:

- **A call-site floor.** `expect(sites.length).toBeGreaterThanOrEqual(15)` plus a
  named check that the scan actually reached `running-balance.ts`. A rename, a
  regex drift or a bad walk makes the scan return zero, and zero call sites have
  zero violations — green, measuring nothing.
- **Allowlist entries must still MATCH.** A stale entry pointing at a moved file
  fails, rather than silently exempting nothing while looking like it exempts
  something.

#### The readers, and what each one fails toward

| Reader                                             | Disposition                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `running-balance.ts` `onHand()`                    | **THE anchor.** Filtered.                                                                                                                                                                                                                                                                                                                                                                    |
| `anchor-guardrail.ts` `loadPriorAnchor()`          | Filtered. The ADR-0078 D1 "these two queries must stay byte-identical" invariant is extended to the WHERE clause and both comments updated — a guardrail that can still see a voided anchor while the balance cannot is the same defect wearing a second hat.                                                                                                                                |
| `leg-fetchers.ts` `startBalance()`                 | Filtered.                                                                                                                                                                                                                                                                                                                                                                                    |
| `cor/prefill.ts`                                   | Filtered. **Top severity: certificate-facing.** A voided count reaching a filed COR is an externally-visible wrong number sent to MRC.                                                                                                                                                                                                                                                       |
| `loads/eod-inventory.ts`                           | Filtered. Drives the daily report's "counted by X, N days ago" freshness line.                                                                                                                                                                                                                                                                                                               |
| `leg-fetchers.ts` `fetchDayFlows()`                | Filtered. Unfiltered it yields a phantom C6 `physical_reconcile` finding for a withdrawn count.                                                                                                                                                                                                                                                                                              |
| `leg-fetchers.ts` `fetchLastPhysicalSnapshotISO()` | Filtered — and it **fails OPEN**, which is why it is called out separately. M2 fires when a site has gone too long without a count. A voided count left visible reads as a recent count, so the finding is **suppressed**: the audit goes quiet at exactly the moment the floor lost its anchor. Every other reader here fails toward a visible wrong number; this one fails toward silence. |
| `bootstrap-gate.ts` (a bare `count()`)             | Filtered. Unfiltered it switches the M2 leg live for a site whose only count was voided — i.e. a site that has never successfully counted — which is precisely the bootstrap noise that gate exists to suppress. Pinned by its own test.                                                                                                                                                     |
| `workbook-promotion.ts` conflict scan              | Filtered (via `notVoidedSnapshotWhere`, since the clause is built from arguments). A voided count must **not block** a workbook promotion: the scan exists to protect hand-entered work, and a withdrawn count is not work to protect.                                                                                                                                                       |
| `admin/inventory/anchors/page.tsx`                 | **Allowlisted — shows voided rows deliberately.** See D3.                                                                                                                                                                                                                                                                                                                                    |
| `api/manager/[site]/snapshots` GET                 | **Allowlisted — a history, not a selector.** See D3.                                                                                                                                                                                                                                                                                                                                         |
| `api/admin/inventory/anchors/reactivate`           | **Allowlisted** — `findUnique` accepts only unique fields, so the filter cannot live in the query. Refused post-read with 422 `snapshot_voided`. See D6.                                                                                                                                                                                                                                     |
| `scripts/fix-woodland-inbound.sh`                  | Raw SQL on the prod host that hand-reproduces the anchor query. `AND voided_at IS NULL` added, and guarded by its own assertion in the guard test (it is outside `src/` and outside Prisma, so the scan cannot see it).                                                                                                                                                                      |

### D3 — The two surfaces that MUST still show voided counts

Hiding a voided count everywhere would reproduce exactly the problem soft-voiding
exists to avoid: a number the floor entered vanishes, and the next person asking
"why did the floor move on the 31st?" finds a history that never contained it.
That is ADR-0072's argument against deletion, and it applies to concealment too.

- **`/admin/inventory/anchors`** — the recovery surface. Voided rows are shown
  **struck through and badged**, and `Re-activate` is withdrawn on them.
- **`/api/manager/[site]/snapshots` (GET)** — a manager history list. Nothing is
  computed from it. `voided_at` / `voided_by` now ride in each row so a consumer
  can label them. Its pre-existing lack of a `snapshot_kind` filter is left
  exactly as it was; this ADR changes what the endpoint _says_ about a row, never
  which rows it returns.

One defect this surfaced and fixed: the anchors page badged `i === 0` as
**current**. With voided rows in the list, voiding the newest count would have
left that page calling a withdrawn row "current" while every server-side reader
had already moved to the one below it. The badge now follows the anchor selector.

### D4 — Prior day is refused, in the shape of an amendment, and is NOT the amendment workflow

A void of a count taken on a prior Pacific day returns **409** with an
`error: 'requires_amendment'` body naming the count's day, today, and the total —
and writes nothing.

**The shape is borrowed; the path is separate, and structurally has to be.** This
is the same call ADR-0079 D4 made for Terex daily throughput, for the same
reason: `resolveAmendmentApprover` sources its approver from
`bonus_signature_chains` and throws `AmendmentWorkflowForbiddenError` for any
requester who is not a bonus payroll signer. **A floor operator is never one.**
Routing a floor operator's mistyped count into that workflow would hand the exact
audience this feature exists for a 403 they could do nothing about — and would
file an inventory correction as a payroll amendment, a category error in an audit
trail meant to explain itself years later.

So it refuses, visibly, naming the office as the route. The shape is reused so a
client that already renders "this needs the office" renders this too, and so an
eventual generalisation is a swap rather than a rewrite. The prohibition is
written into the error class's own doc comment, at the point a future author
would be tempted to wire it up.

### D5 — Pacific, from the canonical helper — and the rollover trap

"Today" is the **Pacific** calendar day, resolved through
`currentPacificDayWindow()` (ADR-0065) — the same helper the floor queue, the
inbound day pin and invoice generation key on. Never the device clock (the iPad's
is exactly what the whole ADR-0065/ADR-0078 D10 day-discipline chain refuses to
trust) and never server-local (the container runs UTC, so a server-local "today"
flips at 5 PM Pacific and would start refusing an evening-shift operator's real
day while accepting tomorrow's).

Pinned by a test at the fixed instant **`2026-07-29T01:00:00Z`** — 18:00 Pacific
on the 28th, so UTC has rolled and Pacific has not. A void of the Pacific-28th
count at that instant must succeed, and the assertion is written to fail with a
message naming the day the server actually believed it was.

### D6 — Online only. Deliberately absent from the offline-queue allowlist.

`FLOOR_SCOPES` (`src/lib/operator/floor-writes.ts`) is the **server-side**
allowlist of writes `/api/queue/replay` may dispatch. `operator.count.void` is
not in it, so a queued entry naming it is answered 400 `unknown_scope`. The
refusal is structural, not a client-side convention — a hand-edited IndexedDB row
cannot reach the service either. The iPad client for this action has no
`enqueueAction` path and no `isOfflineError` branch.

The reason is contention, not caution. Every other floor write **adds a fact**:
replayed late, an inbound confirm or a stack count is still the same fact and
converges. A void **removes the anchor the whole floor is computed from**, and it
is addressed to one specific row _by id_. Between the tap and the replay the
office can amend, a manager can release a held count, `reconcilePhysicalCount`
can write a newer anchor, or the day can roll — and the day pin would then refuse
the entry anyway, since a void is same-day only and a queued void is almost by
definition a stale one. Queuing it would mean an iPad silently retracting an
anchor hours after the floor moved on: a larger version of the defect this ADR
closes.

Nothing an operator typed is ever at risk. The count is already saved; only the
_withdrawal_ waits for a connection, and the office path covers everything else.

### D7 — Authorization, idempotency, audit

- **Site-scoped** (hard rule #2). A snapshot id belonging to another site is a
  **404, not a 403** — the caller learns nothing, so this cannot be used to probe
  ids.
- **Yours only.** An operator may withdraw a count _they_ entered. Ownership is
  resolved from the append-only `audit_log` insert row that
  `reconcilePhysicalCount` writes in the same transaction — the same provenance
  path `eod-inventory.resolveCounter` uses. Snapshots carry no counter column and
  none was added: a denormalised copy is a second truth that can disagree with
  the record.
- **Gated** on `requireActivatedOperator(site, UI_SURFACE.IPAD_COUNT)` — the same
  per-surface ADR-0065 flag as the count itself. A site whose count screen is
  dark must not have a live withdrawal endpoint behind it.
- **Audited in the SAME transaction as the write** (hard rule #6):
  `action: 'update'`, `table_name: 'site_inventory_snapshots'`, `before`/`after`
  carrying the void columns, `actor_user_id` = the operator.
- **Idempotent, two ways.** `withIdempotency` (ADR-0078) covers the same
  submission arriving twice: claim and write share one transaction, and the
  replay returns the stored response. A _different_ key naming an
  already-voided row short-circuits to a **no-op success** — the operator asked
  for the count to be gone and it is gone; a 409 would only teach them to worry
  about a state that is already correct. Neither path writes a second audit row:
  an append-only log that grows an entry per redundant tap stops being a record
  of what happened. The concurrent race is settled by a `NOT_VOIDED`-guarded
  `updateMany`, so exactly one of two simultaneous callers does the writing.

## Reconciling with ADR-0072: "append-only" was about VALUES, not columns

ADR-0072 §"Recovery, by appending" states that `site_inventory_snapshots` is
append-only, and builds its recovery path on that: `/admin/inventory/anchors`
corrects a bad anchor by writing a **new** snapshot carrying a prior one's
figures, never by editing or deleting the bad row. _"Deleting the mistake would
leave a history that never contained it."_

**This ADR AMENDS that invariant; it does not supersede it, and the sentence
quoted above remains literally true after this change.**

The amendment is a narrowing of what "append-only" was protecting:

- **Before:** no column on this table is written after insert.
- **After:** no **counted value** is ever erased or rewritten, and a count's
  history stays complete and readable forever.

A soft-void satisfies the second reading exactly. No row is deleted. No counted
figure is altered — `units_total`, `units_indoor`, `units_in_processing` and both
pool columns are byte-identical before and after. What changes is a pair of
columns that record a **new, separate fact**: that a human withdrew this count,
when, and who. That fact is itself appended to the audit log in the same
transaction, and the recovery surface still shows the row. The history a future
reader gets is _richer_ than the append-only-by-new-row path produces, not
poorer: it says "this count was entered and then withdrawn by JT at 14:07",
rather than "here are three counts, work out which one was a mistake."

The alternative — voiding by appending a `void` marker row to the same table —
was considered and rejected in [Alternatives](#alternatives-considered). It would
have preserved the letter of ADR-0072 and made every anchor selector strictly
worse.

### When to void, and when to re-activate

Two correction mechanisms with no stated boundary is how the next person picks
the wrong one. The boundary is **what the count IS**, not how recent it is:

|               | **Void** (ADR-0084)                                                            | **Re-activate** (ADR-0072 §3)                                        |
| ------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| The count is… | **fiction** — it should never have existed (double-entered, wrong digit keyed) | **real** — it happened, and someone now wants an earlier anchor back |
| Who           | the operator who entered it                                                    | admin only                                                           |
| When          | the same Pacific day                                                           | any time                                                             |
| Where         | the iPad                                                                       | `/admin/inventory/anchors`                                           |
| Effect        | the row stops being eligible; the anchor falls back to the previous live count | a **new** snapshot is written carrying a prior row's figures         |
| History reads | count → withdrawn                                                              | good anchor → bad anchor → correction                                |

Rule of thumb, stated so it can be quoted: **void un-says a count; re-activate
out-votes one.** If the number was never a real observation, void it. If it was a
real observation whose consequence you want to undo, re-activate — the bad count
stays live in the chain, because it happened.

They overlap in exactly one cell: an admin, on the same day, could do either.
That overlap is narrow and acceptable — the void produces a cleaner two-row
story, re-activation a three-row one, and both are honest. **Re-activate is not
narrowed for prior days or non-operator actors, and must not be**: it is the only
correction path that exists at all once the day has rolled.

One narrowing this ADR _does_ make: **re-activation now refuses to restore FROM a
voided row** (422 `snapshot_voided`). Re-activation works by copying a row's
figures forward into a new _live_ anchor, so allowing a voided source would
launder a withdrawn number back into the chain with an audit trail that reads
like a legitimate recovery.

## Alternatives considered

**Hard delete.** Rejected outright — see D1. It destroys the only record of a
physically counted number that may already have been reported to MRC, and leaves
the append-only audit row pointing at nothing.

**A `void` marker ROW appended to the same table** (preserving ADR-0072's letter
exactly). Rejected. Every anchor selector would have to become "latest physical
count that has no later void row naming it" — a correlated subquery or an
anti-join in ten places, including two whose orderings ADR-0078 D1 requires to be
byte-identical. It converts a residual `IS NULL` predicate into a join in the
hottest inventory query in the app, and it makes the _omission_ failure mode
worse, not better: a reader that forgets the anti-join looks completely normal,
whereas a missing `NOT_VOIDED` is one greppable token. The invariant ADR-0072 was
protecting is preserved by the soft-void (see above); the _implementation_ it
happened to use is not sacred.

**A separate `voided_snapshots` table.** Same anti-join cost, plus a second place
for the state to disagree with the row.

**Reusing the bonus amendment workflow for prior days.** Structurally impossible
for this audience — D4. Same conclusion ADR-0079 D4 reached independently.

**Making the void offline-queueable.** Rejected — D6.

**Letting managers void from the desktop too.** Deliberately out of scope. The
office already has `/admin/inventory/anchors`, and adding a second desktop
correction path before anyone has asked for one is inventing a mechanism to
maintain. Recorded here rather than silently omitted.

**Voiding prior-day counts from the iPad.** Bill's explicit scope call. The
refusal is D4.

## Premises that died on checking

Shipped code wins; each of these was in the brief and is not true of the repo.

1. **"The consumer `LoadsInventoryClient.tsx` can show the voided state."** It
   cannot — it never calls the snapshot list at all. `GET /api/manager/[site]/snapshots`
   has **no client consumer in the app**; the client only POSTs. The void columns
   are surfaced in the response anyway (additive, for the next consumer), but
   nothing renders them today. Recorded so nobody looks for a struck-through row
   on that screen and files a bug.

2. **"The `created_at DESC` divergence is in three anchor selectors."** Confirmed
   and **deliberately not fixed here** — see below.

3. **The brief's reader list omitted `workbook-promotion.ts:892`** from the
   thirteen and had the line numbers drifted throughout. The audit was re-run
   against current source; the guard test's floor (15 call sites: 10 filtered, 5
   allowlisted) is measured, not inherited.

## What this ADR does NOT fix, and why

**The ADR-0078 D1 tiebreak divergence.** `onHand()` and `loadPriorAnchor()` order
by `snapshot_at DESC, created_at DESC`. Three other anchor selectors —
`leg-fetchers.startBalance()`, `cor/prefill.ts`, `loads/eod-inventory.ts` — order
by `snapshot_at DESC` alone. Counts are stored at Pacific midnight of their day
(ADR-0060 D-3), so two same-day counts tie exactly and the planner picks. Those
three can therefore name a _different_ anchor than the balance they are supposed
to describe — including the COR filing.

Voiding makes this more visible, not less: withdrawing one of two same-day counts
is now a routine act, and the moment before the void the three selectors may
already disagree with `onHand`.

**Left alone anyway, deliberately.** It is a pre-existing correctness defect in
three money paths, and fixing it means changing which anchor a filed COR and a
sent daily report select — a behavioural change to reported numbers that deserves
its own evidence, its own falsification, and its own ADR, not a rider on a void
feature. Bundling it here would mean this ADR's verification could not tell which
change moved a number. Recorded in the code at all three sites with a pointer
here, and belongs in `docs/OPEN-ITEMS.md` as a follow-up.

**`scripts/fix-woodland-inbound.sh` also lacks a `snapshot_kind='physical'`
filter and the `created_at` tiebreak.** Same reasoning, plus: it is a one-shot
remediation tool, not a live path. The void filter was added because _this_ ADR
made it wrong; widening it further is a separate change. Noted in the script.

## Consequences

- An operator who double-enters a count can take it back themselves, on the day,
  in two taps behind a confirm — and the floor immediately recomputes from the
  previous live anchor.
- Nothing is ever deleted. The office can still see every count that was taken,
  including the withdrawn ones, labelled as withdrawn.
- A new `siteInventorySnapshot` reader that omits the filter **cannot be merged** —
  the guard test names the file and line.
- **Cost, stated plainly:** an operator can now remove an anchor without a
  manager, where ADR-0072 required manager approval to _replace_ one with a large
  swing. The asymmetry is intentional — a void can only ever return the floor to a
  number that was already the anchor, so its blast radius is bounded by the
  history, whereas a mistyped replacement is unbounded. But a determined operator
  could void today's good count to expose yesterday's. Every void is audited with
  the actor, and same-day-only bounds the window.
- The office carries prior-day corrections. A count discovered wrong the next
  morning is a phone call, not a tap.

## Verification

Typecheck clean, ESLint clean (`--max-warnings 0`), Prettier clean on every
authored file. `src/lib/inventory` + `src/lib/audit` + `src/lib/cor` +
`src/lib/loads` + `src/lib/dashboard`: **557 passed, 6 skipped (59 files)**.

Every guard **falsified before being kept** — broken on purpose, observed red,
restored:

| Break                                                | Went red                                                                                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `...NOT_VOIDED` deleted from `onHand()`              | ✅ 4 (`expected 2483 to strictly equal 2000`; `onHand anchored on 2483 …the floor is computed from a withdrawn count`)                          |
| the same break, against the reader guard             | ✅ 1 — `src/lib/inventory/running-balance.ts:255 siteInventorySnapshot.findFirst() — where-clause has no NOT_VOIDED`                            |
| guard reads comments as code (its own first version) | ✅ caught by the empirical both-ways run: guard 8/8 green while the behavioural suite failed 4 — fixed, and pinned by `comment INSIDE the call` |

Numeric assertions use real `Prisma.Decimal`. The fake Prisma in
`void-count.test.ts` is a **generic where/orderBy evaluator** with no knowledge of
`voided_at` — the filter is matched by the same `=== null` branch that would match
`import_id: null` — which is what makes the difference between the filtered and
unfiltered clauses attributable to the where-clause rather than to the fixture.
`strips the filter and the voided count comes back` runs both clauses through that
one evaluator and asserts the unfiltered one returns the withdrawn 2,483.

**No Postgres was reachable from the build host** (nothing on `:5432`;
`DR3_TEST_DATABASE_URL` unset, so `anchor-tiebreaker.db.test.ts` skips). Two
claims are about the database rather than the code and cannot be checked by any
fake — the planner honouring the filter in the real anchor `SELECT`, and two
concurrent voids producing exactly one audit row. Both are covered by
`snapshot-void.db.test.ts`, which runs in CI's `migrations` job against an
ephemeral Postgres 16 with the full migration chain applied. It has not been
executed locally; that is the honest status.

### The falsifications

| #   | Claim                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | A same-day void is audited (exactly one row, actor = the operator, before/after carry the void columns) **and** the floor recomputes to the prior anchor's **exact** value (2,483 → 2,000). Both selectors move together.                                                                                                                                            |
| F2  | A prior-day void is refused 409 with the full `requires_amendment` body, and writes nothing — no stamp, no audit row, no amendment request.                                                                                                                                                                                                                          |
| F3  | At `2026-07-29T01:00:00Z` (18:00 PT on the 28th) a void of the Pacific-28th count **succeeds**; the failure message names the day the server believed it was.                                                                                                                                                                                                        |
| F4  | The missed-reader falsification, run both ways through one evaluator, plus the empirical strip-and-restore quoted above.                                                                                                                                                                                                                                             |
| F5  | A double-tap is idempotent: same response, not re-stamped with the later clock, exactly one audit row. A _different_ key on an already-voided row is a no-op success.                                                                                                                                                                                                |
| F6  | The bootstrap gate does not count a voided anchor as evidence — a site whose only count was voided is **not** snapshot-live.                                                                                                                                                                                                                                         |
| +   | Authorization: another operator's count is 403; another site's snapshot is **404**; the voidable list offers only this operator's live counts and drops one once voided.                                                                                                                                                                                             |
| +   | Guard self-tests: unfiltered snippet flagged, filtered one not; comments above **and inside** the call are not code; a `)` inside a string does not truncate the argument; a call split across lines still matches; every allowlist entry still matches a real call site and still carries its compensating control; the prod remediation SQL filters voided counts. |

### Not verified

- **Nothing was run against production or the live database.** No migration was
  applied by this work.
- The iPad surface has no rendering test. It follows the existing count-client
  conventions (`onClick` not `<form>`, `useT` for all three locales, DR3 tokens,
  no browser storage) and the affordance only appears when the server has said
  there is something to withdraw, but the visual result is unverified.
- The Urdu and Spanish strings are machine-authored and have not been reviewed by
  a speaker. The parity test passes; the _quality_ is unchecked.

---

## Amendment 1 (2026-08-08) — the void is SITE-scoped, not OWNER-scoped

**Status:** Accepted, implemented. Amends **D7 §"Yours only"** and the voidable
list. Everything else in ADR-0084 stands unchanged.

### Context

D7 required the caller to be the operator named on the count's original insert
audit row, refusing anyone else with 403 `not_your_count`. That was the shape
this ADR shipped with, and it was recorded as an open question the same day
(OPEN-ITEMS §"ADR-0084 void is OWNER-scoped on a SHARED iPad") rather than
decided unilaterally.

Floor iPads are shared kiosks with per-operator PIN sign-in. A duplicate keyed
at 14:00 by the day operator could not be withdrawn by whoever PIN'd in at
15:00 — and because a void is **same-day only** (D4), there was no next-day path
either. The mistyped anchor stood overnight and became an office job the
following morning, which is precisely the outcome the feature exists to prevent.

This is the same shape ADR-0078 Amendment 1 loosened one week earlier for the
photo gate ("we need to drain all users regardless of who is signed in"). It was
**deliberately not** carried over automatically: a photo upload is _additive_, a
void is _destructive_ — it withdraws the anchor the entire floor is computed
from — so the risk profile that justified Am.1 there does not transfer here on
its own.

Bill was given three options — keep owner-only, widen to site, widen to site with
a manager confirm — and picked: **"Widen to site."**

### Decision

**Any activated operator at the count's own site may withdraw a same-day count.**
The ownership gate is removed; the site gate is the only authorization check that
remains in `voidSnapshot`.

**The trade, stated plainly rather than described as a refactor: the gate
loosened from owner to site; attribution went from one id to two.**

- **Given up:** an operator can now withdraw any live same-day count at their own
  site, not only one they entered. On a warehouse floor that is frequently the
  legitimate case (the person still on shift correcting what the last shift
  mistyped) — but it is a real loosening of an authorization control and is
  recorded as one.
- **Gained:** the mistake is correctable on the shift that made it, by whoever is
  actually standing at the iPad. No overnight-wrong-anchor, no office ticket.
- **Also gained:** the void audit row now carries **both** ids —
  `actor_user_id` is who withdrew it, `after.entered_by` is who entered it, plus
  an explicit `after.cross_operator` boolean. Before this, a void recorded the
  withdrawer alone, because the gate guaranteed the two were the same person.
  Accountability is strictly better after the change than before it.

Both ids are written on **every** void, including a self-void. An id present only
on the cross-operator case would be ambiguous between "the same person" and "an
older build that did not record it", and this history is read years later by
someone who has neither the code nor the deploy dates.

`entered_by` is **NULL** when no insert audit row exists (a system-written
snapshot). NULL means "we do not know", which is true; it is never backfilled
from `voided_by` or anything else — the same reasoning ADR-0078 Am.1 applied to
`load_photos.uploaded_by`, and ADR-0077 to "not recorded" over a fake `0.0`.

### Paired with telling the operator whose count it is

The widened gate ships **with** the disclosure, not before it. The iPad list
labels every count entered by somebody else with that person's name, and the
confirm step for one of those counts says so explicitly and states that the
withdrawal will be recorded under the signed-in operator's name. That sentence is
the trade for the widened gate; removing it means re-narrowing the gate.

Names are resolved on the page, not in `voidSnapshot` — the service stays a pure
inventory concern with no `users` dependency. Own rows are left unlabelled
("entered by you" on every one of your own counts is noise), and an enterer that
cannot be resolved is left unstated rather than filled in with a placeholder.

### Unchanged, and NOT to be "restored"

- **Cross-SITE is still refused, still as a 404** (hard rule #2 — Eugene and
  Woodland are separate MRC contracts in separate jurisdictions; a 403 would
  confirm the id exists). Pinned by a falsification in which the actor **is** the
  original enterer and is still refused, so the remaining refusal is demonstrably
  the site comparison and not a leftover of the ownership one.
- Same-day only, in Pacific, from `currentPacificDayWindow` (D4/D5).
- The confirm step, the soft void (D1), the online-only rule (D6), every reader
  filter and its guard test (D2), the recovery surfaces (D3), and the
  idempotency/audit contract (D7).

### Renamed with the behaviour

`SnapshotNotYoursError` and its `not_your_count` reason were **deleted**, not
left dead — a disused error class reads as a check somebody forgot to call and
invites its restoration. The `not_your_count` branch in the client and the
`floor.count.void_err_not_yours` string in all three locales went with it.
`listTodaysVoidableCounts` → **`listTodaysVoidableCountsAtSite`**, on the same
ADR-0078 Am.1 precedent: left under the old name, the next reader would
reasonably conclude the missing ownership filter was an oversight and put it
back.

Copy in all three locales was re-voiced from second person to neutral
("Counts **you entered** today" → "Counts entered today"; "before **you**
entered it" → "before that count was entered"), because the old wording is
actively false on a colleague's row.

### Falsifications run

| Falsification                                      | Result                                                                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drop the site check from `voidSnapshot`            | **RED**, naming the site: _"a session at site `site-eugene` was allowed to void snapshot `snap-wood`, which belongs to site `site-woodland`"_      |
| Restore the pre-amendment owner gate               | **RED** — the cross-operator void case fails with `not_your_count`, i.e. the new tests really measure the loosening rather than passing either way |
| Remove `entered_by` from the audit `after` payload | **RED** on the self-void case — proves the both-ids claim is asserted, not merely commented                                                        |
| Cross-operator **prior-day** void                  | Still 409 `requires_amendment`, nothing written — the amendment widened WHO, never WHEN                                                            |

### Residuals

- The iPad surface still has no rendering test (ADR-0084 §"Not verified" stands),
  so the new "Entered by …" row label and cross-operator confirm panel are
  unverified visually.
- The new `void_entered_by` / `void_confirm_other` strings in `es` and `ur` are
  machine-authored. Parity passes; quality is unreviewed — the same open residual
  as the original ADR-0084 strings.
