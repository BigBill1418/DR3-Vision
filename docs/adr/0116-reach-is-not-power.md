# ADR-0116 — Reach is not power

- **Status:** Proposed — awaiting Bill. The code change is written, tested and
  green; it is NOT merged, because it narrows who can open five existing
  surfaces and that is a call for the person who knows who uses them.
- **Context:** Five surfaces hand-rolled their access check as _reach only_ and
  never asked the role question. An operator's PIN session satisfies a reach
  check for their own site, so an operator could run on-demand audits, transition
  audit findings, and render three manager pages. Found in the 2026-08-19
  engineering audit.
- **Supersedes / amends:** nothing. Enforces CLAUDE.md hard rule #2 and the
  contract already implemented by `requireManagerForSite`
  (`src/lib/auth-helpers.ts:45`). Interacts with ADR-0024 (`all_sites`).

## Context

CLAUDE.md hard rule #2 states the distinction and warns against collapsing it:

> The check for _site reach_ is `role === 'admin' || all_sites`. The check for
> _admin powers_ stays `role === 'admin'`. Do not reconflate them.

`requireManagerForSite` implements the full contract in the right order — role
first, reach second:

```ts
const role = session.user.role;
if (role !== 'manager' && role !== 'admin') {
  throw new Response('forbidden', { status: 403 });
}
// ... then the site lookup, then the reach check
```

Five surfaces did not use it. They hand-rolled a variant that asks only the
second question:

```ts
const isAdmin = session.user.role === 'admin';
const canReach =
  isAdmin || session.user.all_sites === true || session.user.primary_site_id === site.id;
if (!canReach) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
```

An operator is not an admin and is not `all_sites`, but
`primary_site_id === site.id` is **true for their own site** — so `canReach` is
true and the request proceeds.

Three facts make that reachable rather than theoretical, and each was verified
rather than assumed:

1. **An operator PIN session is a full session.** `auth.ts:236-240` returns
   `role`, `primary_site_id`, `all_sites: false` — a real `primary_site_id`, not
   null.
2. **The middleware never checks role.** `src/middleware.ts` gates on
   `if (!req.auth)` — authentication only. There is no role layer above these
   routes.
3. **Nothing else guards them.** Neither API route had _any_ test before this
   ADR.

The affected surfaces:

| Surface                                       | Capability an operator gained                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `POST /api/audit/[site]/run`                  | run an on-demand audit — persists finding lifecycle + an `audit_runs` ledger row |
| `GET`/`PATCH /api/audit/[site]/findings/[id]` | read and **transition** a finding (`open → resolved / not_an_issue`)             |
| `/dashboard/[site]`                           | render the manager dashboard                                                     |
| `/dashboard/[site]/audit`                     | render the manager audit-review surface                                          |
| `/dashboard/[site]/load/[id]`                 | render manager load detail                                                       |

The two API routes are the real finding: they are writes, and a finding
transition is a manager review action being taken by someone who is not a
manager. The three pages are read exposure of the manager portal.

**The correct sibling exists**, which is what makes this drift rather than
design: `src/app/dashboard/[site]/loads/page.tsx:166-167` does exactly the right
thing —

```ts
const role = session.user.role;
if (role !== 'manager' && role !== 'admin') {
```

— and the four other `[site]` surfaces diverged from it. The Phase 0 parity
audit had already flagged `dashboard/[site]/page.tsx:51-53` as an inline
re-implementation; this ADR is the finding that the re-implementation is not
merely duplicated but _wrong_.

## Proven, not inferred

The test suite added here (`audit-routes-role-gate.test.ts`, six cases) was run
against the **pre-fix** code, and the operator case fails with:

```
× REFUSES an operator whose primary site matches — reach is not power
  → expected 200 to be 403
```

**200, not 403** — the audit run executed. That is the escalation demonstrated
end to end. On the repaired route all six pass.

The suite deliberately asserts both directions. A test that only checks the 403
would pass on a route that forbids everybody, so the manager, admin, and
`all_sites`-manager cases are pinned too — the gate must reject the operator
_and still admit the roles it exists for_. The off-site manager case pins that
the reach check itself is untouched.

The operator case also asserts `auditSiteWindow` was **not called**: a 403
returned _after_ the sweep had already persisted its rows would carry the same
status code and none of the protection.

## Decision

Insert the missing role gate at all five sites, in the canonical order (role,
then reach), each preserving the surface's existing error shape — the API routes
keep their `{ error: 'forbidden' }` JSON, the pages keep their bespoke 403
markup.

**Deliberately NOT done here: the refactor.** Routing all five through
`requireManagerForSite` / `checkManagerForSite` is the right end state and would
delete the divergence class outright. It also changes response bodies (a bare
`'forbidden'` Response instead of the JSON the clients read) and the pages'
unknown-site behaviour (`notFound()` vs a 404 status). That is a second change
with its own blast radius and it should not ride along inside a security fix.
Recorded here as the follow-up.

## Why this is Proposed and not Accepted

The fix narrows access to five surfaces that have been reachable by operators
since they were written. The evidence says no operator is _meant_ to use them —
`/dashboard` is the manager portal, and a sweep of `src/app/operator/**` and
`src/components/**` finds **no link into `/dashboard` at all** (the only textual
hit is a code comment in `hauls/pagination.tsx`). But "no link" is not "nobody
navigates there", and if a floor lead has been reading the manager dashboard on
purpose, this change takes it away from them with a 403 and no warning.

That is a question about people, not code. Bill decides; the branch is ready
either way.

## Consequences

- If accepted: five surfaces enforce the role contract the rest of the app
  already enforces, and the two audit-API routes gain their first tests.
- No schema change, no migration, no behaviour change for managers or admins.
- The `all_sites` semantics are untouched — an `all_sites` **manager** still
  reaches every site (ADR-0024), and `all_sites` still never unlocks `/admin/*`.
- The follow-up refactor onto the canonical helpers remains open.
