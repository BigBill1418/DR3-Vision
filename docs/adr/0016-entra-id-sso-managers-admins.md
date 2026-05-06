# ADR-0016: Entra ID SSO-only for managers + admins; email+password removed

**Date:** 2026-05-06
**Status:** Accepted
**Supersedes:** the email+password Credentials provider in `auth.ts` and
the entire `/forgot-password` + `/reset-password` flow shipped in
Sprint-1.
**Touches:** ADR-0001 (tech stack — adds Entra to the dependency
surface), ADR-0004 (PIN auth — unaffected; operators are explicitly out
of scope here).

## Context

Sprint-1 shipped manager/admin authentication as Auth.js Credentials
(email + Argon2id password hash) plus a bespoke HMAC-signed
password-reset flow with email delivery via Resend. Two things changed:

1. SVdP / DR3 already issues Microsoft 365 work accounts to every
   manager and admin. Maintaining a parallel password store inside
   DR3-Vision adds onboarding friction (operator has to set a password
   on first login) and a recovery surface (the reset-token email path)
   that nothing else on the fleet exercises.
2. Bill's product call, verbatim:

   > "entra only - sso only for admins and managers"

   No fallback. No "in case Entra is down" magic-link. SSO-only means
   SSO-only.

Operators are unaffected. ADR-0004's PIN auth on the iPad is still the
right shape for a shared-device, single-tap workflow that has to work
when the warehouse Wi-Fi flaps.

## Decision

1. **Microsoft Entra ID is the only OAuth provider for managers and
   admins.** Declared in `src/lib/auth.config.ts` so the edge-runtime
   middleware can see it. Auto-reads `AUTH_MICROSOFT_ENTRA_ID_ID`,
   `AUTH_MICROSOFT_ENTRA_ID_SECRET`, and `AUTH_MICROSOFT_ENTRA_ID_ISSUER`
   per the Auth.js v5 convention.

2. **A `signIn` callback in `src/lib/auth.ts` is the authorization
   gate.** The Entra IdP authenticates "is this person a member of the
   tenant?"; the gate authorizes "is this person a `manager` or `admin`
   in DR3-Vision's `users` table?" The gate denies if:

   - the IdP didn't supply an email or `preferred_username`
   - no user matches the (lowercased) email
   - the user's `is_active` is false
   - the user's `deleted_at` is set
   - the user's role is not `manager` or `admin`

   The gate is exported as `evaluateEntraSignIn` for unit testing — see
   `src/lib/__tests__/auth.signin-gate.test.ts`.

3. **Email + password authentication is removed.** The Credentials
   provider that read `password_hash` is deleted. The
   `/forgot-password`, `/reset-password`, and corresponding API routes
   are deleted. `src/lib/password-reset-token.ts` and `src/lib/email.ts`
   are deleted (both were used only by the password-reset path).
   `src/middleware.ts`'s `PUBLIC_PATHS` no longer lists
   `/forgot-password` or `/reset-password`.

4. **The `password_hash` column is left in the schema, vestigial.** It
   is no longer read or written by any production code path. A
   Sprint-2 cleanup migration will drop the column. The seed script
   still tolerates the column being present; nothing else references
   it. Deferring the migration keeps this PR free of irreversible
   schema work and keeps the rollback story simple (`git revert` is
   sufficient — the DB is unchanged).

5. **The login page is rewritten** to a single "Sign in with Microsoft"
   call-to-action plus the existing locale picker. `error=AccessDenied`
   from NextAuth (set when `signIn` returns false) is rendered as a
   localized "your account isn't authorized" message in EN / ES / UR.
   `error=Configuration` (Entra env vars unset) is rendered as
   "Microsoft sign-in isn't configured yet" so an operator knows to
   ping an admin.

6. **Operator PIN flow is untouched.** The `pin` Credentials provider,
   `src/lib/pin-service.ts`, the PIN lockout state machine, the
   `/operator` route group — none of it is modified. The `signIn`
   callback short-circuits to `return true` when
   `account.provider === 'pin'` because the Credentials `authorize`
   callback already enforced its own rules.

## Alternatives considered

- **Add Entra alongside email+password as a second option.** Rejected
  because Bill's directive was explicit ("entra only"), and the dual
  surface multiplies test paths, doc burden, and the surface area an
  attacker can poke at.
- **Use the Auth.js Prisma adapter for a database session.** Rejected
  because Sprint-1 already standardized on JWT sessions (the operator
  PIN flow benefits from edge-runtime session checks, the manager flow
  is fine on JWT, and mixing strategies per provider is messier than
  pinning JWT for both).
- **Drop the `password_hash` column in this PR.** Rejected — schema
  changes belong in their own change with a migration and a rollback
  drill. This PR is reversible by `git revert` alone.
- **Use `/common/v2.0/` as the issuer.** Rejected — the tenant-specific
  issuer rejects foreign Microsoft accounts at the IdP step before the
  application gate even runs. Defense-in-depth.
- **Magic-link / email fallback for "Entra is down" days.** Rejected
  per Bill: "SSO-only means SSO-only." If Entra has a 24-hour outage,
  the right response is to wait for Microsoft, not to ship a separate
  identity surface that someone will eventually leave enabled.

## Consequences

- **Onboarding for managers/admins is now**: admin adds the user's
  `users` row (with their work email) via the Settings panel — that's
  it. No password to set, no reset email to wait for. The user clicks
  "Sign in with Microsoft" and they're in.
- **Recovery is now**: there's nothing to recover. If a user is locked
  out, an admin checks their `is_active` flag.
- **The `users.password_hash` column is queued for removal.** Tracked
  in `CHANGELOG.md` and to be done in a dedicated Sprint-2 cleanup
  migration.
- **Tenant-level access policy is now load-bearing.** If a manager
  leaves the org and their Entra account is disabled, they cannot sign
  in regardless of `is_active`. (Conversely, ADR-0016 §2 is the gate
  that catches accounts that are still in Entra but have been
  retired in DR3-Vision.)
- **Test surface added**: `src/lib/__tests__/auth.signin-gate.test.ts`
  covers seven gate paths. The existing PIN-flow tests (if any) and
  e2e operator tests are untouched.
- **No new dependencies.** The Entra provider ships in `next-auth` —
  no `package.json` change.
- **Operator runbook**: `docs/operator/entra-id-setup.md` is the
  step-by-step Bill-side procedure for registering the Azure App,
  capturing the IDs, minting a secret, and dropping the values onto
  CHAD-HQ.

## References

- Auth.js v5 Microsoft Entra ID provider:
  <https://authjs.dev/getting-started/providers/microsoft-entra-id>
- Microsoft identity platform — register an application:
  <https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app>
- Microsoft identity platform — ID token claims reference:
  <https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference>
- ADR-0004 (PIN authentication — operator flow, unchanged).
