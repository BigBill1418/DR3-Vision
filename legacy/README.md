# `legacy/` — V1 PHP archive

This directory holds the **V1 PHP codebase** that previously occupied `BigBill1418/DR3-Vision`. It is preserved for reference only:

- It is **not deployed**.
- It is **not built**.
- It is **not maintained**.
- It is **not referenced** by V2 code under any circumstance.

## Why it's here

When V2 work began, the existing PHP code was archived into `legacy/` rather than wiped, in case any institutional knowledge — a clever query, a hard-won regex, an undocumented MyMRC quirk — turns out to be useful during V2 development. It is a reference; it is not a foundation.

V2 is a from-scratch rewrite (Next.js 15 + TypeScript per ADR-0001), not a port.

## Build exclusions

- `.gitignore` excludes `legacy/` from typescript builds: `tsconfig.json` has `"exclude": ["legacy", ...]`
- `Dockerfile` does not copy `legacy/`
- `next.config.js` does not import from `legacy/`
- ESLint does not lint `legacy/`

If a V2 file ever imports from `legacy/`, that's a bug — flag it in code review.

## Removal timeline

`legacy/` will be deleted once V2 has been operating in production for **6 months** without any reference back. Until then, treat it as a museum exhibit: look, don't touch.

## What's *not* here

The Stockton facility code, customer database, or anything Stockton-related is **not** preserved here, even from V1. Stockton is excluded from V2 entirely (consolidation exit) and any V1 Stockton-specific code is purged before archival.

## Authoritative reference

The new system's authoritative entry point is `../CLAUDE.md` and `../PROJECT-CHARTER.md`. Do not ask V1 questions; ask V2 questions of the V2 documentation.
