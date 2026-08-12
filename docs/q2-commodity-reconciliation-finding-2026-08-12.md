# Q-2 Finding — where the real commodity-reconciliation data lives (FINDING ONLY)

**2026-08-12 · investigation only, nothing absorbed/wired/built · decision returns to Bill.**

## Confirmed: the absorbed tracker is a sign-off log, not reconciliation data

`doc_commodity_audit_rows` (252 rows, from **"Woodland Data Auditing Tracker
(1).xlsx"**, doc_source `9f71ccb3…`) columns are exactly:
`audited, audit_date, initials, second_audit, second_audit_date, second_initials,
status, confirmed_by, discarded_*, stream_label, month_label, …` — an
audited-yes/no + who + when log across commodity bands (FOAM, METAL-GreenZone,
METAL-SA, WOOD-{Biomass,Renovation,Sierra,Yolo}, PLASTIC/CARDBOARD/…, TOPPERS,
TRASH-Yolo, XTRACTION). **No weight, no dollar amount, no invoice number, no
expected-vs-actual variance.** The handoff's premise holds — Layer B
reconciliation cannot be built from this file.

## Candidate files carrying the ACTUAL reconciliation inputs

From `doc_ingest_reachable_items` (160 rows, 8 distinct files in the Woodland
`docs-dr3` share, all owner `kelsey.ruhland@svdp.us` except the machine list):

| File | Size | Modified | Why it is the likely reconciliation source |
|---|---|---|---|
| **Woodland Outbound Auditing 2026.xlsx** | **461 KB** | 2026-07-30 | Largest audit-family file; "Outbound" = shipped commodity loads — the population a MyMRC-vs-invoice cross-check reconciles. Most probable home of per-load weights/amounts. |
| **Woodland Invoices tracking.xlsx** | 52 KB | 2026-07-29 | Invoice side of the cross-check — invoice numbers and dollar amounts. |
| TEREX.xlsx | 481 KB | 2026-07-29 | Throughput/equipment (already partly absorbed, ADR-0079/0081) — not commodity reconciliation. |
| DR3 Data Tracking.xlsx | 331 KB | 2026-07-29 | General tracking; unclassified — worth a column look but not obviously reconciliation. |

Other reachable files (not reconciliation): DR3 Machine List, DR3 Meeting Notes
Log, DR3 Task Lists, JOURNAL Woodland Facility, Woodland Trailer list.

**Reachability note:** the sweep already flags this exact gap — anomaly row:
*"Vision can READ 11 documents in scope but is WATCHING only 3. 8 reachable
documents are …"*. The two named candidates are in the readable-but-unwatched
8; the app can see them, it just has not sampled their columns because they
were never added as watched `doc_sources`.

## Honest limit of this finding

I did **not** open the two candidate files' actual cells — reading them means
decrypting the Graph refresh token (AES-256-GCM under `MYMRC_CRED_KEY`) and
pulling bytes, a live-credential action beyond a finding-only task that risks
touching the one live ingest connection. What is proven: the files **exist, are
reachable, and are named/sized/owned consistently with carrying the real
reconciliation inputs**. Their exact columns — do they actually hold
per-commodity weight + amount + invoice + variance — are **unconfirmed until
someone samples them**.

## Recommendation to Bill (decision returns to you)

The cheap, read-only next step: add **Woodland Outbound Auditing 2026.xlsx**
and **Woodland Invoices tracking.xlsx** as watched `doc_sources` and let the
existing classifier sample their headers — turning "likely" into "confirmed"
without building any Layer B. Whether to then wire reconciliation is a
separate, later call.
