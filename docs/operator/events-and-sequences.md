# Collection events, OR counts, and the DR3# counter (ADR-0041, capture half)

This is the operator/office guide for the ADR-0041 **capture** surfaces built into
DR3-Vision: collection-event entry, Oregon collection-site counts, and the
Vision-assigned **DR3#** document-number counter. Invoice generation itself is the
sibling half of ADR-0041 and is documented separately.

All three surfaces live on the manager **Loads & inventory** page
(`/dashboard/<site>/loads-inventory`) and are **admin-only** until the ADR-0037 D7
ops gates (restore drill + off-box backup key) close — the same activation gate as
the other loads/inventory record types.

---

## 1. Collection events (the daily-log "Events" tab)

**Where:** Loads & inventory → **Collection events** tab.

A collection event is a satellite/collection run the office bills as freight plus
labor. Enter one row per event with the date, customer, and (as available) county,
slip #, units, and the money fields.

### Wage defaults — entered vs. auto-filled

- Leave **Driver wages ($)** / **Labor wages ($)** blank and enter the **hours** —
  Vision fills the wage from the site's B5 rates:
  `driver wages = driver hours × driver hourly rate`,
  `labor wages = labor hours × general-labor hourly rate`
  (the rates live in the program rules: driver $125/hr, general labor $90/hr — see
  Addendum B5).
- **Type a wage and it is stored exactly as entered** — the default never overwrites
  a value you typed. Because both the hours and the wage are stored, any deviation
  from the default is derivable later (hours × rate vs. stored wage); Vision does not
  flag it — the office owns the number.
- If a site has **no wage rule** in force (e.g. an Oregon run), the auto-fill is
  simply skipped and the wage is left blank. Capture is never blocked; type the wage
  in directly.
- **Per diem** has no "nights" field to multiply, so it is always entered directly
  (the nightly rate is $275/night per B5 if you need to compute it by hand).

### Mileage — two columns, and which one bills

The workbook Events tab has a **Mileage** column. In Vision it splits into two:

| Field                  | Meaning                      | Bills?                                                         |
| ---------------------- | ---------------------------- | -------------------------------------------------------------- |
| **Mileage (mi)**       | miles driven — informational | No                                                             |
| **Mileage billed ($)** | the mileage dollar amount    | **Yes** — this is the value that feeds the invoice event total |

Per the §3.1 **B8** formula, an event's ancillary cost total is
`driver wages + labor wages + mileage + per diem + misc` — and "mileage" there is a
**dollar** amount, not a count. So **Mileage billed ($)** is the number that reaches
billing; **Mileage (mi)** is captured for reference only. (Freight is billed as its
own separate term — it is _not_ part of that five-term total.)

> Interpretation note for reviewers: the workbook's single "Mileage" column is
> dollars in the B8 sum. Vision captures both the informational miles and the billed
> dollars so nothing is lost; only the dollars bill.

Events are **edit-before-lock** — you can correct a row until it is locked, after
which it is read-only (an audit row is written for every insert and edit).

---

## 2. Oregon collection-site counts

**Where:** Loads & inventory → **OR collection counts** tab. **Eugene / Oregon only.**

Enter the monthly per-location unit count for Oregon satellite collection sites.
Pick the **billing month** (any date in the month — Vision anchors it to the first),
the **location**, and the **units**.

- The **$2.25/unit** rate is _not_ entered here — it lives in the program rules, and
  the dollar math is done by the invoice layer, not this surface.
- A **non-Oregon** site is refused with a clear error — California collection is
  captured as **collection events** (above), not as per-site monthly counts.

Also edit-before-lock, with an audit row per change.

---

## 3. The DR3# document-number counter

Vision assigns a **DR3#** to Woodland-style (California-jurisdiction) inbound loads
at the **office verify step** — the moment a load becomes a confirmed record. This
replaces the hand-written, typo-prone counter in the daily log (Addendum B6/B10-6).

- **When it's issued:** at verify (not at operator load-start — that would burn
  numbers on loads that might be rejected). Issued exactly once per load; a load that
  already has a DR3# is never re-numbered.
- **Where it's stored:** `inbound_loads.dr3_number`.
- **Eugene (Oregon):** gets **no** DR3# — the field stays blank (their scan-timestamp
  path is unchanged).
- **Material #** is **MyMRC-owned** (assigned in MyMRC at end-of-day) and is **never**
  issued by Vision.
- **Atomicity:** numbers come from a per-site counter (`document_sequences`) via a
  single atomic `UPDATE … RETURNING`, so two loads verified at the same instant can
  never get the same number (proven by a concurrent-issue test).

### ⚠ REQUIRED operator action before go-live: align the counter

The Woodland `dr3_number` counter is **seeded at a safe-high `5000`** (the June
daily-log ceiling observed was 4805 — starting above it guarantees no collision with
a historical hand-written number during the transition). **Before go-live you must
align it to the real current counter:**

1. Ask Janette for the **last DR3# issued** in the daily log.
2. Set the counter's `next_value` to **last issued + 1**, e.g. if the last was 4830:

   ```sql
   UPDATE document_sequences
   SET next_value = 4831, updated_at = now()
   WHERE site_id = (SELECT id FROM sites WHERE code = 'woodland')
     AND sequence_code = 'dr3_number';
   ```

3. Confirm the next verified Woodland load gets that number.

> Open decision (Addendum B10-6): whether DR3# is **per-site** or **company-wide** is
> still Janette's to confirm. Vision currently keys the counter **per site** and
> triggers issuance off **jurisdiction == California**. When Janette confirms, the
> trigger should become an explicit per-site config flag on the site record (there is
> a `TODO(ADR-0041 / B10-6)` in `src/lib/events/sequences.ts` marking this).
