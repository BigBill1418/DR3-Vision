# ADR-0112 — A zero that contradicts the watched set

**Date:** 2026-08-19 (Pacific)
**Status:** Accepted, implemented.
**Extends:** ADR-0080 (the reachability probe — REACHABLE vs WATCHED).
**Related:** ADR-0102 (the transport that could never find a file — the `$select`
projection lesson this repeats), ADR-0111 (the probe was wrong, not the password —
the same investigation shape, the day before), ADR-0037 (grading a signal before
it pages anyone), ADR-0069 `absorption_empty` (the silent-zero grading precedent).

---

## 1. Context

Handoff #271 reported that the ADR-0080 reachability probe — the discovery-gap
watchdog — had "gone silently blind": every `doc_ingest_reachability_scans` row
since roughly 08:29 AM PT on 2026-08-19 showing **0 items with `error = null`**,
where prior scans through 8/16 had returned 6–8. The framing was that the
SEARCH-based observation probe saw nothing while capture stayed healthy, and that
ADR-0080's own promise — _"the scan records its OWN failure loudly"_ — was not
being kept, because a 0-result with no error is not treated as a failure.

The second half of that sentence is exactly right, and it is the reason this ADR
exists. The first half is not what happened.

## 2. What the measurement showed

**The premise died on the scans table.** `reachable_count` has been **11 on every
successful scan since the probe's first run on 2026-08-07**, including 10:35 AM PT
on the morning of the report. There is no window in which the probe reported zero
reachable documents.

Every distinct shape the table has ever held, in Pacific time:

| reachable / watched / gap | scans | first                | last             |
| ------------------------- | ----- | -------------------- | ---------------- |
| 11 / 3 / 8                | 512   | 2026-08-07 16:05     | 2026-08-12 21:46 |
| 11 / 5 / 6                | 270   | 2026-08-12 21:47     | 2026-08-15 17:03 |
| 0 / 0 / 0 **(error)**     | 2     | 2026-08-13 03:49     | 2026-08-18 22:24 |
| 11 / 11 / 0               | 360   | **2026-08-15 17:12** | 2026-08-19 10:35 |

The number that went to zero is **`gap_count`**, not `reachable_count` — and the
"0 items" the report saw is the `doc_ingest_reachable_items` snapshot, which is
written only when there IS a gap.

### The flip boundary, and its cause

The flip is **2026-08-15 17:12:32.252 PT** (`11/5/6` → `11/11/0`), not "between
8/16 and this morning". Its cause is in `doc_sources`, two to six seconds earlier:

```
2026-08-15 17:12:26.197 PT  DR3 Data Tracking.xlsx
2026-08-15 17:12:27.246 PT  JOURNAL Woodland Facility.xlsx
2026-08-15 17:12:28.044 PT  TEREX.xlsx            (enabled = false)
2026-08-15 17:12:29.043 PT  DR3 Task Lists for 2025.xlsx
2026-08-15 17:12:29.819 PT  DR3 Meeting Notes Log 2026.xlsx
2026-08-15 17:12:30.653 PT  DR3 Machine List (2).xlsx
```

The earlier `8 → 6` step has the same signature: two sources created at
2026-08-12 21:47:15 PT, and the very next scan at 21:47:24 PT — nine seconds
later — reads `11/5/6`.

That is **O-2 working exactly as ADR-0080 designed it**: the probe named the
unwatched documents, a human decided they belonged in the pipeline, and registered
them through `/admin/doc-ingest`. `DR3 Machine List (2).xlsx` — the
Outlook-attachment share that appears in no enumeration route, the document that
proved discovery was under-reporting and that ADR-0080's own module header names —
is in that list. **The gap did not go blind. It closed.**

### The controlled live probe

One `POST /search/query` against the live tenant, same scope and cap the sweep
uses, capturing the raw response before projection:

```
SCOPE: (filetype:xlsx OR filetype:xlsm OR filetype:xlsb OR filetype:csv)
       AND path:"https://svdplanecounty-my.sharepoint.com"
HTTP 200 OK
container keys: [ 'hits', 'total', 'moreResultsAvailable' ]
total: 22   moreResultsAvailable: false
RAW HIT COUNT: 22
PROJECTED OK: 22  DROPPED(null): 0
CLIENT searchDriveItems -> items=22 total=22 truncated=false
doc_sources rows = 11
```

22 raw hits are the same 11 documents returned twice — which is precisely the
duplication ADR-0080's `(driveId, itemId)` dedup was written for, now confirmed
against live bytes rather than inferred. After dedup: 11 unique, all 11 present in
`doc_sources`, gap 0.

So: **no empty result set, no response-shape drift, no permission drift.** The
account's `Sites.Read.All` is returning what it always has; C-47 remains Bill's
and nothing here touches it. The one transient — 22:24 PT on 8/18,
`graph request failed`, self-resolved by 22:39 — is ADR-0080's failure path
working, and is the only error the table has held since 8/13.

## 3. The real defect

The report was wrong about what happened and right about what is possible. Three
holes, none of which had fired yet, all of which produce the reported symptom for
real:

**D1 — a successful empty search is an ALL-CLEAR, not merely a silence.**
If `searchDriveItems` returns `{ items: [], truncated: false }` without throwing,
`runReachabilityScan` computes `reachable 0 / watched 0 / gap []`, writes a scan
row with `error: null`, and takes the `else` branch — which calls
`resolveAnomaly` with _"Every document in scope is being watched (0 of 0)"_. It
does not merely fail to alarm; it **clears a standing discovery-gap alert** on the
strength of a measurement that saw nothing. In the scan row and in the 06:00
digest that outcome is byte-identical to the healthy 11/11/0 running today. This
is ADR-0080's stated rule — _"a probe failure is never a gap of zero"_ — holding
for the throw path and having no coverage at all for the succeed-and-see-nothing
path.

**D2 — the transport DROPPED unprojectable hits silently.** `searchDriveItems`
did `if (projected) items.push(projected)`. `projectDriveItem` returns null when a
resource has no `id` or no resolvable `parentReference.driveId` — so a Graph shape
change that moved either field would turn a HTTP 200 carrying 22 hits into
`items: []`, manufacturing D1's empty set out of a perfectly healthy response.
That is ADR-0102's `$select` lesson exactly: _a projection omitting the branch
field is a silent total zero._ The live probe shows 0 of 22 dropped today, which
is why this is a latent hole and not an incident.

**D3 — the digest's error prefix asserts a cause it cannot know.** It reads _"The
document-discovery completeness check could not run"_, which mis-describes a probe
that ran fine and returned an answer that cannot be true.

## 4. Decision

**D1.** After dedup, when the probe returns **0 documents** while at least one
**live** `doc_source` exists — `enabled = true` and `disappeared_at IS NULL` —
record the scan as a CONTRADICTION: the existing `error` column carries the
reason, `gap_count` stays 0 but is now unreadable as good news, and the new
`discovery_probe_contradiction` anomaly is raised on its own subject. **Nothing is
resolved.**

Two readings of `doc_sources` are deliberately kept distinct. WATCHED counts every
row including disabled ones — a document Bill switched off is not a gap, which is
ADR-0080's existing rule and is unchanged. LIVE counts only rows the pipeline
asserts still exist. It is the live count that makes the zero decidable.

The guard **does not** claim every live source must match the scope — the scope is
a filetype-and-path filter and a source could legitimately sit outside it. It
claims the weaker, sound thing: a **total** zero, while the pipeline is
demonstrably reading documents, is either a broken probe or a scope that excludes
everything Vision watches. Neither is an empty tenant, and neither is good news.

When no live source exists, the zero is explainable and the guard stays quiet —
otherwise it becomes wallpaper on exactly the day it should be believed.

**D2.** `searchDriveItems` throws `GraphContractDriftError` on any hit it cannot
project, rather than dropping it. This routes into the `try/catch`
`runReachabilityScan` already had — the loud-failure path ADR-0080 wrote correctly
and that nothing was reaching. Named for the `PortalContractDriftError` precedent
in `src/lib/mymrc/`, because the failure being prevented is identical: a green run
with no rows. A genuinely empty `hits` array still returns empty and never throws;
the guard fires on hits that exist and cannot be keyed.

**D3.** The digest prefix becomes _"Document-discovery completeness is
UNVERIFIED"_ — neutral about which of the two untrustworthy outcomes occurred,
because the stored reason says so in its own words.

### Grading (ADR-0037)

`discovery_probe_contradiction` is `critical` / `default`, routed to the HEALTH
page. Graded on the `absorption_empty` precedent, which has the same shape: a
silent zero that reads as success. `critical` because the discovery guard has
stopped being able to answer its question, which is strictly worse than a known
gap. **Not** `high`: question 1 fails — the fix is a code change or waiting out a
Microsoft-side index lag, not a five-minute operator action. HEALTH rather than
SOURCES because there is nothing to register; the instrument is the subject.

A **separate kind** rather than a second subject under `discovery_gap`, because
the two grade differently and must. The policy table is
`Record<DocIngestAnomalyKind, AnomalyPolicy>`, so adding the enum value makes
`tsc` demand the grading rather than letting it inherit one.

## 5. Consequences

- **Nothing about today's live behaviour changes.** The healthy 11/11/0 sweep
  still reports 11/11/0, still resolves, still says nothing in the digest.
- Migration adds **one enum value**. No table change: the contradiction rides the
  existing `error` column that every consumer already branches on first.
- The `error` column now carries two distinct meanings — could-not-look and
  looked-and-cannot-be-true. Consumers branch on it identically and correctly for
  both; only the prose differs. Splitting it into a typed column was rejected as a
  schema change bought with no new decision.
- D2 converts a class of Graph shape change from a silent zero into a loud scan
  failure. If Microsoft ships a projection change, the sweep will now page rather
  than quietly report that discovery is complete. That is the intended trade.

## 6. Falsification

Both guards were run against the pre-change module first, and both reds name the
reassuring wrong value rather than an opaque mismatch.

D1 — search returns `[]` while eleven live sources exist:

```
AssertionError: expected 'ALL-CLEAR: 0 readable, 0 watched, gap…' to match /^CONTRADICTION: /
- Expected: /^CONTRADICTION: /
+ Received: "ALL-CLEAR: 0 readable, 0 watched, gap 0"
```

…and the digest, on that same scan row:

```
AssertionError: expected null not to be null
```

D2 — one hit whose `parentReference` carries no `driveId`:

```
AssertionError: expected 'SILENT: 0 items from 1 hit(s)' to be 'THREW: GraphContractDriftError'
```

The quiet control is asserted alongside them: with no live source, an empty search
still records `error: null`, raises nothing, and resolves normally — so a guard
that over-fires goes red there.

## 7. What this ADR does NOT do

- **C-47 (`Sites.Read.All` review) is untouched.** The probe's permission was
  verified as working and nothing was changed. That review is Bill's.
- **C-48 (`/shares` on undocumented permission) is untouched.** The report
  anticipated switching the probe to a supported enumeration per C-48's
  trajectory. The evidence does not support it: the search route is healthy and
  returning the right answer, and swapping a working observation probe on the
  strength of a misread would be a change made for no reason.
- **C-49 remains open in part.** Discovery under-reporting is detected — that is
  ADR-0080 and it is working. What this closes is the narrower hole where the
  detector's own zero was indistinguishable from health.
