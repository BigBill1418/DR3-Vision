# ADR-0017: Admin Settings Panel for User Seeding & Management

**Date:** 2026-05-06
**Status:** Accepted
**Supplements:** ADR-0004 (PIN auth), ADR-0007 (Audit log), ADR-0012 (Sprint-1 clarifications)

## Context

The bootstrap CSV seed at `prisma/seed/users.csv` provisions the
initial roster. Day-to-day, Bill needs to seed new operators (with
PINs) and add managers / admins (SSO-only, post-Wave-A) **from
inside the portal** — not by hand-editing a CSV and re-running the
seed script. Per Bill's exact wording 2026-05-06:

> "we will seed operator accounts from within the settings panel in
> the portal — that will be required — same place I will add / seed
> other manager email accounts."
>
> "entra only — sso only for admins and managers"

The bootstrap CSV path stays as the canonical bulk-import mechanism;
this panel is for ongoing single-user adds, edits, deactivations,
and PIN resets.

## Decision

Ship `/admin/users` as a server-rendered list + create + edit
surface, gated to `role='admin'` at three layers:

1. **Middleware** — already redirects unauthenticated visitors to
   `/login`. No change.
2. **Page-level server check** — every page in `/admin/**` calls
   `checkAdmin()` (new helper in `src/lib/auth-helpers.ts`) and
   either redirects or renders a 403 surface for non-admin
   sessions.
3. **Per-route API check** — every handler in `/api/admin/**`
   calls `requireAdmin()`. 401 for anonymous, 403 for authed
   non-admins. Manager + operator both 403; the API never trusts
   the page-layer gate.

### Routes

| Path                     | Method  | Purpose                                  |
| ------------------------ | ------- | ---------------------------------------- |
| `/admin`                 | GET     | redirect → `/admin/users`                |
| `/admin/users`           | GET     | list (filters via `?site=&role=&status=`) |
| `/admin/users/new`       | GET     | create form                              |
| `/admin/users/[id]`      | GET     | edit form (incl. PIN reset, deactivate)  |
| `/api/admin/users`       | POST    | create                                   |
| `/api/admin/users`       | GET     | list (JSON)                              |
| `/api/admin/users/[id]`  | PATCH   | discriminated union (see below)          |
| `/api/admin/users/[id]`  | DELETE  | alias for `{action:'deactivate'}`        |

### PATCH discriminated union

```ts
{ action: 'update', name?, role?, email?, primary_site_id?, processor_role? }
{ action: 'reset_pin', pin: '4-digit-string' }
{ action: 'deactivate' }
{ action: 'reactivate' }
```

### Data layer

A single transaction-per-mutation pattern in
`src/lib/admin-users.ts`:

- `listUsers(filters)` — SELECT + JOIN to primary_site for the code.
- `createUser(input, actor)` — `prisma.$transaction([User.create,
  AuditLog.create])`. If the user is an operator, follows up with a
  `setPin()` call (which writes its own audit row); on PIN failure
  the row is soft-deleted in a compensating transaction.
- `updateUser`, `resetUserPin`, `deactivateUser`, `reactivateUser` —
  same shape. Always paired audit rows in the same `$transaction`.

PIN handling reuses `setPin()` from `src/lib/pin-service.ts`. We
do not re-implement Argon2id here; the per-site uniqueness
loop-verify (ADR-0012 §3) is preserved, as is the `pin_hash`-not-
indexed rule (CLAUDE.md hard rule #8).

### Audit log shape

Every mutation logs to the existing `AuditLog` table. The schema's
`AuditAction` enum is kept verbatim — `insert | update | delete |
soft_delete | restore`. PIN resets and field updates both share the
`update` action; the `before`/`after` JSON makes the distinction.

The `before` and `after` snapshots are passed through
`scrubUserForAudit()` first, which replaces `pin_hash` and
`password_hash` with `pin_set: boolean` / `password_set: boolean`
markers. A defensive runtime probe (`serializeForAudit`) refuses to
serialize an object that still has either secret-hash key, so a
future refactor that accidentally re-introduces them will fail loud
at insertion time, not silently leak the hash into a row that —
per hard rule #6 — is never deleted.

### PII contract

The DTO `AdminUserDto` (returned by every API and rendered in
every page) excludes `pin_hash` and `password_hash`. The has-PIN
state is exposed only as `has_pin: boolean`. The has-password state
is implicit (managers/admins always sign in via SSO post-Wave-A).

### Out of scope (explicitly deferred)

- **Force-logout / session invalidation.** Deactivation is the
  v1 mechanism: a deactivated user fails the `is_active` check on
  the next request. Adding a `session_version` column was
  considered; it would require a schema change for marginal
  benefit since SSO sessions are JWT-based and short-lived.
- **Password reset email magic links.** Resend isn't provisioned
  (Sprint-1 residual #2). Manager/admin password reset routes
  (`/forgot-password`, `/reset-password`) already exist; once
  email is wired the flow stitches together.
- **Bulk import / CSV upload.** The bootstrap CSV seed remains
  the canonical bulk-import path.
- **i18n.** The admin surface stays English-only for v1, matching
  the manager portal's current state. All literals are concentrated
  in `src/app/admin/messages.ts` so a future Sprint-2 i18n pass
  is one mechanical conversion (per ADR-0015's loader pattern).

### Non-decision

- Audit `action` did NOT extend the existing `AuditAction` enum.
  PIN reset shares the `update` slot. The motivating constraint:
  the PR brief's "never extend AuditLog shape from this PR" rule.
  Operationally fine — the `before`/`after` JSON differentiates
  the cause and admins reviewing the audit log can filter by
  `actor_user_id` + `table_name='users'` and read the field-diff.

## Alternatives considered

- **Skip the gate at the page layer; trust middleware + API.**
  Rejected — middleware only knows authenticated/not, not role.
  Without page-layer `checkAdmin()` a manager could navigate to
  `/admin/users` and see the React shell briefly before the API
  returns 403, leaking that the surface exists. The cost of a
  server-side session check is one DB-free `auth()` call.

- **Separate "PIN reset" and "Deactivate" routes** (e.g.,
  `POST /api/admin/users/[id]/pin-reset`). Rejected — the
  discriminated-union PATCH keeps the API surface narrow (two
  routes total) and lets every action share the same role-gate +
  actor + IP/UA capture path. The discriminated-union zod schema
  validates exhaustively.

- **Use `<form>` + Server Actions for the mutations.** Rejected
  per CLAUDE.md hard rule #10 (forms in React use `onClick`,
  not `<form>`). Server Actions would also bury the audit-log
  trail in unrelated code paths.

- **Extend `AuditAction` with `reset_pin`.** Rejected — out of
  scope per the PR brief; the v1 audit-log query patterns work
  fine with `update` + the `before`/`after` JSON.

## Consequences

- A new `requireAdmin()` helper in `src/lib/auth-helpers.ts`. Pages
  use the discriminated-result `checkAdmin()` variant; API routes
  use the throw-Response `requireAdmin()` variant. Same shape as
  the existing manager-site helpers.
- `src/lib/admin-users.ts` is server-only (it imports Prisma +
  argon2). Client components MUST NOT import it; the shared
  `PROCESSOR_ROLES` constant lives in
  `src/app/admin/constants.ts` to keep client bundles free of the
  argon2 native binding. (This bit us once during initial build —
  fixed by extracting the constant.)
- All admin literals live in `src/app/admin/messages.ts`. New admin
  copy goes there; nothing else.
- Tests:
  `src/lib/admin-users.test.ts` (PII scrubber unit) +
  `src/app/api/admin/users/users.test.ts` (API integration with
  mocked Prisma + auth). 29 cases total. The API tests exercise
  real Argon2id PIN hashing — the operator collision path is
  validated against a real-hash peer.

## References

- CLAUDE.md hard rules #2, #6, #8, #10
- PROJECT-CHARTER.md §5 (security), §6 (schema)
- ADR-0004 (PIN auth)
- ADR-0007 (audit log)
- ADR-0012 §3 (PIN uniqueness loop-verify)
- ADR-0015 (i18n architecture — informs the messages.ts shape)
