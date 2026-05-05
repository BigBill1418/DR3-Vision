# ADR-0012: Sprint-1 clarifications and supplements

**Date:** 2026-05-05
**Status:** Accepted
**Supplements:** ADR-0001 (tech stack), ADR-0004 (PIN auth), ADR-0008 (brand theme), ADR-0009 (MyMRC integration)
**Supersedes:** none

## Context

A pre-Sprint-1 read-through of the handoff package surfaced seven items that needed a decision before T-001 begins:

1. The unload timer's start moment is described two different ways in the charter vs. the sprint plan.
2. The charter requires a manager-verified gate before MRC submission, but the schema's `LoadStatus` enum has no slot for it.
3. ADR-0004 mandates PIN uniqueness within a site, but Argon2id's salt-randomized hashes make this impossible to enforce with a SQL unique constraint.
4. The pinned PWA library (`next-pwa@5.6.0`) is end-of-life and has no Next.js 15 App Router support.
5. The DR3 logo SVG (HANDOFF.md open decision #1) is not yet available for T-001's brand-correctness checkpoint.
6. MyMRC service accounts (one per site, per ADR-0009 + MYMRC-INTEGRATION.md) do not exist yet.
7. T-013's "SVdP Internal Billing Export" has no concrete column spec (charter §11 open decision #2).

This ADR records the seven decisions that resolve those items so Sprint 1 starts with a single source of truth.

## Decisions

### 1. Visible operator timer starts on door-open photo submission

The operator-visible unload timer starts the moment the door-open photo is submitted (Sprint plan T-006 wording). The charter's §4.1 step 1 + §4.3 prose ("capturing the BOL photo starts the unload timer") is stale and should be ignored where it disagrees.

The schema already supports this without modification: `time_to_unload_start_seconds` covers `arrived_at → unload_started_at` (the Article 11.3 SLA window, captured silently for the Compliance dashboard), and `unload_duration_seconds` covers `unload_started_at → unload_finished_at` (the visible operator timer).

`unload_started_at` is set when the door-open photo's `LoadPhoto` row is persisted (Sprint plan T-006 step 3).

**Alternatives considered.** Starting the visible timer on BOL capture (charter prose) — rejected because Article 11.3's "begin unloading" SLA semantically means door-open, not BOL, and showing the operator a timer that's running while they're still capturing the weight ticket is confusing UX. Showing both timers — rejected as UI noise; the SLA window is a manager dashboard concern, not an operator concern.

**Consequences.** Charter §4.1 step 1 + §4.3 are factually wrong on this point and need a future v0.31 revision. ADR-0012 is canonical until that revision lands. The SLA-window timer is invisible to the operator but populated server-side from `arrived_at` (operator-marked at truck pull-up) and `unload_started_at` (set on door-open photo persist).

### 2. Add `verified` to `LoadStatus` enum

Insert `verified` between `submitted` and `submitted_to_mymrc` in the `LoadStatus` enum. State machine becomes:

```
expected → arrived → weight_captured → unload_started → in_progress
        → finished → submitted → verified → submitted_to_mymrc → processed
                              → rejected (terminal)
```

The manager's "Verify" action (Charter §4.4) transitions `submitted` → `verified`. MRC submission (V2.1 write path or manual MyMRC upload) transitions `verified` → `submitted_to_mymrc`.

**Alternatives considered.** Add `verified_at` + `verified_by_user_id` columns and leave the enum alone — rejected because verification is the gate for billing-ready MRC submission and the audit trail wants it modeled as a state transition, not metadata. "Stuck in `submitted`" should appear naturally as a manager dashboard tile (`WHERE status = 'submitted'`), not require a `verified_at IS NULL` predicate.

**Consequences.** T-002's first migration adds `verified` to the enum. The verify-action API route (T-010 / T-011 territory) writes a status transition with audit-log capture. The Compliance dashboard tile #1 (MyMRC submission timeliness) measures from `verified_at` (the moment verification completed) to `submitted_to_mymrc_at`, since the 3-business-day deadline begins at the moment the load becomes ready to submit, not when the operator pressed submit.

### 3. PIN uniqueness enforced via loop-verify on PIN-set

When a manager or admin sets/changes an operator's PIN, the server iterates active operators at the same site and runs `argon2.verify(theirHash, newPin)` against each. If any match, reject with "PIN already in use at this site, choose another." Audit log captures the rejection (without ever logging the PIN value).

This is an addendum to ADR-0004's PIN policy.

**Alternatives considered.** HMAC-lookup column (`pin_lookup_hmac = HMAC(server_secret, pin)`, `UNIQUE(site_id, pin_lookup_hmac)`) — rejected because a server-secret leak makes the 4-digit PIN space brute-forceable from a DB dump, a defense-in-depth regression vs. loop-verify. Skip uniqueness — rejected because it violates ADR-0004 + Charter §5.1 as written.

**Consequences.** PIN-set is an admin-side action; the ~30 active operators × ~80ms per verify ≈ ~2.5s response time is invisible to operators and acceptable for the admin caller. If a site exceeds ~100 active operators, this ADR is revisited. The PIN-set endpoint must run all verifications even on the first match (constant-time-ish behavior to avoid timing-leaking which user the duplicate matched, though the leak is bounded since the picker UI already exposes operator names).

### 4. Swap `next-pwa` for Serwist

Replace `next-pwa@5.6.0` with `@serwist/next` + `serwist` + `@serwist/background-sync`. Serwist is the actively-maintained Workbox wrapper for Next.js 13+ App Router; `next-pwa` v5 is functionally end-of-life with no App-Router support landed upstream.

**Alternatives considered.** `@ducanh2912/next-pwa` (drop-in fork of next-pwa) — rejected as single-maintainer with less momentum than Serwist, and Serwist is purpose-built for the App Router model the rest of the stack uses. Stay on `next-pwa@5.6.0` — rejected because T-009 (offline queue) is a Sprint-1 ship-blocker and discovering next-pwa-v5 + Next.js-15 incompatibility halfway through Sprint 1 is the worst possible time to fight a dead library.

**Consequences.** `package.json` swaps `next-pwa` for `@serwist/next` + `serwist` + `@serwist/background-sync` in T-001. `next.config.js` `withPWA(...)` wrapper changes shape — Serwist uses `withSerwist({ swSrc, swDest })` and an explicit `app/sw.ts` entry point rather than `next-pwa`'s in-config `runtimeCaching` array. T-009's Background Sync uses `@serwist/background-sync`'s `BackgroundSyncQueue`, which is a Workbox API, so the conceptual shape from ADR-0006 is preserved.

### 5. T-001 ships a text wordmark; logo SVG slots in later

The T-001 placeholder page renders "DR**3**-Vision" as a text wordmark on `--dr3-green-deep` background:

- "DR" and "-Vision" in `--dr3-cream`
- "**3**" in `--dr3-green` (the most-used DR3 secondary accent)
- Inter font, oversized (matches ADR-0008 typography)
- Tagline "coming soon" in `--dr3-chartreuse` below

When the canonical logo SVG is provided at `public/brand/dr3-logo.svg`, it replaces the wordmark via single-file swap. No rework of the page layout needed.

**Alternatives considered.** Forge a placeholder SVG matching ADR-0008's description (green "D", black "R3", recycling arrow) — rejected because it would be my interpretation of the description, likely close but not pixel-correct, and creates an artifact someone might mistake for the canonical mark. Block T-001 on logo arrival — rejected because brand-correctness can be validated on palette + typography alone; the logo is a single asset swap, not an architectural dependency.

**Consequences.** T-001's brand-correctness checkpoint validates palette + typography + page chrome, not the logo mark. HANDOFF.md open decision #1 stays open until the SVG arrives.

### 6. MyMRC bootstrap with operator's personal account; service accounts deferred

For Sprint 1 dev and first deploy, the same MyMRC credential pair populates both `MYMRC_CA_*` (Woodland) and `MYMRC_OR_*` (Eugene) env-var pairs. The operator's personal MyMRC login has access to both MRC California and MRC Oregon tenants, so a single set of creds covers both Playwright contexts.

Two Playwright contexts are still maintained per ADR-0009 — they share credentials but isolate `storageState` per site so Eugene auth state (cookies, session tokens) cannot poison Woodland and vice versa.

This is a temporary bootstrap. The launch checklist (FLEET-DEPLOYMENT.md) gains two items:
- Replace `MYMRC_CA_*` and `MYMRC_OR_*` with SVdP service accounts before V2.1.
- Rotate the personal-account password post-first-deploy (it transited an LLM session during planning).

Credentials live in `~/.dr3-vision-secrets/mymrc.env` on CHAD-HQ (mode 600), referenced by the container via env-file mount — never in `.env`, never in `data/config.yml`, never in the repo.

**Alternatives considered.** Block T-015 on service-account creation — rejected as unnecessary; T-015 can ship and be exercised in dev with Bill's account, then re-credential before V2.1. Collapse to a single `MYMRC_USERNAME`/`MYMRC_PASSWORD` env-var shape — rejected because keeping the per-site shape means the eventual service-account split is a value swap, not a code change.

**Consequences.** Charter §11 open decision documenting MyMRC service accounts becomes a launch-checklist item. Until SVdP service accounts exist, the integration is bound to the operator's personal access — including their 2FA prompts, password resets, and any departure-someday scenario.

### 7. SVdP internal CSV export ships with MyMRC field-name shape

T-013's "SVdP Internal Billing Export" CSV column shape mirrors the MyMRC field names:

```
Recycler, Haul ID, Reported Delivery Date, Collection Site,
Unit Count at Unload, Recycler Program Unit Count,
Recycler Non-Program Unit Count, Pickup Address, Transporter,
Reference Number, Recycler Weight, Status, Commodity
```

Per-site by default. Cross-site export requires `admin` role + explicit confirmation, as already specified.

This is the charter §11-authorized default ("defaults to MyMRC field names if no specific format requested"). Reshape after the Glenn DePrater CFO conversation lands — that's a Sprint-2+ follow-up ticket, not a Sprint-1 blocker.

**Alternatives considered.** Defer T-013 to Sprint 2 entirely — rejected because Bill wants Glenn to have *something* on day 1, and the MRC Monthly Invoice export (also part of T-013) is independent of this question. Invent a CFO-friendly schema speculatively — rejected because guessing at Glenn's preferences without input creates a fixed shape that may need full rework, vs. starting with a known-coherent shape and iterating.

**Consequences.** T-013 ships with MyMRC field names in the SVdP export CSV. A follow-up ticket (Sprint-2-or-later, code TBD) reshapes it after the Glenn conversation; the audit trail preserves both shapes if any historical export needs to be regenerated in the original column order.

## References

- Charter §4.1, §4.3 (timer semantics — to be corrected in v0.31)
- Charter §4.4, §11 (verified gate, internal-export open decision)
- Charter §5.1 (PIN policy)
- Charter §6.5, §11 (MyMRC service accounts, deferred)
- Charter §8 (brand theme tokens)
- ADR-0001 (PWA stack — superseded for the `next-pwa` line only)
- ADR-0004 (PIN auth — supplemented with loop-verify uniqueness check)
- ADR-0008 (brand — bootstrapping rule for missing logo)
- ADR-0009 (MyMRC integration — bootstrapping rule for missing service accounts)
- HANDOFF.md (open decision #1 logo)
- SPRINT-1-PLAN.md T-001, T-002, T-004, T-006, T-009, T-013, T-015 (all touched by this ADR)
