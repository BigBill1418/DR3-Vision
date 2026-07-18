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
   close captures _totals_, not an FT/PT split. Pre-fill strategy: month-end
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

## Post-acceptance implementation notes (2026-07-04)

Built as accepted. Files:

- **Schema + migration `20260708_cor_certificates`** (one contiguous end-block
  `// ADR-0042 — COR`): `cor_certificates` (D1, immutable-versioned, supersede
  self-relation) + `cor_site_config` (D2.3 signer) + enum `CorStatus`. Bare-FK
  convention (site_id constraints at the DB level in the migration, no Prisma
  relation on `Site`), mirroring ADR-0040/0041. Clean-replays on empty PG16;
  sorts after `20260707_invoice_generation`.
- **Service (`src/lib/cor/`)**: `prefill.ts` (the three numbers with provenance —
  inventory via the ONE `onHand` balance as of month-end + anchor snapshot ref +
  reconcile delta; headcount pre-fill from the month-end close + full series);
  `service.ts` (`generateCorDraft`, `setCorHeadcountSplit`, the
  `assertCorInventoryReconciles` pre-render tripwire, CA-only guard, reads);
  `lifecycle.ts` (finalize / supersede / void + `canFinalize`, mirroring ADR-0041
  semantics — not importing them); `signer.ts`; `view.ts` (typed errors +
  `toCorView`); `route-helpers.ts`.
- **Render (D3)**: internal loopback-guarded print route
  `/internal/cor-pdf/[id]` (added to `src/lib/public-paths.ts` + its regression
  test — the mandatory ADR-0036 lesson). `pdf.ts` renders via the bonus-PDF
  Playwright pipeline pattern FROM the stored row, re-asserts the reconcile
  tripwire before render, stores to R2 under `cor/`. **Signature block renders
  EMPTY** (D3, verbatim).
- **UI (D4)**: `/dashboard/[site]/cor` — CA-only (Oregon 404s; nav link hidden for
  OR), month picker, three numbers with drill-down, FT/PT entry, display-only
  capacity banner (indoor limit, warn at 90% — derived from the seeded site
  config, no hardcoded number), version diff, penalty-of-perjury finalize
  confirmation. `onClick` throughout (hard rule #10), site-scoped (#2).
- **Observability (D5)**: `cor.generate` / `cor.finalize` / `cor.supersede` /
  `cor.reconcile.refused` structured logs carry cert id / month / site / actor;
  typed errors carry numbers (`CorReconcileMismatchError` carries stored +
  recomputed). A COR has no PII.
- **June-4,062 fixture (§7-b)**: `src/lib/cor/prefill.test.ts` reproduces the
  Woodland June inventory from an anchor + June flow netting to 4,062 via the
  balance function's own semantics (fixture math documented in the test).

**Decision recorded (D2.3 config choice):** implemented as a **simple site-scoped
config row** (`cor_site_config`), NOT a `state_program_rules`-style effective-dated
table — the signer is a single standing fact per site. Seeded Woodland with
Rick Albritton / "Transportation Manager"; the title is **flagged TBC with MRC**
(`docs/QUESTIONS.md` Q-5) and is a one-row edit to confirm.

**Reconcile placement:** the ADR-0033-style tripwire runs in BOTH `finalizeCor`
(never freeze a stale draft) and `generateCorPdf` (never render/store a figure
that disagrees with the ledger) — refusing with both numbers on either path.

## Amendment — 2026-07-18 (mid-month COR; rollup §4.1 + §8.4 + §9.2)

The COR form (Exhibit 5, `Scan_084.pdf`) is filed for BOTH the end-of-month close
AND a mid-month period. Rick files the mid-month version with the **Inventory, FT
worker count, and PT worker count fields BLANK** (Signature + Date populated by
hand). This amendment teaches the generator that second shape without weakening the
end-of-month path. Ships with migration `20260726_adr0042_midmonth_cor` (purely
additive: one new enum + one defaulted column + one NOT-NULL widening — safe on the
populated prod table, replays clean on empty PG16).

### A1 — `period` discriminator + nullable inventory

- New enum `CorPeriod { end_of_month, mid_month }` and column
  `cor_certificates.period CorPeriod NOT NULL DEFAULT 'end_of_month'`. The DEFAULT
  backfills every existing row and every existing caller to `end_of_month`, so all
  current behavior (tripwire + capacity banner + required FT/PT) is byte-for-byte
  preserved.
- `inventory_units` is WIDENED to nullable (`Int?`). A mid-month certificate has NO
  inventory figure — it stores `NULL`, never a placeholder `0`. `inventory_source`
  stays `NOT NULL` and carries a typed marker (`mid_month_blank_adr0042_amendment`)
  so provenance is honest ("filed blank; reported at month end"), not fabricated.

### A2 — the mid-month fork (EOM path untouched)

- **Prefill (`prefill.ts`)** short-circuits BEFORE any balance/close query for
  `mid_month`: inventory `null`, FT/PT `null`, both provenance blobs a marker, and
  only the signer resolves (the mid-month form is still signed by hand).
- **Reconcile (`assertCorInventoryReconciles`)** is **end-of-month only** — a
  mid-month cert has nothing to reconcile, so it returns a passing `skipped` result
  and never queries the ledger or throws. The EOM tripwire is hard-enforced exactly
  as before (in BOTH `finalizeCor` and `generateCorPdf`).
- **Finalize (`finalizeCor`)** requires the FT/PT split ONLY for `end_of_month`; a
  mid-month cert finalizes with FT/PT blank by design. The EOM headcount gate is
  unchanged.
- **Render (`/internal/cor-pdf/[id]`)** prints the inventory, FT, PT, and total
  fields **literally blank** for `mid_month` (no value, no em-dash, no `0`/`N/A` —
  matching Rick's hand-filed form), suppresses the running-balance note, and labels
  the certificate "Mid-month filing". The EOM render is unchanged.
- **Capacity banner (D4)** is **end-of-month only** — a mid-month cert has no
  inventory to grade, so the banner does not render.

### A3 — period-scoped version chain

The immutable-version chain (D1) is scoped BY period: a mid-month and an
end-of-month certificate for the **same** `cover_month` are independent chains and
never void one another or share a version counter. `generateCorDraft`'s
void-prior-draft + next-version queries and `getCorDetail`'s prior-version lookup
all filter on `(site_id, cover_month, period)`. Supersede stays in the same period
chain as the certificate it corrects.

### A4 — the 3,977 fixtures (§9.2)

The ADR-0042 COR fixtures asserted the **stale 4,062**. ADR-0037's amendment
corrected the June close to **3,977 (3,748 program + 229 non-program)** (the raw
DAY grid double-counted DAY23's `NP` row). All COR fixtures are updated to 3,977;
the pre-fill fixture (`prefill.test.ts`) now reproduces it through the D6 running
balance using the SAME authoritative Processed-ledger totals as the §2.3 close
(open 1,423 + inbound 19,451 program / 229 non-program − stripped 17,126), so the
COR acceptance fixture cross-validates `onHand` against `computeInventoryClose`.
The mid-month path has no inventory and therefore no such fixture.

### A5 — signer title confirmed unchanged

The seeded signer title "Transportation Manager" (Richard Albritton) is confirmed
correct and unchanged by this amendment (still flagged TBC with MRC per Q-5; a
confirmation remains a one-row `cor_site_config` edit).
