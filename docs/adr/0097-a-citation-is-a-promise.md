# ADR-0097 — A citation is a promise that a reason is written down

**Date:** 2026-08-11 (Pacific)
**Status:** Accepted, implemented.
**Implements:** ADR-0094 §5 **P5** ("Make promises executable").
**Related:** ADR-0064 (an ADR referenced by the code it governs, never committed),
ADR-0065 Am.2 (written twelve days late, and the reason this exists),
ADR-0035 (the advisory-vs-hard gate precedent in `ci.yml`), ADR-0037 (grading a
signal before it pages anyone).

---

## 1. Context

ADR-0094 measured why the floor keeps calling and found, as its fourth root cause,
that **forward promises live in prose, and prose does not execute**: roughly 42
distinct commitments across the 13 floor ADRs, **not one carrying an issue number**.

That is not a tidiness complaint. Three consequences shipped in the same week the
ADR was written:

- the **health pill**, promised in ADR-0019.1 §4 and then cited as a *live control*
  by two later ADRs, did not exist — and *"both sites sat in exactly that state from
  the 2026-07-07 incident until 2026-08-11 with no visible symptom."* Four months.
- the **08:30 auto-override** safety net was dead at both sites for a month.
- **escalation pages were silently dropped for a week** while the counters reported
  the attempts as successes.

Each has the same shape: a safety net that is *an event on a channel* rather than
*standing, readable state*. Nobody notices a page that did not arrive.

### What building the checker found

ADR-0094 named one instance nobody had noticed: source files and a test cite
**"ADR-0065 Amendment 2," and no such amendment existed**. (Its prose says "six
source files and one test"; the file list it prints is **five** sources plus the
test — six citations. Counted here from the resolver, not restated.) Running it
across the whole tree found it was **not alone**. Four families, **24 citations**:

| Cited | Reality | Citations |
| --- | --- | --- |
| ADR-0065 Amendment 2 | ADR-0065 had only Amendment 1 | 5 + 1 test |
| ADR-0068 Amendment 3 / 4 / 5 | ADR-0068 has only Amendment 1, 2 | 14 |
| ADR-0069 Amendment 3 | ADR-0069 has Amendment 1, 2 | 2 |
| ADR-0019.5 Amendment 1 | ADR-0019.5 has no amendments | 2 |

In every case the *work* shipped and the *record* did not. ADR-0065 Amendment 2 —
written as part of this change, twelve days late — documents its own instance in
full: six manager screens defaulted every date input to **tomorrow** after 5 PM
Pacific, the fix landed 2026-07-30 08:45 PT as `7e1cf342`, and the citation dangled
from that morning until now.

**A citation is a promise that a reason is written down somewhere.** When it does not
resolve, the next author cannot tell whether the constraint is real, superseded, or
imagined — so they either cargo-cult it or ignore it, and both are wrong.

---

## 2. Decision

### D1 — The citation resolver is a HARD gate

`scripts/check-adr-citations.mjs`. Every `ADR-NNNN` and `ADR-NNNN Amendment K` /
`Am.K` reference in `src/`, `scripts/`, `e2e/`, `tests/` must resolve to a real file
in `docs/adr/` and — when an amendment is named — to a real `Amendment K` section.
Non-zero exit; also asserted by `src/__tests__/adr-record-integrity.test.ts`, so it
fires in the normal suite and needs no new CI job.

Two things the resolver must get right, both learned the hard way:

**It indexes BOTH amendment conventions.** This repo records amendments either as an
in-file `## Amendment N` heading (ADR-0046, 0065, 0067, 0068) **or** as a separate
file, `0069-amendment-2-terex-maintenance-absorption.md`, whose H1 reads
`# ADR-0069 Amendment 2 — …` (ADR-0067 Am.8, ADR-0069 Am.1/2). The first draft keyed
one file per ADR number, so the separate amendment files overwrote their parent and
**46 false violations** were reported against ADR-0067 and ADR-0069. That bug is
locked out by a named regression test.

This matters more than it looks: **a gate that cries wolf gets switched off**, and a
switched-off gate is worth less than no gate, because it also carries the belief that
something is being checked. For this check the false-positive cost is strictly higher
than the miss cost, and the design is tuned accordingly.

**Cross-repo citations are an explicit allowlist.** DR3 legitimately cites
noc-master's ADR-0200 (the fleet ntfy header contract it implements). `FLEET_ADRS`
names it with its path. A numeric range would have been less typing and would
silently accept a typo — the exact failure being prevented.

### D2 — Pre-existing drift is BASELINED, and the baseline ratchets

The 18 citations behind ADR-0068/0069/0019.5 are listed in `KNOWN_UNRESOLVED` with a
date and a note, so the gate could be switched on as a **hard failure the day it was
written** rather than waiting on five acts of archaeology.

Writing those five amendments would mean **inventing history for work this author did
not do and cannot verify**, which is worse than an honest gap. They are tracked in
`docs/adr/PROMISES.md` (P-01 … P-05) and a test asserts every baselined ADR has a row
there — a tolerated violation with no handle is the precise failure this work exists
to stop.

The baseline **may only shrink**: an entry that no longer corresponds to a real
violation **fails** the check with "stale baseline entry — delete it." Without that
ratchet the list becomes a second `OPEN-ITEMS.md`, which at 2,024 lines has become
*"a place promises go, not a place they come back from."*

### D3 — The promise register is a file, not an issue tracker

`docs/adr/PROMISES.md`, seeded with **33 hand-audited rows**: the floor-ADR
commitments ADR-0094 counted, ADR-0094's own P0–P6, the five phantom amendments, and
ADR-0065 Am.1's residual as the worked closed example.

Statuses are `OPEN` / `WATCH` / `DONE` / `BASELINED` / `ACCEPTED`. `ACCEPTED` exists
so a deliberate limit — *"nothing here prevents a claim being abandoned … this is a
reader, not a cure"* — is recorded as a decision rather than rediscovered later as a
bug.

### D4 — The registry check WARNS; it never fails a build

`node scripts/extract-adr-promises.mjs --check` emits a GitHub `::warning::`
annotation for any ADR **newer than the registry epoch (0097)** that states a
promise but has no row. Older ADRs are grandfathered: they are added as they are
touched, not by a big-bang backfill nobody would review.

---

## 3. Where this deviates from P5 as written, and why

ADR-0094's P5 specified two checks. The first shipped as written. The second did not,
and the difference is deliberate.

**P5 said:** *"a `Consequences`/residual block containing a promise marker … must
carry a GitHub issue link. Prose-only promises fail review."*

**Two changes:**

1. **A registry row, not a GitHub issue link.** ADR-0094's own evidence argues
   against issues: 42 promises, **zero** issue numbers. That is not 42 oversights —
   it is a team that does not work through issues. A rule requiring a link to a
   system nobody uses gets satisfied with a dead link, which is *worse* than prose
   because it looks tracked. A table beside the ADRs is versioned with them, reviewed
   in the same PR, and readable without leaving the repo.
2. **Warn, not fail.** Making prose-only promises fail the build would have redded
   every PR on arrival across 40 ADRs. `ci.yml` already contains the argument, in the
   `migrate diff` step: a hard gate on pre-existing drift *"would red-on-arrival every
   PR and MASK the real ordering gate below."* The citation resolver is the real gate
   here; nothing may be allowed to train people to bypass it.

The hard/soft split follows ADR-0037's discipline of grading a signal by what a human
can actually do about it: an unresolved citation is a five-minute fix with an obvious
owner, so it blocks. A prose promise needs judgement about scope and priority, so it
annotates.

---

## 4. Precision over recall, measured

The extractor is a keyword pass, not language understanding. It was tuned by reading
its output against the corpus and **deleting** patterns that looked right in the
abstract:

- **`gated on` — removed.** 6 hits, **6 false positives**, 0 real promises. In this
  repo it almost always describes a rollout flag (*"gated on `ipad_queue`"*), not a
  commitment. A test asserts it is not silently re-added.
- **Bare `should be`, `will be`, `planned`, `pending` — never added.** They occur
  overwhelmingly in descriptive prose. `should be re-derived` is kept, because the
  specific phrase is always a commitment in this corpus.
- **Blockquotes, fenced code, headings and table rows are skipped.** A quoted promise
  belongs to whoever made it; a `TODO` in a code sample is not a commitment.
- **Already-closed lines are skipped**, via a case-SENSITIVE status marker
  (`DONE`, `RESOLVED`, `SHIPPED`) plus specific lowercase phrases. Lowercasing the
  whole set would have suppressed any genuine promise in a sentence containing the
  ordinary word "shipped" — recall loss disguised as precision.

**Result:** 70 candidates across 40 ADRs. On the floor-ADR subset, which was audited
line by line, precision is roughly **85%** and the residual false positives are
descriptive uses of `still open` (e.g. a *load* that is still open).

**The recall gap is real and stated:** ADR-0094 counted ~42 promises in 13 ADRs by
reading them; the extractor finds far fewer in that same subset, because many
promises are stated in ordinary English with no marker at all. **This is why the
register is seeded by hand and why the CI check only warns.** The tool is a net for
the obvious cases, not the source of truth. The register is the source of truth.

---

## 5. Alternatives considered

- **Fail on every unresolved citation with no baseline.** Rejected: 24 pre-existing
  violations would have redded every PR until five amendments were written by someone
  guessing at history. The baseline plus ratchet gets the gate live today and keeps
  the debt visible.
- **Write the five missing amendments now.** Rejected: fabricating a record is worse
  than an empty one. They are tracked as P-01…P-05 with the citation counts, so
  whoever *does* know can close them cheaply.
- **Parse ADRs into structured front-matter with machine-readable promises.**
  Rejected for now: it would require rewriting 104 existing ADRs, and the ADRs' value
  is that people actually read them. Worth revisiting if the register proves useful.
- **A linter over `OPEN-ITEMS.md` instead of a new file.** Rejected: at 2,024 lines
  with a single `**OPEN**` marker in a mostly-prose layout, it is not machine-readable
  and re-shaping it would be its own project. `PROMISES.md` is additive and leaves
  `OPEN-ITEMS.md` untouched.
- **Validate `§N` and `D5` sub-references too.** Rejected: far more varied in the
  wild, and a false failure on a decision-letter reference would train people to
  disable the gate. Amendments were chosen because they have a stable, checkable
  heading shape.

---

## 6. Consequences

- A citation that does not resolve **fails CI**, locally at push and on every PR. The
  ADR-0064 / ADR-0065-Am.2 class cannot recur silently.
- ADR-0065 **Amendment 2 now exists**, twelve days after the code it governs, and
  records both the fix and why the record was late.
- The four phantom families are **visible and counted** instead of invisible.
- A new ADR that states a promise without a registry row gets a CI annotation on the
  PR that introduces it — at the moment of writing, when the author still has the
  context.
- One more `.mjs` + `.d.mts` pair each, following the existing script convention; no
  new CI job, no new dependency, no runtime code, nothing to deploy.

---

## 7. What this does not fix, stated plainly

- **It does not make anyone keep a promise.** It makes an unkept one visible. P-23
  (the dead-end telemetry) can sit `OPEN` in a well-maintained register forever.
- **The extractor misses promises stated in plain English.** Precision was chosen
  over recall deliberately; the register, not the tool, is the source of truth.
- **`PROMISES.md` can rot exactly like `OPEN-ITEMS.md`.** The only structural defence
  is the baseline ratchet, which covers P-01…P-05 and nothing else. If the register is
  not read in review, it will decay — and the honest answer is that this is a
  documentation habit with a small amount of enforcement, not an enforced system.
- **It does not verify that a citation is CORRECT** — only that its target exists.
  A comment citing ADR-0074 for a rule that actually lives in ADR-0082 passes.
- **The 33 seeded rows are not the full 104-ADR corpus.** 40 ADRs show promise
  candidates; only the floor set was audited.
