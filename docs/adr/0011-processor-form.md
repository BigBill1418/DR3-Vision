# ADR-0011: Processor Form / deconstruction-line workflow

**Date:** 2026-05-04
**Status:** Accepted (V2.1 scope)

## Context

After mattresses arrive at the dock and are recorded as inbound loads, they enter the deconstruction line, where processors hand-disassemble them into recoverable components: steel springs, foam, cotton, wood. This downstream workflow is currently captured on a daily paper Processor Form per processor per shift.

The Processor Form drives three things:
1. **MyMRC processed-units submission** (1-business-day deadline — the tightest in either contract)
2. **Processor bonus pay calculation** (payroll-adjacent; sites have different formulas)
3. **Recycling rate calculation** (CA 75% / OR 70% required) and **97% in/out reconciliation**

If the inbound load record is the front door, the Processor Form is the back door. They must reconcile.

## Decision

Build the Processor Form workflow as **V2.1**, not MVP.

### Why V2.1
- MVP focuses on inbound capture, the immediately-paying piece (delays here cost contract money)
- Processor Form has more complex per-mattress material-tally UX
- V2.1 is the natural place to cut over the deconstruction-line workflow once managers are comfortable with the inbound flow

### Schema (drafted in MVP for forward-compat)

```
processing_sessions
  id              uuid PK
  site_id         uuid FK sites.id
  processor_user_id uuid FK users.id
  session_date    date
  shift           enum (morning, afternoon, evening)
  line_no         integer (which deconstruction line)
  lead_user_id    uuid FK users.id (signs off on the session)
  authorized_by_user_id uuid FK users.id (manager who validates)
  units_handled   integer (units the processor saw)
  units_processed integer (units fully deconstructed)
  units_saved     integer (units returned to inventory; not processed)
  units_leftover  integer (units carried into next shift)
  -- per-material tally lives in processing_session_materials
  created_at, updated_at, audit-log integration
```

### Bonus calculation

Both sites use the same formula *shape* (two-threshold, two-rate, additive) with different parameters:

- **Eugene (Oregon):** daily bonus = `MAX(units − 50, 0) × $1.00 + MAX(units − 100, 0) × $0.25`
- **Woodland (California):** daily bonus = `MAX(units − 50, 0) × $0.50 + MAX(units − 75, 0) × $0.25`

Modeled as `processor_bonus_rules`:
```
processor_bonus_rules
  id              uuid PK
  site_id         uuid FK
  threshold_low   integer (50 for both currently)
  rate_low        decimal (1.00 OR / 0.50 CA)
  threshold_high  integer (100 OR / 75 CA)
  rate_high       decimal (0.25 both)
  effective_date  date
  end_date        date (nullable)
```

Historical rules stay in the table for back-calculation.

### Roles and reporting differences

- Eugene tracks processor roles (Lead, Processor, Machine Operator, Stryo, Floater) — schema includes optional `processor_role` field
- California tracks bare names — `processor_role` is null for Woodland processors
- Eugene reports **monthly bonus dollars only**
- California reports **both monthly bonus dollars and monthly processed total** (units)

Both reports must be exposed in V2.1.

### Reconciliation

V2.1 introduces a daily reconciliation: today's `inbound_loads.total_units` (delivered) ≈ today's `processing_sessions.units_handled` (sent to line). Discrepancies surface on the Compliance dashboard.

## Alternatives considered

- **Build into MVP** — explicitly rejected; would delay the inbound capture (the immediately-paying piece) and overcomplicate Sprint 1
- **Keep Processor Form on paper indefinitely** — manual reconciliation between paper and DR3-Vision indefinitely is operationally painful and contradicts the project's purpose
- **Build only the bonus calculator (no full workflow)** — partial solution; the 1-business-day MyMRC processed-units deadline is the hard requirement, not just the bonus

## Consequences

- MVP schema includes `processing_sessions` and `processor_bonus_rules` tables (empty initially)
- The MyMRC processed-units submission (1-business-day deadline) is **manually captured** in MVP via the existing paper Processor Form workflow until V2.1 ships
- V2.1 timeline depends on MVP stability; not a fixed date
- Bonus formulas may shift; the table-based design accommodates new effective_date rows without code changes

## References

- Charter §4.6 (Compliance dashboard), §6.6 (Schema, V2.1 tables)
- v0.27 changelog (bonus formulas captured from real spreadsheet)
- Bonus_Spread_Sheet_2026.xlsx (in conversation transcript)
- Blank_Processor_Form__2_.xlsx (in conversation transcript)
