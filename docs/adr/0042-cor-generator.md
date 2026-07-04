# ADR-0042 — COR generator (Exhibit 5: Certificate of Recycling, Employment and Inventory)

**Status:** Accepted (2026-07-04, approved by Bill)
**Date:** 2026-07-04
**Relates to:** mission record §5; Addendum B §B4 (daily-close fields, capacity); forward handoff §3.2; ADR-0037 (pool-aware balance, snapshots, daily close), ADR-0041 (immutable-version pattern reused)
**Series:** third of three P2 ADRs — 0040 rates (built), 0041 invoices (built), **0042 COR (this)**

## Context

Monthly, per CA facility, currently hand-written — and the hand-written June copy
is the motivating defect: the headcount reads "15 or 18" depending on who squints,
on a document signed **under penalty of perjury**. Vision pre-fills every number
from data it can prove, a human reviews, and a human signs. The governing
principle from the mission, verbatim: **Vision pre-fills and renders; a human
always reviews and signs; Vision never auto-certifies.**

## Decisions

### D1 — `cor_certificates`: same immutable-version discipline as invoices

```
cor_certificates(id, site_id, cover_month @db.Date, version Int, supersedes_id?,
    status enum(draft, finalized, void),
    inventory_units Int,       inventory_source jsonb,   -- balance/snapshot refs
    ft_headcount Int?,         pt_headcount Int?,
    headcount_source jsonb,    -- the daily-close rows consulted + method
    signer_name, signer_title, -- from config, not typed per-certificate
    prepared_by, prepared_at, finalized_by?, finalized_at?,
    pdf_storage_key?, …audit)
```

CA-jurisdiction sites only (typed error for OR — no Exhibit 5 exists there).
Draft regenerates freely; **finalized is immutable** (supersede chain for
corrections, both versions retained — identical semantics to ADR-0041 D1, same
lifecycle code pattern).

### D2 — The three pre-filled numbers, each with provenance

1. **Unprocessed inventory at month close** = the pool-aware running balance
   (ADR-0037 D6 — the ONE function) as of the month's last day, cross-referenced
   against the nearest physical snapshot; `inventory_source` records the anchor
   snapshot id, the computed figure, and any reconcile delta in between.
   **Acceptance anchor (§7-b): the June 2026 Woodland certificate must
   reproduce 4,062** once June data is loaded — this is a test fixture, not
   aspiration.
2. **FT/PT headcount** — pre-filled from the month's daily-close
   `employees_count`/`processors_count` fields (B4). ⚠ Honest gap: the daily
   close captures *totals*, not an FT/PT split. Pre-fill strategy: month-end
   close's counts shown with the full month's series in the review UI; the
   **preparer enters the FT/PT split at review** (they know the roster), and the
   entry is audited with the pre-fill values retained in `headcount_source`.
   The ambiguous-handwriting defect dies; the FT/PT judgment stays human, on
   the record. (If a roster-derived split becomes available later — HR data is
   not in Vision — the pre-fill improves without schema change.)
3. **Signer block** = standardized from site config: **Rick Albritton**, title
   from a `cor_signer_title` config value seeded `"Transportation Manager"`
   (what the June COR read) **flagged TBC with MRC** — one config edit when
   confirmed, never a code change, never re-typed per certificate.

### D3 — Render + the signing boundary

Render to PDF through the existing bonus-PDF machinery (internal loopback print
route + Playwright + R2 storage — the proven house path, including the
reconciliation-tripwire discipline: the PDF renders FROM the stored certificate
row, and a pre-render assertion recomputes the inventory figure and refuses on
mismatch, ADR-0033 style). The signature block renders **empty**: Rick prints,
signs, and submits per the current MRC process. Vision records who finalized the
data and stores the rendered artifact; it never renders a signature, an
"e-signed" mark, or anything that could be mistaken for certification. Finalize
is manager-of-site or admin, audited.

### D4 — Review surface

`/dashboard/[site]/cor` — month picker, the three numbers with drill-down
(inventory → balance ledger + snapshot; headcount → the month's daily-close
series), the FT/PT entry, capacity context banner (3,150/3,500 warn levels,
display-only), diff vs prior version, finalize button with a
"reviewed under penalty of perjury — a human signs the printed copy"
confirmation. English-first office surface; onClick; site-scoped.

### D5 — Observability (standing directive)

Generation, finalize, supersede, and the pre-render reconcile refusal each log
with certificate id/month/site/actor; the reconcile refusal is a typed error
carrying both numbers. No PII anywhere (the COR has none by design).

## Out of scope

Any auto-submission to MRC · OR equivalent (none exists) · roster/HR data for
FT/PT derivation (pre-fill improves if it ever lands) · monthly MRC Recycling
Summary (a different document; the commodity mapping B10-5 gates it — parked
with the workbook-export scope from ADR-0041 D5).

## Consequences

- One table, one render path, both reusing proven patterns (ADR-0041 lifecycle,
  bonus-PDF pipeline) — small, low-risk build.
- The perjury-adjacent numbers become provable: every figure on the certificate
  traces to rows, and the one human judgment (FT/PT split) is captured with its
  pre-fill context instead of being scrawled ambiguously.
- July's COR — the first Vision-generated one — lands inside Kelsey's validation
  window with the June 4,062 fixture proving the inventory math behind it.

## Test plan (summary)

Inventory pre-fill provenance + the June-4,062 fixture · pre-render reconcile
refusal on tampered figure · FT/PT entry audit trail (pre-fill retained) ·
lifecycle immutability matrix (finalized rejects mutation; supersede chains) ·
CA-only typed error for OR sites · PDF snapshot structure test · signer block
from config incl. title change without code · migration clean-replay (CI).
