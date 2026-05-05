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

<!-- Add new questions above this line. Do not edit resolved questions; preserve the historical record. -->
