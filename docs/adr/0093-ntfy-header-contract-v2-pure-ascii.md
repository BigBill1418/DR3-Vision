# ADR-0093: The header contract is ASCII, because the strictest client sets it

**Date:** 2026-08-12
**Status:** Accepted
**Amends:** ADR-0019.5 (the em dash that ate the payroll alert) — tightens its output contract
**Adopts:** noc-master ADR-0200 — the fleet-wide header conformance contract (v2)
**Extends:** ADR-0036 (ntfy transport), ADR-0037 (noise policy)

## Context

ADR-0019.5 fixed a real drop: an em dash in `X-Title` threw inside undici before
a socket opened, identically on the primary and the fallback, and Eugene's
Period 16 stranded-payroll page was lost. The fix introduced one shared
`toHeaderSafe()` and applied it at each publisher's choke point.

It set the output contract at **latin-1**, because that is where undici's wall
is:

```
TypeError: Cannot convert argument to a ByteString because the character at
index 43 has a value of 8212 which is greater than 255
```

The number in that message is 255, so `café` was deliberately preserved — the
reasoning being that mangling a vendor or person's name for no reason is its own
defect. That reasoning was correct **for undici**, and that is the problem.

### The fleet's clients do not agree on where the wall is

noc-master ADR-0200 measured them:

| client          | raises above | tolerates       |
| --------------- | ------------ | --------------- |
| python-httpx    | **U+007F**   | ASCII only      |
| node-undici     | U+00FF       | latin-1         |
| python-urllib   | U+00FF       | latin-1         |
| python-requests | U+00FF       | latin-1         |
| curl / bash     | —            | sends raw bytes |

Helix-Hub and other fleet publishers post with **httpx**, where a Title holding
`é` raises `UnicodeEncodeError: 'ascii' codec can't encode character '\xe9'` —
the same before-the-socket, kills-both-legs failure the em dash caused here, from
a character this repo's v1 sanitizer deliberately let through.

So a title that is provably safe in DR3-Vision is a dropped page in the next
repo. Sanitizing to the _loosest_ client's limit reintroduces the exact class
ADR-0019.5 exists to kill, one repo over. This is the same structural mistake in
a new shape: ADR-0019.5's own finding was that per-publisher fixes let the next
publisher re-introduce the bug. A per-_repo_ contract lets the next repo do it.

### What was measured here

DR3-Vision's v1 implementation, run against the canonical vectors in
`noc-master/data/ntfy-header-conformance.json`, failed **3 of 20** — all three
the accent-folding cases:

| vector id          | expected                          | v1 produced                       |
| ------------------ | --------------------------------- | --------------------------------- |
| `accent-fold`      | `cafe renewal for Jose`           | `café renewal for José`           |
| `accent-fold-high` | `naive y`                         | `naïve ÿ`                         |
| `mixed`            | `STRANDED - cafe >= 90% ... ? ->` | `STRANDED - café >= 90% ... ? ->` |

The other 17 already conformed. The gap was exactly the latin-1 allowance, not
the transliteration table.

Two further gaps sit outside the vector set: v1 had **no mapping for `·`**
(U+00B7 middot), and its dash class covered only `—–−` rather than the full
`U+2010–U+2015` range, so `‑ ‒ ―` degraded to `?` where the fleet table yields
`-`.

## Decision

**Adopt fleet contract v2 verbatim: header values are PURE ASCII.**

Pipeline, in this order — the order is load-bearing:

1. **Transliterate** the punctuation these titles actually use
   (`— – −` → `-`, curly quotes, `…` → `...`, `→` → `->`, `×` → `x`,
   `≥`/`≤` → `>=`/`<=`, exotic spaces → ` `, `•`/`·` → `*`).
   Not redundant with step 3: NFKD leaves `×`, `≥` and `•` undecomposed, so
   without an explicit mapping they would degrade to `?` and lose meaning.
2. **Strip CR/LF** — each becomes a space, never deleted. Deleting them would
   splice two header fields into one token. This is header-injection defence as
   much as encoding.
3. **Fold accents** to their ASCII base via NFKD, dropping combining marks, so
   `café renewal for José` → `cafe renewal for Jose`.
4. **Degrade** anything with no ASCII base (emoji, CJK) to `?`.

Accent folding is what makes an ASCII-only contract tolerable to a human reader.
`caf?` would be a readability regression rather than a fix; `cafe` is a word.
Step 4 remains the backstop that matters most: an unmapped glyph must degrade to
a **sendable page, never a lost one**.

Iteration is over **codepoints**, not UTF-16 units — a naive index walk treats an
astral emoji as a surrogate pair and emits `??` for one glyph.

Unchanged from ADR-0019.5, and re-affirmed: **`Authorization` is never
sanitized** (a bearer is ASCII by construction; mangling it turns an encoding bug
into an auth bug) and **the BODY is never sanitized** (sent as UTF-8, may hold
anything). Sanitization happens at the single choke point where headers are
assembled, never per-field at call sites — that is the shape that failed three
times.

**The vectors are vendored, not fetched.** `src/__tests__/ntfy-header-conformance.json`
is a committed copy of the canonical file. A runtime fetch that fails degrades to
a SKIPPED test — a safety net that lies, which is the whole pattern being
eliminated. The cost is that a fleet contract change must be pulled in
deliberately; that is the intended trade.

## Alternatives considered

- **Stay on latin-1 and let httpx publishers sanitize harder.** Rejected: this is
  per-repo contracts, i.e. the ADR-0019.5 failure mode at fleet scale. It also
  puts the burden on the repo that did nothing wrong.
- **Transliterate `ß` → `ss`, `°` → ` deg`, etc.** Rejected _for now_: it would
  diverge DR3 from the fleet reference implementations, and a divergence the
  shared vectors cannot detect is worse than a slightly lossier output. Raise it
  against ADR-0200 so every publisher gains it at once.
- **Percent-encode or RFC 2047 encode non-ASCII.** Rejected: ntfy renders the
  header literally, so the operator would read `=?utf-8?B?...?=` on their phone.
  Unreadable beats unsendable only barely, and folding beats both.
- **Fetch the canonical vectors in CI.** Rejected — see above; a failed fetch
  that skips is indistinguishable from a pass.

## Consequences

- Alert titles containing accented names now read `cafe` / `Jose` rather than
  `café` / `José`. This is a deliberate, visible readability cost paid to make
  the same title deliverable by every fleet publisher.
- `ß` and `°` now degrade to `?` where v1 passed them through. Accepted as the
  price of ASCII; flagged above as a candidate improvement to make fleet-wide
  rather than locally.
- **Known limitation, raised upstream:** a string in decomposed (NFD) form —
  `e` + U+0301 rather than precomposed `é` — yields `cafe?`, because the lone
  combining mark has no ASCII base. Both fleet reference implementations
  (Helix-Hub's Python and noc-master's JS) share this behaviour, so DR3 matches
  them rather than silently diverging. Normalizing the whole string before the
  fold would fix it; that belongs in ADR-0200 so all publishers move together.
- The `.ts` and `.mjs` twins are now pinned equal against the **shared vector
  set** rather than an ad-hoc case list, so the pin widens automatically whenever
  the fleet contract does.
- The repo-wide sweep's "no hardcoded non-ASCII in a title template" check
  tightened from >255 to >127. It was already clean at both thresholds.
- Every DR3 ntfy publisher was audited: all five (`src/lib/ntfy.ts`,
  `src/lib/mymrc/ntfy.ts`, `scripts/bonus-eod-check.mjs`,
  `scripts/bonus-escalation-check.mjs`, `scripts/migrate-with-ntfy.mjs`) route
  their headers through the shared sanitizer. No bypass path was found.
