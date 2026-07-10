# 2026-07-09 — Full rollup: Mary + Morena responses, July + Terex + Eugene analysis, file fetch plan

**Session context (Claude ↔ Bill, ~2026-07-09 07:00–18:20 UTC):**
- Mary Scott submitted her survey response 2026-07-07; auto-close fired
- Morena replied to the DR3.Dispatch@svdp.us scoping question
- July daily-log workbook arrived; Terex history arrived; Eugene sample arrived
- All materials analyzed in the Claude sandbox; findings + parser fixtures below
- **Bill requested no manual scp** — solved by defining three fetch runbooks in §7; Claude Code picks whichever Bill enables

**Supersedes / consolidates:**
- PR #87 (`2026-07-09-june-workbook-terex-file-analysis-for-adr-0048-par.md`) — June + Terex analysis (still valid, expanded here)
- Draft handoffs discussed in-chat but not pushed due to unarmed ClaudeSync window: Eugene form, Mary implications, July shape

---

## §0 — Executive summary

Two survey responses landed with real build implications. Two more workbooks confirmed the parser's structural assumptions and revealed one variation. One Eugene sample proved the site uses paper, not workbooks. One dispatch scoping reply broadened the ADR-0046-adjacent dispatch integration's understood scope.

**Concrete build shifts** (each expanded below):
1. **Mary needs a read-only billing verification view** hooked into ADR-0039's audit findings. Small addition; her current happy path stays untouched.
2. **ADR-0041 EOM invoice output must model the GP `Trade discount` field explicitly** — not as a total-dollar line, as an itemized reduction showing the mid-month bill being subtracted from month total.
3. **ADR-0041 needs two correction paths**, not one: credit memo AND void-and-reissue.
4. **ADR-0046 scope extends to outgoing AP** (stewardship fee payments Mary books), not just incoming vendor invoice approval.
5. **ADR-0049 parser resolves tabs by row-2 section labels**, not sheet names — July confirmed name convention drifts between months.
6. **ADR-0049 workbook_sources config for Eugene = null** (no workbook, paper only). Eugene iPad UI mirrors the paper form field order.
7. **Dispatch integration ADR** (draft-only right now) covers three email types not one: non-program hauls, reusable requests, MRC event requests. Plus a parked "verbal capture" surface for phone/text.

**Structural discoveries:**
- June/July DAY6 both have the 9th commodity block (cotton) — the "×5 quirk" is a permanent template feature, not an anomaly
- VBA analysis: 41 modules extracted, all Kelsey's template-copier variants, zero business logic
- Row-3 headers rule confirmed across both months on category tabs

---

## §1 — Mary Scott's response (full text + implications)

**Submitted:** 2026-07-07 19:29 UTC via operator-assist? No — she submitted her own (previous survey session's Kelsey-was-op-assisted note doesn't apply here). Auto-close fired 3 minutes later.

**Full response** at `docs/operations-intel/dr3-intel-2026-06/mary-scott.md`. Highlights below are direct quotes then translated.

### §1.1 — Her workflow

> Rick sends me a report with all the information already formatted in a way that it says exactly what I need to put on the invoice. I do not need to try to pull anything it is all presented much like an invoice itself. One report or invoice for each part of the billing.

**Translation:** Mary is a downstream consumer, not a data producer. She trusts what Rick sends. She does not validate. This is fine for the current process; she has no time to validate anyway.

**Build implication:** Don't force her into the pipeline. Vision preserves the Rick→Mary handoff. But — provide an *optional* verification view for when something looks wrong.

### §1.2 — Her single pain point

> Miss count in units or a location missed. This is in the reporting side that I do not see.

**Translation:** Errors originate upstream (Rick's reporting) and she can't audit them. When MRC pushes back, she has to loop back to Rick, who has to check his own numbers.

**Build implication:** Mary needs read access to ADR-0039 three-way audit findings **filtered to the invoicing surface** — a "billing verification" page at `/admin/billing/verify` that shows:
- Current mid-month or EOM invoice ready for GP entry
- Any audit findings from the three-way sweep (Vision-captured vs MyMRC mirror vs workbook mirror, per ADR-0037/0038/0039/0049) that touch the invoice line items
- Green light if no findings; yellow if unresolved findings; red if a hard variance

She uses this **before typing into GP** to catch the "location missed" or "miscount" issues Rick can't see from his side.

New role permission: `can_view_billing_verify` — granted to Mary (and Bill by default). Not `can_manage_billing` — she reads, doesn't act.

### §1.3 — Her GP invoice structure

> on our GP invoices we use a field on the invoice called Trade discount that shows the Mid-month billing on the end of month invoice. This will show the total number of units processed for the month and then shows the mid month number pulled from the total and then the balance due for the month at the bottom of the invoice.

**Translation:** The GP EOM invoice has a specific line structure:
- Total units processed for the month × rate = Gross month total
- Trade discount line = the mid-month bill (already invoiced separately)
- Balance due at bottom = Gross month total − Trade discount

**Build implication:** ADR-0041's EOM invoice output must generate this three-line structure explicitly. Not `total_amount_due = 12345`. Rather:

```
gross_month_total_units:      3,208
gross_month_total_rate:       $10.00
gross_month_total:            $32,080.00
trade_discount_desc:          "Mid-month billing (invoice CA-2026-07-MID)"
trade_discount_amount:        -$16,140.00
balance_due:                  $15,940.00
```

Mary types line-by-line into the GP EOM invoice, matching field names ("Trade discount" is the actual GP field). If Vision hands her a lump-sum total instead, she has to do the subtraction herself — which is exactly the class of error she flagged in §1.2.

**Schema addition to `invoices` table:** `trade_discount_cents` (nullable, only populated on EOM invoices), `trade_discount_reference_invoice_id` (FK to the mid-month invoice being subtracted).

### §1.4 — Corrections (two paths, not one)

> If we have an error in number of units billed or some other part of the program that creates a need to add to the bill, we need to void the invoice and reissue. If we have over billed in error, we sometimes can do a credit memo and apply it if they are okay with that if not, we have to void the invoice and reissue.

**Translation:**
- Under-billed → void and reissue (single path)
- Over-billed → credit memo, IF MRC agrees. If not: void and reissue.

**Build implication:** ADR-0041's amendment lifecycle needs two mechanisms:
1. `void_and_reissue`: invoice status → `voided`; new invoice generated; both linked via `superseded_by_invoice_id`
2. `credit_memo`: separate `credit_memos` table with a link back to the original invoice, and a flag `applied_at` when Mary confirms MRC accepted the credit

The amendment ADR (0028/0029) covers bonus amendments. Invoice amendment is architecturally different — MRC's acceptance is required for credit memo path, so amendments cannot be admin-side unilateral. Add a state machine: `proposed` → `sent_to_mrc` → `accepted` | `rejected` → `applied` | `void_and_reissue_triggered`.

### §1.5 — Close cadence (validated)

> MRC Cal is billed 16 thru 18 if there is a weekend involved. Rick cut off at End of day on the 15th. As soon as he has all the uploads, he sends the info to me, and I bill as soon as I get it.
> End of month billing for both Cal and OR are done the 1st thru the 5th depending on the weekend.

**Cadence for reporting:**
- CA mid-month cutoff: EOD 15th; billed 16–18 based on weekend
- CA + OR EOM: 1st–5th

**Delays she flagged:** "when email is an issue or if I do not see the email because I am out or doing something else at the time."

**Build implication for ADR-0045 digest routing:** Mary's queue notification for a ready-to-bill invoice should send via BOTH email AND a notification surface she checks even when out (SMS? Slack? — she didn't specify, defer to Bill). Loud alerts in ntfy for Bill AND Mary when the invoice is generated.

### §1.6 — Beyond MRC invoices (ADR-0046 scope broadens)

> I only make the invoices. I also will make and book the AP payment for the stewardship fees as well.

**Translation:** Mary also books AP payments for **stewardship fees** (the fees DR3 pays MRC per SB 254 stewardship program? Or the fees MRC pays TO stewardship program? Ambiguous — needs Bill or Mary follow-up).

**Build implication:** ADR-0046 was originally scoped as *incoming* vendor invoice approvals. Mary's role also covers *outgoing* AP payment bookings — a different flow. Two paths:
- Incoming invoice → Vision routes for approval → decision emailed back → Mary types into GP as AP invoice for a vendor
- Outgoing payment obligation (stewardship) → Mary books an AP payment in GP → sends to vendor

These are related but distinct. ADR-0046 explicitly stays in the incoming lane; **new ADR-0051 (proposed) covers outgoing AP payment booking** as a Mary-facing surface post-cutover.

### §1.7 — What she flagged as missing

> communication is the Key to success and the more we have the better.

Soft. Reinforces ADR-0047's notifyStaff pattern (staff know what's happening) but doesn't translate to a specific feature.

---

## §2 — Morena's response (dispatch scoping)

**Verbatim (from chat, forwarded by Bill):**

> Thank you for explaining. I understand better now what you need.
> For California, most of the non-program units come through Outlook. Those are the emails I check every morning because I use them for dispatch, scheduling, and follow-up. Also, reusable requests usually come through Outlook too.
> For regular MRC sites, most of those are handled through the MyMRC portal now. The exception is when there is an MRC event or special request. Those still usually come through email because the MRC coordinator sends the request that way.
> Also, some non-program sites do not send emails through Outlook. Some of them call me or text me directly when they need a swap. That is also part of what I have to track manually and then add into dispatch.
> I will look for two or three recent examples of each type and forward them to you so you can see how the emails look and how the information is coming to me.

### §2.1 — Three email categories at `DR3.Dispatch@svdp.us`

1. **Non-program haul requests** (California majority — Morena's morning check)
2. **Reusable requests** (mattress reusability program)
3. **MRC event / special request** (regular program hauls stay in MyMRC portal per ADR-0038; only exceptional events come via email)

### §2.2 — Non-email channel (parked)

Some non-program sites contact Morena via phone/text for swap requests. She logs manually today. This is a real capture gap — email-focused integration can't touch it.

**Build implication:** parked ADR-0052 (proposed) — a "quick verbal capture" surface for Morena. Simple form: source (dropdown), date, load type, notes, `source_channel='verbal'`. Post-cutover.

### §2.3 — Dispatch integration ADR shape

Now clearly scoped as three parser paths, not one. Parser classification signals TBD until Morena forwards examples (in flight). Waiting on her examples before ADR draft.

**Parked as ADR-0050-dispatch-integration** (proposed). Blocked on Morena's examples. Independent of Stage 5 cutover.

---

## §3 — July workbook analysis (adds to June findings from PR #87)

Structural stability confirmed. **One variance requires parser adjustment.**

### §3.1 — Structural stability (matches June)

- 47 sheets total (same as June)
- Same category tab / DAY sheet split (15 category + 32 DAY)
- DAY6 still has the 75-column cotton block → **the "×5 quirk" is a permanent template feature, not a June anomaly**. Cotton is in the daily-log-9 taxonomy for all months.
- All simple-shape sheets identical dimensions (Container Rentals, Events, Fuel, Summary, Trans Summary, list, variables)

### §3.2 — Variance: category tab names dropped month prefix

Naming convention shifted between June and July:

| June name | July name |
|---|---|
| `June26 Commodities` | `Commodities` |
| `June26 inb trans charges` | `inb trans charges` |
| `June26 inb no trans charge` | `inb no trans charge` |
| `June26 incentive_unpaid` | `incentive_unpaid` |
| `June26 Processed` | `Processed` |
| `June2026 Renovation` | `Renovation` |
| `June2026All` | `July2026All` (kept full prefix) |

**Parser implication:** Do NOT resolve tabs by sheet name pattern. Instead, resolve by **row-2 section labels** — the string in row 2 (e.g. `"INBOUND WITH TRANS CHARGE - Woodland"`, `"TRASH - Woodland"`) is stable across months.

Add `worksheet_semantic_type` inference: parser iterates all sheets, reads row 2, matches against a lookup of known section-label patterns. This works for both June and July naming and is durable if Kelsey drifts naming further.

### §3.3 — DAY sheet row-count minor drift

- June DAY17–29: 253 rows each
- July DAY17–29: 252 rows each

Blank-row delta of ±1 at the bottom of the template. Not concerning. Parser ignores rows where all key cells are null.

---

## §4 — Eugene daily log format (paper, not workbook)

### §4.1 — File: `06012026163022_17.pdf`

Single-page scanned image of a hand-filled paper form. Filename convention: `MMDDYYYYHHmmss_seq.pdf` → captured 6/1/2026 at 16:30:22 UTC as sequence 17. Rick scans forms after they're filled in and uploads sequentially.

### §4.2 — Eugene = paper, no workbook

**Rick's stakeholder-questions registry entry answered definitively:** Eugene does NOT have a shared daily-log workbook to sync via ADR-0049. Rick uses printed paper forms filled by hand.

**Implications:**
- `workbook_sources` config table has ONE row (Woodland). Eugene explicitly excluded with a comment.
- ADR-0048 Eugene backfill via workbook parser is impossible; alternatives in §4.4
- 7/20 Eugene iPad rollout is architecturally simpler — no legacy workbook to migrate, no shadow-billing bridge, no cutover parity gate for a spreadsheet. Rick's operators go direct paper → iPad.
- Cutover parity check for Eugene reduces to: "does Vision's July Eugene ledger match Rick's paper forms for the same period?" — a manual check, not a full-month automated audit.

### §4.3 — Eugene form schema (captured from sample)

**Header:** `DR3-Eugene / SHIPMENT/LOGIN SHEET / YEAR: 2026` (pre-printed)

**Table columns (printed order, L→R):**

| # | Column | Type | Notes |
|---|---|---|---|
| 1 | Date | date | Handwritten, format `M/D/YY` |
| 2 | Site | free-text | Sample: `Glenwood TC 143`, `Illegal Drop`, `Glenwood TC 144`, `Sponsors`, `Thompsons Sanitary Service`, `Stayton Comm Center`, `Deschutes`, `Glenwood` |
| 3 | # of incoming units | int | Handwritten |
| 4 | # of outbound Units | int? | Blank in sample |
| 5 | lbs. (55 per unit) | int (computed) | Blank — implicit `incoming × 55` |
| 6 | Third party Bol# | text? | Blank in sample |
| 7 | Dr3 # | 6-digit int | Format `######` (Woodland uses 4-digit, Eugene uses 6-digit — different sequences) |
| 8 | Haul Record # | `H-######` | Same `H-` prefix as Woodland (MyMRC assigns tenant-wide) |
| 9 | For Office Use Only | enum | `Trans` (has trans charge) or `in` (inbound to inventory) |

**Summary section (bottom):** Ending inventory, # employees, # processors, INBOUND, Processed, Whole Units Sold, Landfilled, AUTHORIZED SIGNATURE (Rick's `M-#####` ticket ID, not a legal signature).

### §4.4 — Eugene Jun 24-30 backfill (open decision)

**Option A** — Rick bulk-scans 6/24–6/30 (7 pages), Bill forwards, Vision team manually transcribes into CSV matching `WorkbookImportRow` shape.

**Option B** — Small Vision admin surface `/admin/backfill/eugene-paper` — form-shaped input page for someone to key in each paper form; emits same `WorkbookImportRow` records; `source_channel='paper_backfill'`. ~1 day build. Runbook `docs/operator/paper-backfill.md`.

**Option C (recommended)** — Skip Eugene June backfill entirely. Eugene doesn't have Woodland's billing complexity (no trans charges, no commodity blocks, no rate variance). June backfill's primary purpose is Woodland shadow-billing parity. Rick's 7/20 iPad go-live starts a clean forward-only ledger.

**Bill's disposition needed.** Assumes C unless Bill flags otherwise.

### §4.5 — Eugene iPad UI (design signal)

Vision's Eugene operator UI should mirror the paper form field order exactly (§4.3 column order). Muscle memory carries over. Woodland gets a richer multi-section UI (per PR #87 §1.2); Eugene gets a single-section UI matching this paper form. Both feed the same `inbound_loads` table.

---

## §5 — Sample data for parser fixtures (real bytes)

Small samples (~9KB JSON) extracted from June + July + Terex files. Sufficient to write parser unit tests against real data without needing the full workbooks. Structure: `{sheet_key: {sheet, header_row, sample_rows, label}}`.

```json
{
  "june_inb_trans": {
    "sheet": "June2026 inb trans charges",
    "header_row": 3,
    "sample_rows": [
      ["2026-06-19T00:00:00", "Bass Hill Landfill - LRSWMA", 52, 2860, null, 4763, 130971, 1450, 181, "Primary (1st)", 46, 169.13753846153847, 1619.1375384615385],
      ["2026-06-18T00:00:00", "GVCC - Stockton Yard", 27, 1485, null, 4746, 131732, 425, 5, "Primary (1st)", 554, 4.672307692307692, 429.6723076923077],
      ["2026-06-18T00:00:00", "Humboldt Waste Management Authority (HWMA)", 106, 5830, null, 4742, 131365, 2000, 271, "Primary (1st)", 34, 253.23907692307694, 2253.239076923077],
      ["2026-06-18T00:00:00", "Recology of the Coast - Pacifica", 70, 3850, null, 4738, 131446, 925, 59, "Primary (1st)", 330, 55.133230769230764, 980.1332307692307]
    ],
    "label": "inbound WITH trans charge sample - Woodland",
    "columns": ["Date", "Site", "inbound unit #", "LBS. (55 per Unit)", "BOL # or Check #", "DR3 #", "Haul #", "Freight Rate", "Mileage", "Mileage_Table.Assignment", "ID", "Fuel Surcharge", "Total"]
  },
  "june_nonprogram": {
    "sheet": "NonProgram",
    "header_row": 2,
    "sample_rows": [
      ["2026-06-29T00:00:00", "Petaluma", "inbound units", 100, 5500, null, null, null, null, "NP"]
    ],
    "columns": ["Date", "Site", "commodity", "inbound unit #", "LBS. (55 per Unit)", "BOL # or Check #", "DR3 #", "Haul #", "Office Use Only", "trans charge"]
  },
  "june_fuel": {
    "sheet": "Fuel",
    "header_row": 2,
    "sample_rows": [
      ["2026-03-02T00:00:00", "2026-03-08T00:00:00", 4.534],
      ["2026-03-09T00:00:00", "2026-03-15T00:00:00", 5.556],
      ["2026-03-16T00:00:00", "2026-03-22T00:00:00", 5.856],
      ["2026-03-23T00:00:00", "2026-03-29T00:00:00", 6.31]
    ],
    "columns": ["Begin Date", "End Date", "Price per Gallon"],
    "label": "EIA PADD-5 weekly diesel prices (feeds ADR-0040 fuel surcharge)"
  },
  "june_variables": {
    "sheet": "variables",
    "header_row": 1,
    "sample_rows": [
      ["Bass Hill Landfill - LRSWMA", 46, "Bass Hill Landfill, 469-700 Johnsonville Dump Rd., Susanville, CA 96130", "DR3 Woodland", null, "Primary (1st)", null, "Bass Hill Landfill - LRSWMA", "DR3 Woodland", 1450, 181, "Primary (1st)", 46, 500],
      ["Bay Counties SMART Station", 139, "Bay Counties SMART Station, 301 Carl Rd. Sunnyvale", "DR3 - Livermore", null, "Secondary (2nd)", null, "Bay Counties SMART Station", "DR3 Stockton", 600, 32, "Primary (1st)", 139, 250],
      ["Big Oak Flat (Groveland) Transfer Station - County of Tuolumne", 175, "Big Oak Flat (Groveland) Transfer Station, 10700 Merrell Rd, Big Oak Flat, CA 95321", "DR3 Stockton", null, "Tertiary (3rd)", null, "Big Oak Flat (Groveland) Transfer Station - County of Tuolumne", "DR3 Stockton", 925, 73, "Primary (1st)", 175, 250],
      ["Black Butte Transfer Station", 793, "Black Butte Transfer Station, 3710 Springhill Rd., Mt. Shasta", null, null, null, null, "Black Butte Transfer Station", "DR3 Woodland", 2000, 201, "Primary (1st)", 793, 250]
    ],
    "label": "source master: Re-Trac ID + haul rate lookup. Confirms Kelsey Q3: Re-Trac ID = account ID (col 14 label 'Re-Trac Random ID'). Also confirms columns 10-11 = Haul Rate + Mileage."
  },
  "june_day6_cotton": {
    "sheet": "DAY6",
    "header_row": 51,
    "extra_cols": "68-75 (permanent template feature)",
    "sample_rows": [
      ["Date", "Site", "Commodity", "Weight", "BOL# or Check #", "DR3#", "Haul#", "revenue"],
      ["no entries found", null, null, null, null, null, null, null]
    ],
    "label": "DAY6 uniquely has 9th commodity block (COTTON) at cols 68-75. Present in both June AND July — confirms permanent template. Kelsey's 'x5' formula-level note still needs her walkthrough."
  },
  "july_inb_trans": {
    "sheet": "inb trans charges",
    "header_row": 3,
    "sample_rows": [
      ["2026-07-07T00:00:00", "Bass Hill Landfill - LRSWMA", 51, 2805, null, 4213, 130973, 1450, 181, "Primary (1st)", 46, 0, 1450],
      ["2026-07-03T00:00:00", "Guerneville Transfer Station", 95, 5225, null, 4178, 133193, 1450, 112, "Primary (1st)", 328, 95.2516923076923, 1545.2516923076923],
      ["2026-07-03T00:00:00", "Happy Camp Transfer Station - George M. Chambers", 79, 4345, null, 4177, 133012, 2500, 309, "Primary (1st)", 811, 262.7926153846154, 2762.7926153846156]
    ],
    "label": "July equivalent tab. Note tab name dropped month prefix — parser must resolve by row-2 section label instead of sheet name."
  },
  "terex_jun26": {
    "sheet": "Jun26",
    "header_row": 2,
    "sample_rows": [
      [1, 168, null, null, 2306.75, 2315.45, 8.699999999999818, 19.31034482758661, "Tim", "G", "orange rubber is shredding"],
      [2, 152, null, null, 2315.45, 2323.4, 7.950000000000273, 19.119496855345254, "Tim", "G", "orange rubber is shredding"],
      [3, 168, null, null, 2323.4, 2331.85, 8.449999999999818, 19.881656804734156, "Tim", "G", "orange rubber is shredding"]
    ],
    "columns": ["Day", "Pocket coil", "Springs", "Wood", "Start Hours", "End Hours", "Day Total Hrs Used", "Units per hour", "Operator", "condition*", "Notes"]
  },
  "terex_maint_2026": {
    "sheet": "Maintenance Log2026",
    "header_row": 2,
    "sample_rows": [
      ["example", "October     10/9/2024", "11:52am", "dripping oil from the back", "called Jonathan at Powerscreen to request maintenance", "2 weeks", null, "Jonathan and said someone would be out tomorrow morning to fix it.  Fixed by 3:30pm on 10/10/2024", null, null]
    ],
    "columns": ["Year/section", "Date", "Time", "Issue", "Measures taken", "Estimated repair time", "Estimated cost", "Notes", "Actual Repair Cost", "Amount Credited"]
  },
  "terex_diesel": {
    "sheet": "diesel",
    "header_row": 3,
    "sample_rows": [
      ["2026-01-05T00:00:00", null, 33, null, null, null, null, null, null, null, null],
      ["2026-01-12T00:00:00", null, 27, 759, 0.03557312252964427, 3.43, 92.61, null, 7, 37.6, 1.3925925925925926],
      ["2026-01-14T00:00:00", null, 70, 374, 0.18716577540106952, 3.56, 249.20000000000002, null, 2, 12, 0.17142857142857143],
      ["2026-01-21T00:00:00", "x", 41, 813, 0.05043050430504305, 3.56, 145.96, null, 7, 28.95, 0.7060975609756097]
    ],
    "columns": ["Date", "DEF", "Gallons added", "Units processed", "gal/unit", "$/gal", "total $", "spacer", "days between fills", "run time per fill (hrs)", "hours/gal"]
  }
}
```

**Fixture use:** Save as `tests/fixtures/adr-0048/sample-rows.json`. Parser unit tests assert output against these known-good rows. Full-file promotion test blocked until files land per §7.

---

## §6 — VBA modules extracted (closes Kelsey B10-1 permanently)

41 modules total across both June and July workbooks. Confirmed contents (June inspection; July identical based on file structure):

**Business logic: none.** Only three procedures exist, all variations of `CreateDailySheets_February` — copy TEMPLATE sheet 28 times to create daily sheets for a month.

- `Module1.CreateDailySheets_February` (original, minimal)
- `Module2.CreateDailySheets_February_SAFE` (adds ScreenUpdating suppression + table name collision resolution)
- Numerous `Sheet##.cls` copies of the SAFE version (harmless duplicates from macro re-runs)

**Kelsey B10-1 answered permanently.** No freight, consolidation, billing, or reporting logic in VBA. All macros are template utility. **Nothing to replicate in Vision.**

Kelsey capture list drops from 7 items to 5 (B10-1 answered; B10-3 structural quirk answered in PR #87; formula-level `×5` still needs her). Remaining 5 items unchanged.

---

## §7 — File fetch options for Claude Code (Bill picks one)

**Reality:** The Claude analysis sandbox has network egress restricted (0x0.st, transfer.sh, file.io all timeout/error), no git/cloud credentials, and each 700 KB workbook expands to ~230K tokens of base64 — exceeding any single-turn output limit. So the ~2 MB of raw binaries cannot be teleported through my context.

**But** the parser can be built entirely against §5 fixtures + this handoff's shape docs. Full-file promotion (ADR-0048 D4) runs after files land via one of three methods below. Claude Code picks whichever Bill enables.

### §7.1 — Option A: rclone from Bill's Google Drive (my recommendation)

Prerequisites (one-time on titan):
```bash
# On titan (SSH: bbarnard065@10.99.0.2)
sudo apt-get install -y rclone
rclone config  # authenticate Bill's Google account; call remote "gdrive"
```

Bill drops the four files into a Google Drive folder named `DR3-Vision fixtures 2026-07-09`. Any Drive folder Bill has works.

Then in Claude Code:
```bash
mkdir -p ~/DR3-Vision/tests/fixtures/adr-0048
rclone copy "gdrive:DR3-Vision fixtures 2026-07-09/" ~/DR3-Vision/tests/fixtures/adr-0048/
# verify (checksums in §7.4)
cd ~/DR3-Vision/tests/fixtures/adr-0048
sha256sum JUNE_2026_DAILY_LOG_WOODLAND.xlsm JULY_2026_DAILY_LOG_WOODLAND.xlsm TEREX.xlsx 06012026163022_17.pdf
```

Pros: reusable for future monthly workbooks; Bill just drops each new month's `.xlsm` into the same folder.
Cons: one-time rclone auth on titan.

### §7.2 — Option B: R2 via wrangler (if Vision R2 creds are on titan)

Bill uploads to Vision's existing R2 bucket via wrangler from HIS laptop OR the app's own upload path (whichever is easier). Then Claude Code:
```bash
mkdir -p ~/DR3-Vision/tests/fixtures/adr-0048
cd ~/DR3-Vision/tests/fixtures/adr-0048
wrangler r2 object get vision/fixtures/adr-0048/JUNE_2026_DAILY_LOG_WOODLAND.xlsm --file=JUNE_2026_DAILY_LOG_WOODLAND.xlsm
wrangler r2 object get vision/fixtures/adr-0048/JULY_2026_DAILY_LOG_WOODLAND.xlsm --file=JULY_2026_DAILY_LOG_WOODLAND.xlsm
wrangler r2 object get vision/fixtures/adr-0048/TEREX.xlsx --file=TEREX.xlsx
wrangler r2 object get vision/fixtures/adr-0048/06012026163022_17.pdf --file=06012026163022_17.pdf
```

Pros: uses existing Vision infra; matches where ADR-0049's R2 archival lives anyway.
Cons: Bill still uploads once. Same effort as SCP, arguably.

### §7.3 — Option C: direct base64 in Vision admin (workbook upload path already exists per ADR-0048)

ADR-0048 already has `/admin/audit/workbook` for `.xlsm` upload → staging → promotion. Bill uploads June + July via that path from his browser. Terex + Eugene PDF go through `/admin/equipment/import` and `/admin/backfill/eugene-paper` respectively (paper backfill route is Option B of §4.4 if Bill green-lights).

Pros: no filesystem staging on titan needed; runs against Vision's normal input pipeline.
Cons: parser needs to be already deployed to Vision; not useful for Claude Code development iteration.

### §7.4 — Verification checksums

Regardless of transport method:
```
301fcc2cdd629f0c7ed1df004e8f6e8f0e8ca8c609cf52b7c990c3daf69f0a33  JUNE_2026_DAILY_LOG_WOODLAND.xlsm
4287392ca48f86f79953688314a677a2c737f7a8287064786f2f6d7fbc988f13  JULY_2026_DAILY_LOG_WOODLAND.xlsm
13704f754ebeb5918690354227e3b21465e8b843de1d685add86f3b0b473c383  TEREX.xlsx
87e6f4e89210fb96198349215109498036973a08356558884b84dbe388cbe10f  06012026163022_17.pdf
```

Claude Code verifies after transfer. Any mismatch = re-fetch.

---

## §8 — Consolidated build queue

Reordered by dependencies + urgency.

### §8.1 — Ships without files (build now)

1. **Row-2 section label resolver** for ADR-0049 workbook parser — replaces sheet-name matching. Enables both June and July shape reading without name-pattern maintenance.
2. **Cotton commodity** added to Addendum B `daily-log-9` taxonomy explicitly — parser expects the 9th block on DAY6.
3. **ADR-0041 EOM invoice structure** — schema addition for `trade_discount_cents` + `trade_discount_reference_invoice_id`; render logic outputs three-line structure per §1.3.
4. **ADR-0041 correction paths** — void_and_reissue + credit_memo state machine per §1.4.
5. **Billing verification view** for Mary — read-only `/admin/billing/verify` per §1.2. New role `can_view_billing_verify`.
6. **`workbook_sources` config table** — one row for Woodland; Eugene explicitly `null` with comment (§4).
7. **Fixture-based parser unit tests** — use §5 sample rows.

### §8.2 — Ships once files land (via one of §7 methods)

8. ADR-0048 D4 promotion (June + July + Terex) against real bytes.
9. Full-file parser fuzzing (catch edge cases beyond the §5 samples).
10. Woodland close-balance assertion (June-end = 4062).

### §8.3 — Pending stakeholder input

11. Morena's 2-3 example emails per type (§2.3) → ADR-0050 dispatch integration draft.
12. Kelsey walkthrough for `saved_units` semantics, DAY6 `×5` formula, `%` column on Steel/Biomass/WTE, event units as inbound, MRC contact map (5 remaining items — down from 7).
13. Bill's disposition on Eugene backfill Option A/B/C (§4.4).
14. Bill's disposition on Mary's stewardship-fee AP path — new ADR-0051 outgoing AP payment booking?

---

## §9 — Blocker list, final state

Pre-Stage-1 remaining:

1. `RESTIC_PASSWORD` 1Password confirmation (P1-4) — 1Password automation integrated with next handoff (per Bill's earlier direction).
2. File transfer method (§7) — Bill picks A/B/C.
3. Kelsey walkthrough scheduling (5 items).

Nothing else blocks. Stage 0 can exit as soon as (1) and (3) resolve. (2) is a soft blocker — parser + tests + non-workbook build items proceed independently.

---

## §10 — Actions for Bill (when back)

1. Pick a file-transfer method from §7. If Option A: `rclone config` once on titan; drop files in the Drive folder. Estimated 5 minutes total.
2. Green-light Eugene backfill Option A/B/C (§4.4). Recommended: C.
3. Answer new question: does Mary's "stewardship fee AP payment booking" warrant its own Vision surface (ADR-0051 proposed)? Or leave in GP only?
4. Kelsey walkthrough scheduling — 5 items remaining before 8/1.

## §11 — Actions for Claude Code

Reference this handoff by filename. Execute §8.1 (ships-without-files) build queue. Fixture at §5, checksums at §7.4. When files arrive, run §8.2. Track §8.3 as external dependencies.

Small tactical items:
- Update ADR-0037 Addendum B: cotton confirmed permanent, not DAY6-only anomaly
- Update PR #87 §3.2 note: "×5 quirk" is structural (cotton block); formula-level `×5` still open for Kelsey
- Amend ADR-0046 draft: add note that Mary also books outgoing stewardship fee AP payments (§1.6) — flag as new ADR-0051 candidate rather than expanding ADR-0046 scope
- Amend ADR-0041 draft: add §D-review items for Trade discount field + credit_memo state machine
- Amend ADR-0039: expose findings via read-only view for `can_view_billing_verify` role
- Confirm `sources` seed includes Eugene sites captured in PR #87 §5.4

---

## §12 — Session close

All new information as of 2026-07-09 18:20 UTC is captured above. Bill's earlier disposition on the ~2 MB file transfer is now three concrete options — he picks whichever is least friction. Parser build starts immediately.
