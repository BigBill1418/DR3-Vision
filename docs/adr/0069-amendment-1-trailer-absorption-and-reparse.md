# ADR-0069 Amendment 1 — the first absorbed document kind, and a re-parse action

**Status:** accepted, implemented (2026-07-31)
**Closes:** absorption-audit Fix 3, and the gap left open by ADR-0067 Am.8.

## 1. Two problems, one amendment

**Fix 3 was left specified, not shipped, in ADR-0067 Am.8** because reading the
real files showed the handoff's recommended target was wrong. This amendment
ships it against the right one.

**Am.8's header fix could not reach the documents already in the system.**
`parse_summary` is computed at PARSE time, and a parse only happens when a new
revision arrives. The three documents waiting since 2026-07-29 kept their old
summaries — headers still reading `["Woodland Trailer List 2025"]` — and would
have kept them until somebody happened to edit the file in OneDrive. **A code fix
that reaches the data only by luck is not a fix.**

## 2. Why the trailer list, and not the commodity tracker

The handoff nominated the commodity-audit tracker, on the grounds that it
reconciles commodity data against vendor invoices. Reading the actual file
(pulled from R2) showed it does not contain that. It is banded — title row,
commodity band (`METAL | WOOD | TOPPERS | FOAM | TRASH | XTRACTION`), vendor
band — and its row-4 columns are `Audited | Initials | Date | 2nd Audit |
Initials | Date` repeating per commodity. **No weight, no amount, no invoice
number, no variance.** It records who checked, not the figures.

The trailer list is a real flat table with real operational data. It is the
honest first type.

## 3. What the real file forced

Measured across the live workbook's 96 populated rows:

| Observation                                                                                                                                                              | Consequence in the extractor                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Header on **row 2**, data starts in **column B** (column A entirely empty)                                                                                               | Columns resolved by MEANING, never position                                             |
| `"Driver "` (trailing space), `"Days in Yard\n(auto calc)"` (embedded newline)                                                                                           | Header matching normalises whitespace and case                                          |
| Weight is a number on 77 rows, **blank on 11**, and the literal **`"-"` on 6**                                                                                           | Blank and `-` both → **NULL, never 0**; the raw cell text is kept so `-` is recoverable |
| Entry date absent on 14 rows, exit date on 4 (+2 non-date strings)                                                                                                       | Absent is absent; a non-date exit is kept verbatim in `exit_raw`                        |
| `Days in Yard` is a **formula** cell                                                                                                                                     | Its cached result is stored as _what the sheet says_, never recomputed                  |
| Material is free text: `pocket coil` / `pocket coils` / `Pocketcoil`, `foam bales` / `Foam Bales` / `20 foam bales`, plus ORIGINS (`Recology SF`, `Novato`, `Red Bluff`) | Stored **verbatim**                                                                     |
| **28 rows** are blank spacers between blocks                                                                                                                             | A row with no trailer number is not a trailer                                           |

**Material is not normalised, and that is a decision, not an omission.**
Collapsing `Pocketcoil` into `pocket coil` invents a taxonomy nobody agreed to,
and mapping any of it to program/non-program would invent a billing fact. The
column is also used for origins as often as materials — a normaliser would have
to decide that `Recology SF` is a material, which it is not.

**Zeroing an unrecorded weight was the trap.** Nineteen of ninety-six rows have
no weight. Writing 0 would invent nineteen trailers weighing nothing and drag
every future average down with them — the same "a blank is not a zero" defect the
workbook-sync adapter had to be amended for (ADR-0049 Am.3 A1).

## 4. Verified against the real file

The extractor run against the actual R2 object:

```
headerRow: 2   rows: 96   skippedBlank: 28
weight null = 19 (6 of them the literal "-")
entryDate null = 14   exitDate null = 6
total weight = 723,051 lbs
```

Every figure reconciles with an independent profile of the same file taken before
the extractor existed (77 numeric + 11 blank + 6 dash + 2 non-numeric = 96).

## 5. The single-writer rule is intact

`doc_trailer_rows` is written **only** by the absorption bridge. It is reference
data: no operational read depends on it, and it touches neither
`processed_units_daily` (see the correction below) nor
`site_inventory_snapshots` nor any loads table.

Rows are keyed to the VERSION they came from rather than mutated in place, so a
re-ingest appends a new generation and the previous one stays readable. That is
what makes a re-ingest a comparison rather than a destructive overwrite.

**Money-touching absorption stays preview-then-confirm.** A trailer list carries
weights and dates, not amounts, so it lands directly. The moment TEREX is added
it takes the staged path — its columns are `Estimated cost`, `Actual Repair
Cost`, `Amount Credited`.

### Correction (2026-07-31) — "single writer" was overstated

This ADR shipped saying `processed_units_daily`'s "sole writer" is workbook-sync.
**That is wrong.** Three code paths write it — the super-admin entry route, the
MyMRC processed bridge, and workbook-sync — governed by a **precedence** rule
(`source = 'mymrc' AND closed_at IS NULL`), not by exclusivity.

The decision here is unaffected: `doc_trailer_rows` is its own table and no
operational read depends on it, so absorption adds no participant to that
precedence rule at all. But the justification was stated more strongly than the
code supports, and a rule quoted as absolute when it is conditional is the kind of
thing a future reader relies on and gets burned by.

The same overstatement is baked into the comment header of applied migration
`20260825_adr0069_am2_terex_absorption`. Applied migrations are checksum-locked
and must never be edited, so that comment stays wrong; this paragraph is the
correction of record.

## 6. The re-parse action

`POST /api/admin/doc-ingest/sources/[id]/reparse` re-derives `parse_summary` for
the newest APPLIED revision from the archived copy. Admin only.

What it deliberately does **not** do:

- **It does not create a revision.** The content has not changed; only our
  reading of it has. Minting one would claim Kelsey edited a file she did not
  touch, and would drag the delta machinery — guardrail comparison, anomaly
  staging, notifications — through a change that never happened.
- **It does not touch `ctag` / `etag`.** Amendment 6 makes those the content
  markers a delta may supply but never remove, and a missing one must recover or
  alarm rather than read as `unchanged`. Re-parsing is orthogonal to change
  detection and leaves it exactly as found.
- **It does not touch a STAGED revision.** A staged revision is waiting on a
  human decision; re-deriving its summary underneath that decision would change
  what is being decided about.
- **A parse failure does not overwrite a good summary with nothing** — it returns
  422 and leaves the stored summary alone.

What it _does_ change, stated plainly: the stored summary, which is also the
BASELINE the next guardrail comparison runs against. That is the point — the old
baseline was built from title strings, so its aggregate check was comparing
nothing. The audit row records the before/after header shape, so the change in
baseline is visible rather than silent.

## 7. Verification

28 new tests (14 extractor + 14 existing doc-ingest coverage extended); full
suite 4,110 passing. Every guard **falsified before being kept**:

| Break                                           | Went red |
| ----------------------------------------------- | -------- |
| a `-` weight becomes 0                          | ✅ 2     |
| columns resolved by POSITION instead of meaning | ✅ 12    |
| missing required columns no longer refuse       | ✅ 3     |
| blank spacer rows absorbed as trailers          | ✅ 2     |
| zero rows reported as a successful absorption   | ✅ 1     |
| material normalised instead of stored verbatim  | ✅ 1     |

The existing tripwire `expect([...ABSORBABLE_KINDS]).toEqual(['daily_log_workbook'])`
— written as "widening this set is a deliberate act" — **fired on this change,
exactly as intended.** It was updated to the new exact set rather than loosened
to `toContain`: adding a kind without adding its extractor and its typed table
must keep breaking a test.

## 8. What this does NOT close

- **TEREX and the commodity tracker are still unabsorbed.** TEREX is the natural
  next kind and needs the preview-then-confirm path because it carries costs. The
  commodity tracker needs a decision from Bill about whether "who audited which
  commodity band, and when" is worth absorbing at all — it is a compliance
  record, not a figure.
- **No comparison against Vision's own numbers yet.** The absorbed trailer rows
  are queryable and visible, which is what the audit asked for, but the natural
  comparison (material weight against outbound records) is a further step and
  would need Rick or Kelsey to confirm which outbound figures are the counterpart.
