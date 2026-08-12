# Promise register

**What this is.** Every forward-looking commitment an ADR makes, with a status and
a handle. ADR-0094 §3 RC-4 counted roughly 42 such commitments across the 13 floor
ADRs and found that **not one carried an issue number**. This file is the handle
they lacked.

**Why it exists.** A promise whose only home is prose in a Consequences block fails
silently, and silence is indistinguishable from health:

- the **health pill**, promised in ADR-0019.1 §4 and then cited as a *live control*
  by two later ADRs, sat unbuilt for **four months** with no visible symptom;
- the **08:30 auto-override** safety net sat dead at both sites for a month;
- **six manager screens** defaulted their date inputs to tomorrow, were fixed on
  2026-07-30, and the record of that fix (`ADR-0065 Amendment 2`) was cited by seven
  files for **twelve days before it existed** — see P-06 below, the worked example
  of exactly the failure this register prevents.

**How it is maintained.** Two checks, described in ADR-0097:

| Check | Mode | What it does |
| --- | --- | --- |
| `node scripts/check-adr-citations.mjs` | **hard fail** | every `ADR-NNNN` / `Amendment N` in `src/`, `scripts/`, `e2e/`, `tests/` must resolve to a real file and section |
| `node scripts/extract-adr-promises.mjs --check` | **warn only** | an ADR newer than the registry epoch that states a promise but has no row here gets a CI annotation |

**Status vocabulary.** `OPEN` — live commitment, nobody is on it. `WATCH` — believed
closed by later work, needs one confirmation to retire. `DONE` — closed, with the
evidence in Notes. `BASELINED` — pre-existing citation drift, tracked in
`KNOWN_UNRESOLVED` in the citation checker; the list may only shrink. `ACCEPTED` — a
stated limit nobody intends to fix, kept so it is not rediscovered as a bug.

**Coverage, stated honestly.** Seeded 2026-08-11 with **33 rows**, hand-audited from
the floor ADR set that ADR-0094 measured plus the four phantom-amendment families
found while building the checker. It is **not** a complete index of all 104 ADRs —
the extractor finds 70 candidates across 40 ADRs, and the rest are unaudited. Rows
are added as ADRs are written or touched, not by a big-bang backfill that nobody
would review.

---

## The register

| ID | ADR | Promise | Status | Notes |
| --- | --- | --- | --- | --- |
| P-01 | ADR-0068 | `Amendment 3` is cited by 8 files and was never written | BASELINED | AP queue + reimbursements. Work shipped; record did not. Same class as P-06 |
| P-02 | ADR-0068 | `Amendment 4` is cited by 2 files and was never written | BASELINED | admin reimbursements page |
| P-03 | ADR-0068 | `Amendment 5` is cited by 4 files and was never written | BASELINED | reimbursement notify + public paths |
| P-04 | ADR-0069 | `Amendment 3` is cited by 2 files and was never written | BASELINED | `commodity-extract` |
| P-05 | ADR-0019.5 | `Amendment 1` is cited by 2 files and was never written | BASELINED | doc-ingest anomaly tests |
| P-06 | ADR-0065 | Am.1 residual: six MANAGER surfaces still derive the day key from the UTC day, "tracked for a manager-side pass rather than fixed here" | **DONE** | Shipped `7e1cf342`, 2026-07-30 08:45 PT. **The record was written 12 days late** (ADR-0065 Am.2, 2026-08-11) after ADR-0094 found seven files citing it. The worked example for this whole register |
| P-07 | ADR-0019.3 | Rename the `patrick_or_other_non_chain_manager` error string | OPEN | Explicitly deferred in-ADR |
| P-08 | ADR-0019.3 | ADR-0019.1 §4 "override actor" — "still open, deliberately not built here" | OPEN | Adjacent to the health-pill class; ADR-0019.4 made the safety net visible but this item is separate |
| P-09 | ADR-0019.4 | The `[escalation] stranded ntfy dropped` failure itself — "not addressed here" | OPEN | ADR-0019.5 fixed the em-dash header cause; confirm whether this specific failure is now closed |
| P-10 | ADR-0074 | `startInboundLoad` "explicitly out of scope here" | WATCH | ADR-0096 added the server-side day guard inside `startInboundLoad`. Confirm the original scope note is fully discharged |
| P-11 | ADR-0078 | Photo-grant work "deliberately not in this change" — needs a new `PHOTO_GRANT_SECRET` | WATCH | ADR-0086 (capture-time photo upload grants) appears to close this. One confirmation to retire |
| P-12 | ADR-0084 | An identified defect "deliberately not fixed here" | OPEN | See ADR-0084 §Consequences for the specific item |
| P-13 | ADR-0086 | "still open on the one path that hands work to the queue" | OPEN | |
| P-14 | ADR-0090 | Item (3) "deferred rather than half-built" — a schema change plus two surfaces | OPEN | Sized in-ADR; the reason for deferral is recorded and still holds |
| P-15 | ADR-0090 | "the gap it describes remains open" | OPEN | |
| P-16 | ADR-0091 | "A stale-claim watchdog is the obvious follow-on and is **not** in this change" | **DONE** | Shipped as ADR-0092; ramped PILOT→LIVE both sites 2026-08-11 12:50 PT |
| P-17 | ADR-0091 | `expected_unit_count` is 0 on three of four live slots, and H-136147 was claimed at 07:55 against a 15:00 appointment — "noted for follow-up, neither is touched here" | OPEN | ADR-0094 §4 row 8 measures the first at **14 live slots**. Feeds P2 |
| P-18 | ADR-0092 | "If the badge turns out not to be read, a second midday fire is the obvious next iteration" | WATCH | Conditional on an observation nobody is currently making |
| P-19 | ADR-0092 | The clean fix for the 15:00-quiet case is an end-of-shift sweep, "which needs a shift model the system does not have" | OPEN | Blocked on a domain model that does not exist |
| P-20 | ADR-0092 | "The thresholds rest on 58 loads … They should be re-derived once there are a few hundred" | OPEN | Same re-derivation trigger as P-31 — do both in one pass |
| P-21 | ADR-0092 | The late-photo miss (D1) is "real and unbounded" | ACCEPTED | Deliberate; the badge still shows it |
| P-22 | ADR-0092 | "Nothing here prevents a claim being abandoned. This is a reader, not a cure" | ACCEPTED | Restated by ADR-0094 §6 |
| P-23 | ADR-0094 | **P0** — instrument the dead end: structured event on every actionless render, 06:30 PT digest (1 day) | OPEN | Ranked #1 by leverage. Converts Bill's phone into a metric; works on branches not yet found |
| P-24 | ADR-0094 | **P1** — the Dead-End Rule enforced by a chokepoint test (2–3 days) | OPEN | Generalises the ADR-0091 `describeConsumedSlot` pattern to the other card families |
| P-25 | ADR-0094 | **P2** — name the divergence states, give each a route (3–4 days) | PARTIAL | ADR-0096 shipped the late-arrival case (§4 row 1) without widening the D5 bound. Rows 3, 8, 10, 11, 13 remain |
| P-26 | ADR-0094 | **P3** — floor-shaped smoke check at 06:00 PT and post-deploy (2 days) | OPEN | Closes the one-night gap between a merge and the floor finding what it broke |
| P-27 | ADR-0094 | **P4** — no floor-surface behaviour changes merge after 15:00 PT except incident fixes | OPEN | Process only, zero engineering cost. Needs Bill's ratification to be real |
| P-28 | ADR-0094 | **P5** — promise + citation CI | **DONE** | This register plus ADR-0097. One deliberate deviation from the P5 text, recorded in ADR-0097 §3 |
| P-29 | ADR-0094 | **P6** — one half-day with JT and Pablo on the §4 messy cases (0.5 day) | OPEN | Highest value per hour; most likely to change the plan itself |
| P-30 | ADR-0094 | Six status allow-lists remain duplicated (ADR-0090 Q3, OPEN-ITEMS AW-4) | OPEN | The RC-2 parity class. `ops-overview.ts` still carries a byte-for-byte copy of `OPEN_DOCK_STATUSES` under a local name |
| P-31 | ADR-0094 | The §4 per-class divergence rates "should be re-derived at a few hundred loads before anyone plans against it" | OPEN | Sample is 64 claims over 10 operating days. Pair with P-20 |
| P-32 | ADR-0094 | `assertCurrentPacificDay` absent from `src/lib/load-service.ts`; the day guard is UI-layer only | **DONE** | Closed by ADR-0096 the same evening — enforced inside `startInboundLoad` |
| P-33 | ADR-0094 | The 29 orphaned slots do not distinguish "truck never came" from "floor couldn't check it in" — "a candidate for P2" | OPEN | The gap is itself the finding; closing it needs a recorded outcome per slot |

---

## Retiring a row

Change the status, add the evidence to Notes, and — for a `BASELINED` row — delete
the matching entry from `KNOWN_UNRESOLVED` in `scripts/check-adr-citations.mjs` in
the same PR. The checker **fails** on a baseline entry that no longer corresponds to
a real violation, so the list cannot quietly ossify.

Do not delete rows. A closed promise with its evidence is the only durable answer to
"was this ever actually done?" — which is the question nobody could answer about the
health pill for four months.
