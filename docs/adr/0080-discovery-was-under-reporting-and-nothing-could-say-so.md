# ADR-0080 — Discovery was under-reporting, and nothing in the system could say so

- **Status:** Accepted
- **Date:** 2026-08-07
- **Supersedes:** nothing. **Amends:** ADR-0067 (§3.2 D4/D8, §3.4), ADR-0069 (Am. 1/2 absorption family).
- **Related:** ADR-0057 D9 (silent staleness), ADR-0077 (the triple-count), ADR-0037 (alert grading), ADR-0076 (processor headcount).

## Context

Every layer of the document pipeline has a staleness guard except the one that
decides what the pipeline is even looking at.

The sweep has freshness. Subscriptions have expiry. Ingest compares `cTag`.
Absorption has the loud zero. **Discovery had nothing.** It reported
`sources_updated: 1` on each of the 902 sweeps between 2026-07-29 and 2026-08-07,
and no surface compared that number against anything — so "Vision can see one
document" and "one document exists" were indistinguishable, which is precisely
the shape ADR-0057 D9 exists to eliminate.

### What was measured (2026-08-07, live tenant, read-only)

Driven against `docs-dr3@svdp.us` with its actual granted scopes
(`Files.Read.All`, `Sites.Read.All`, `User.Read`):

| Route                                           | Returns              | Sees the known-missing document? |
| ----------------------------------------------- | -------------------- | -------------------------------- |
| `GET /me/drive/sharedWithMe` (current primary)  | **1** (`TEREX.xlsx`) | no                               |
| `GET /me/drive/sharedWithMe?allowexternal=true` | 1                    | no                               |
| `GET /me/insights/shared`                       | 10                   | no                               |
| `GET /me/drive/recent`                          | 0                    | no                               |
| `POST /search/query`, unscoped                  | **11,442**           | **yes**                          |
| `POST /search/query`, scoped (below)            | **11**               | **yes**                          |

`doc_sources` held **3** rows. So the enumeration was reporting 1, the system was
watching 3, and 11 were readable inside DR3's own document universe.

`DR3 Machine List (2).xlsx` — owned by `bill.barnard@svdp.us`, an
Outlook-attachment share — appears in **no enumeration route at all**, only in
search. It resolves cleanly through the ordinary `GET /drives/{id}/items/{id}`
path (HTTP 200, 42,428 bytes, `cTag` present), so it was always ingestable; it
was simply never discoverable.

## Decision

### D1 — Search is the reachability PROBE. It is NOT, and must never be, the enumeration.

The handoff proposed moving primary discovery onto the Search API. **Measurement
refuted that**, and the refutation is the most important line in this ADR.

`POST /search/query` returns everything the signed-in identity **can read**, not
everything shared **with** it. Microsoft is explicit: "Users cannot access more
items in a search than they can otherwise obtain from a corresponding GET
operation with the same permissions." Vision holds `Sites.Read.All`, so the
unscoped answer is the entire tenant — 11,442 items, including Night Shelter
case-management packets, HR W-9 lists and Lane County housing rosters.

Wiring discovery onto that would have Vision classifying, downloading and
archiving material it has no business touching. That is a data-protection
incident wearing a feature's clothes. **Search informs a human; it never feeds
the watch list.** Nothing in `reachability.ts` creates a `doc_source`.

### D2 — The bound is stated wherever the number is shown.

The probe is scoped:

```
(filetype:xlsx OR filetype:xlsm OR filetype:xlsb OR filetype:csv)
AND path:"https://svdplanecounty-my.sharepoint.com"
```

That host is the tenant's **personal-OneDrive** host. Measured, it returns
exactly 11 items — the whole DR3 document universe and nothing else, because the
case-management and HR material lives on the team-sites host. The scope is
therefore narrow by construction rather than by exclusion list.

A scoped probe can only ever find a **lower bound** on the gap. So the exact KQL
is stored on each scan row (never re-derived at render time, because the config
may have changed since) and rendered beside the counts, and `truncated` says when
Graph still had more to give. This is the `depth_limit_reached` discipline:
bounding the walk is correct; being quiet about what the bound excluded is not.

### D3 — "We could not look" is never "there is no gap".

Three states are kept distinct in the data model, on the health surface and in
the 06:00 digest, and only one of them is quiet:

- no scan has ever run → **say so**;
- the last scan errored → **say so**, with the reason;
- a successful scan found nothing unwatched → silence.

`SweepResult.reachabilityGap` is `number | null` for the same reason. A failed
probe recording `gap_count: 0` would rebuild the exact illusion this ADR exists
to destroy. This is the same "not recorded ≠ zero" rule ADR-0077 applied to
downtime and ADR-0076's follow-up applies to headcount.

### D3a — Two retentions, because the two tables answer different questions.

Scan rows (the COUNTS) are the history: "when did the gap open?" is only
answerable if they outlive the sweep that wrote them, and at four sweeps an hour
a 50-row cap is twelve hours of memory. They are three integers and a string, so
thousands are free — the default retains roughly seven weeks.

Item rows are a _snapshot of a question_, not a ledger: the same eight documents
re-listed every fifteen minutes until somebody acts. Only the newest few scans
keep theirs.

These must be pruned **separately**, and that is the whole point of writing it
down: `doc_ingest_reachable_items` cascades on its scan, so one combined prune
silently discards the counts along with the snapshots. The first version of this
function did exactly that while its own comment claimed the opposite. Pinned by a
test whose red is `expected [ { id: 'scan-3', … } ] to have a length of 3 but got 1`.

### D4 — The gap is surfaced, never adopted.

A `discovery_gap` anomaly is raised naming the documents (a count is not
actionable; `"DR3 Machine List (2).xlsx"` is), graded `warning`/`default` exactly
like `depth_limit_reached` — nothing is broken or degrading, and the answer is a
human deciding whether a document belongs in the pipeline. Registration remains
Bill's click through the existing register-by-URL path (O-2). Disabled sources
count as watched: re-reporting a document Bill deliberately switched off would
train him to ignore the alert (ADR-0037 question 4).

### D5 — `sharedWithMe`'s sunset date is an inference and is labelled as one.

Microsoft's reference page says only **"November, 2026"** — it names no day.
`SHARED_WITH_ME_SUNSET` keeps `2026-11-01` as the conservative reading (it can
only be early, never late), and `SHARED_WITH_ME_SUNSET_IS_INFERRED` makes every
surface say so. Presenting an invented day as the vendor's deadline is the same
false precision as rendering an absent cost as `$0.00`.

### D6 — C-43 is NOT resolved here, and the successor is still unknown.

Research findings that change the shape of the problem:

- `GET /me/drive/sharedWithMe` is deprecated, **already degraded in production**
  (the 1-item response is the documented degradation, not a tenant quirk), and
  stops returning data in November 2026. No documented one-to-one replacement.
- **`GET /me/insights/shared` is deprecated on the SAME date** and additionally
  carries a tenant-wide _and_ per-user ItemInsights kill switch that silently
  returns empty with a 200. It is therefore **not** a successor — it was the
  obvious candidate and it is disqualified.
- `SharedWithUsersOWSUser:"docs-dr3@svdp.us"` — the SharePoint managed property
  documented for "shared with this person" — was **tested against this tenant and
  returned total = 0**. Microsoft documents it as indexing only "Specific people"
  shares; these are link shares. It is not a usable narrowing. Recorded so nobody
  re-derives it.

So both legacy paths die simultaneously with no announced replacement, and the
only survivor answers a **wider** question than the one being retired. That is a
security-relevant delta, not merely a functional one, and it needs an
architecture decision before November. **Out of scope here** — this ADR ships the
transport, the scope discipline and the guard, which is the groundwork that
decision will be made on.

### D7 — The commodity tracker is not what it was believed to be.

The "Woodland Data Auditing Tracker" was expected to carry commodity figures
cross-referenced against vendor invoices — "the highest-reconciliation-value
document". Read against the live bytes, **it carries no tonnage and no money.**

It is an audit-**coverage** matrix: per commodity stream × month it records
whether that month's audit against vendor invoices was performed, by whom, and
when, plus a second-audit trio. Consequences, stated plainly because three
downstream requirements rested on the wrong premise:

- There is **nothing to reconcile against `processed_units_daily`**, and nothing
  in this change reads or writes it. `src/lib/workbook-sync/` (ADR-0049) remains
  its one writer, untouched.
- The requested **side-by-side against Vision's MyMRC/processed/outbound figures
  is not buildable** — the document has no figures of that kind. Manufacturing
  one would have invented a comparison.
- Preview-then-confirm is still the rule, but **not because it carries money**.
  It is because a newly-understood layout must not silently become fact, and
  because the confirm click writes an operator's name (O-2).

What the document _does_ answer is real and was not previously answerable: which
commodity streams have been audited, and which months have not. The 2026 sheet
shows `DAILY LOG/MYMRC/SPREADSHEETS` — an audit of Vision's own numbers —
unaudited.

`parse_summary` for this document had detected its headers as
`["2026", "Commodity Audit (against Vendor Invoices)  WOODLAND"]` — the **banner
row**, not the header row. The ADR-0067 Am.8 detection does not resolve this
layout, which is why a dedicated extractor exists rather than a reuse.

**The layout is stacked, and finding that out cost a real defect.** The sheets do
not carry one header row: they carry several, at different vertical AND column
offsets, each introducing its own streams. The 2026 sheet has header rows at 4,
18, 20, 32 and 47; the 2025 sheet at 4, 18 and 32. Real totals: **12 streams ×
12 months = 144 rows (2026)** and **9 × 12 = 108 (2025)**.

The first implementation resolved only the first header row and then scanned every
row beneath it, so the lower blocks' months were attributed to the top block's
streams. Measured against the archived bytes: **60 duplicate
`(stream, month)` pairs on the 2026 sheet and 36 on 2025**, five commodity streams
(`METAL - SA`, `WOOD- Sierra`, `WOOD- Yolo`, `WOOD- Renovation`,
`PLASTIC, CARDBOARD, SHODDY…`) missing entirely, and their audit state written
under other streams' names. The unique index would have rejected the insert, so
the absorption would have failed outright in production.

Its unit tests were green throughout, because the hand-built fixtures modelled the
top block faithfully and nothing else. **The total row count was unchanged by the
bug** (144 either way), so no count would have caught it either. It was found by
running the extractor against the real archived bytes and asserting that no
`(stream, month)` pair repeats — which is now a permanent guard, and the reason
"verify against the live artifact, not against a fixture of it" is written down
here rather than learned twice.

### D8 — Version-scoped from the first row.

`doc_commodity_audit_rows` is unique on
`(doc_source_version_id, sheet_name, stream_label, month_label)`, so two confirmed
revisions of one workbook coexist, each a complete copy, and every aggregate
read must pin the winning revision first (newest-absorption-wins). This is
ADR-0077's lesson applied _before_ the incident rather than after: registering the
TEREX source made all three applied revisions absorbable at once and the ledger
summed every confirmed row — $231,203.82 for a $77,067.94 document. Superseded
batches are discarded through the normal path, but correctness must not depend on
that housekeeping having happened.

## Consequences

- Discovery's completeness is now measurable, and its answer is compared against
  something on every scheduled sweep.
- The probe costs one search call per scheduled sweep. It is **not** run on the
  notification path: a webhook fires on cell edits, and the answer changes on the
  timescale of somebody sharing a document.
- The gap will read **8** on first deployment. That is a true statement about
  2026-08-07, not a bug, and it stays until Bill registers or dismisses them.
- Vision now holds a list of documents it can read and is not reading. That list
  is itself mildly sensitive (it names files in colleagues' OneDrives); it is
  admin-only, like the rest of `/admin/doc-ingest`.
- A tenant that widens `Sites.Read.All`, or a scope edited to drop the `path:`
  clause, would widen the probe. The scope is rendered on the surface precisely
  so that change is visible rather than silent.

## Alternatives considered

**Move enumeration to Search (the handoff's proposal).** Rejected on
measurement: 11,442 tenant-wide items including case-management PII. See D1.

**Move enumeration to `/me/insights/shared`.** Attractive — 10 items, correctly
scoped to genuinely-shared material, carries `sharedBy` and `sharingType`.
Rejected because it is deprecated on the _same_ date as the endpoint it would
replace, and because an admin or the user can disable ItemInsights and get a
silent empty 200. Trading one November-2026 dependency for another, more fragile
one buys nothing.

**Auto-register what the probe finds.** Rejected. See D1; this is the difference
between a feature and an incident.

**Widen the scope to the whole tenant and filter by relevance terms.** Tested:
`DR3` / `Woodland` / `TEREX` union returns 30 spreadsheets including W-9 lists
and housing rosters, because Microsoft Search matches fuzzily. Term relevance is
not an access boundary. The `path:` host scope is.
