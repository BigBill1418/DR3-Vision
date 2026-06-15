# Questions

This file is where Claude Code logs questions encountered during development that the charter and ADRs do not resolve. Bill reviews this file out-of-band.

## Format

```
## Q-N: <one-sentence question>
**Date:** YYYY-MM-DD
**Encountered in:** path/to/file.ts (line N) or "ticket T-NNN"
**Question:** <full question with context>
**Alternatives considered:** <what you weighed>
**Proposed answer:** <what you went with, flagged in code with `// TODO(question-N): see docs/QUESTIONS.md`>
**Resolution:** (filled in by Bill or by Claude on follow-up)
```

## Q-1 — example

**Date:** 2026-05-04
**Encountered in:** N/A — this is the template example
**Question:** Should the operator's PIN entry mask digits as `*` after a brief preview, or always-mask?
**Alternatives considered:** Brief preview (better usability with gloves), always-mask (better shoulder-surf protection)
**Proposed answer:** Brief preview (300ms), then mask. Matches iOS PIN entry UX and is appropriate for the threat model (warehouse floor, not a public terminal).
**Resolution:** Pending Bill review.

## Open questions (Claude Code: append below)

## Q-2: Should the employee-number extraction also write formal audit_logs rows, or is the previous_names provenance entry sufficient?

**Date:** 2026-06-15
**Encountered in:** docs/plans/2026-06-15-bonus-employee-number-extraction.md (§6); prisma/migrations/20260615_bonus_employee_number/migration.sql
**Question:** The migration records each rename in `bonus_employees.previous_names` (reason `employee_number_extracted`). Do we also want an `audit_logs` row per change (ADR-0007/0018) for a queryable, viewer-visible trail? The migration runs without an operator actor, so any audit row would carry a synthetic `system`/`migration` actor that the ADR-0018 viewer may not render cleanly.
**Alternatives considered:** (a) previous_names only — reversible, self-contained, no actor problem [chosen]; (b) previous_names + audit_logs INSERT...SELECT — stronger trail but synthetic actor; (c) audit_logs only — loses the row-level reversible record.
**Proposed answer:** Ship (a). Add (b) only if Bill wants a viewer-visible audit trail and after confirming the audit_logs nullable/synthetic-actor contract.
**Resolution:** Pending Bill review.

<!-- Add new questions above this line. Do not edit resolved questions; preserve the historical record. -->
