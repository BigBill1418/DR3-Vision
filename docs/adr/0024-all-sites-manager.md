# ADR-0024: All-sites manager (`all_sites` flag)

**Status:** Accepted
**Date:** 2026-06-09
**Decider:** Bill Barnard (Director of Operations, SVdP / DR3)
**Amends:** CLAUDE.md hard-rule #2 ("cross-site rollups require admin role") and the ADR-0019.2 §1 access matrix.

## Context

The app had exactly two browser-user tiers above operator:

- **`manager`** — hard-scoped to a single site (`primary_site_id`). Janette → Woodland, Rick / Patrick → Eugene, Morena → Woodland (the `null` California-ops special case). A manager cannot see the other site anywhere — dashboards, loads, bonus, or exports all 403 / filter out the off-site.
- **`admin`** — sees both sites AND unlocks every admin power: `/admin/*` user management, the audit-log admin viewer, admin-only bonus state transitions (amendment, override), and universal signature authority.

Kelsey Ruhland is DR3's Data & Compliance lead and MRC contract SME. She needs to **see both sites'** data (loads, compliance, bonus history, exports) to do her job, but she should **not** hold admin powers (she is not the user administrator and is deliberately outside the bonus signature/override authority).

There was no tier that fit: `manager` is single-site, `admin` is all-site-plus-everything. The original seed provisioned her as `admin` purely to get both-site visibility — conflating "view all sites" with "administer the system." Bill's instruction (2026-06-09): **"no admin — just view all."**

## Decision

Add a boolean `all_sites` flag to `users` (default `false`). When `true` on a **`manager`** row, the manager reaches **every site** exactly as an admin would for site-scoping purposes — but the role stays `manager`, so it confers **none** of the admin-only powers.

`all_sites` is a _site-reach_ expansion only. It is checked **everywhere site reach is decided** and **nowhere else**:

- `checkBonusAccess` (`src/lib/bonus/access.ts`) — admin OR `all_sites` ⇒ `{woodland, eugene}`.
- `requireManagerForSite` (`src/lib/auth-helpers.ts`) — a manager passes the site check if `primary_site_id === site.id` **or** `all_sites`.
- The three `/dashboard/[site]/**` page guards — `isAssigned` is true for an all-sites manager.
- The site pickers on `/dashboard` and `/dashboard/exports` — an all-sites manager sees every site.

It is deliberately **NOT** consulted by any admin gate: `requireAdmin` (`/admin/*`, user management, audit admin), the admin-only bonus state-machine transitions (amendment / override), or signature authority. Those remain `role === 'admin'` only. An all-sites manager therefore sees and operates on both sites with full _manager_ capability and zero _admin_ capability.

Operators are never all-sites (the PIN flow hard-codes `all_sites: false`); for admins the flag is irrelevant (they already see all sites).

## Alternatives considered

1. **Make Kelsey `admin` (status quo seed).** Rejected — Bill explicitly does not want her to have admin powers; conflates visibility with administration.
2. **A new `viewer` / `auditor` role (read-only, all sites).** Rejected for now — a new role value means extending the `UserRole` enum and auditing every `role === 'manager' | 'admin'` branch across the codebase (signatures, state machine, tiles, guards). Higher blast radius than a flag, and Bill chose _full manager on both sites_, not read-only. Revisit if a true read-only auditor tier is ever needed.
3. **Multi-site grant table (per-user list of sites).** Rejected as over-built for two sites; a single boolean covers "this manager spans all sites" without a join table. If DR3 ever runs 3+ sites with partial-overlap managers, a grant table becomes the right model and supersedes this ADR.

## Consequences

### Positive

- Kelsey gets exactly what she needs — both-site visibility and manager workflow — without admin powers.
- Smallest possible change: one boolean, threaded through the session and the handful of site-reach gates. Default `false` means every existing user is unchanged.
- The admin/manager security boundary is untouched — `requireAdmin` and the admin-only bonus transitions still gate on `role === 'admin'`.

### Negative

- CLAUDE.md hard-rule #2 ("cross-site rollups require admin role") is now **amended**: cross-site reach is granted to admins **and** explicitly-flagged all-sites managers. Future code must check `role === 'admin' || all_sites` for _site reach_, but keep `role === 'admin'` for _admin powers_. The two must not be reconflated.
- Granting/revoking `all_sites` was initially **seed- or SQL-managed**. **Update 2026-06-09:** the `/admin/users` toggle shipped — a manager-only "Access to all sites" checkbox on the create + edit forms, with the model coercing the flag to false whenever the role is not `manager`. Admins now grant/revoke it in the UI; no SQL needed.

### Neutral

- `primary_site_id` still matters for an all-sites manager only as a _default landing site_; it no longer bounds their reach.
- Only Kelsey is `all_sites=true` at acceptance. The mechanism is general.

## Related ADRs

- ADR-0016 — Entra ID SSO for managers + admins (the sign-in gate `all_sites` flows through)
- ADR-0017 — Admin Settings panel (where the future `all_sites` toggle would live)
- ADR-0019 / ADR-0019.2 — Bonus management system + Eugene enablement (the §1 access matrix this expands)
