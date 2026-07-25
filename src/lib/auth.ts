import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { verifyPin } from '@/lib/pin-service';
import { authConfig, setRevocationChecker, type RevocationVerdict } from '@/lib/auth.config';
import { LOCALE_PICK_COOKIE, isLocale } from '@/i18n/config';
import { log } from '@/lib/observability/logger';

// Full Node-runtime auth config. Two providers ride on this file:
//
//   1. Microsoft Entra ID (declared in `auth.config.ts` so the edge
//      middleware sees it). The `signIn` callback below is the
//      authorization gate — it reads Prisma to confirm the IdP-
//      authenticated email maps to an active manager/admin row, and
//      denies entry otherwise. Without this gate, ANY user in the
//      configured Entra tenant could sign in.
//
//   2. Operator PIN (declared here, not in auth.config.ts). PIN auth
//      reads Prisma in `verifyPin`, so it's Node-only.
//
// Email + password authentication has been removed (ADR-0016). The
// `password_hash` column on `users` was dropped in the Sprint-2
// cleanup migration `20260506215753_drop_user_password_hash`.
//
// If the Entra env vars are unset at deploy time, the Entra provider
// is still mounted but every OAuth round-trip fails at the IdP step.
// Operators see a clean "couldn't sign in with Microsoft" message
// from Auth.js's default error page rather than a 500. The login
// page also surfaces a one-line warning when no Entra vars are
// configured (see `LoginForm`).

const pinSchema = z.object({
  user_id: z.string().min(1),
  pin: z.string().regex(/^\d{4}$/),
});

// Fold an EXPLICIT pre-auth locale pick into `users.locale` on a successful
// sign-in (ADR-0061 D-3/D-4). The `dr3_locale_pick` marker is set by the
// locale picker ONLY when the operator deliberately chose a language with no
// session yet (the sign-in screens); its presence means "persist this to the
// user who is about to authenticate." So a tap on "Español" before PIN entry
// sticks for that operator and follows them to every iPad.
//
// Critically, the ambient device `dr3_locale` cookie is NEVER folded here.
// On a shared floor iPad that cookie is device-global; folding it (the old
// T-008 behavior) let one manager's pick overwrite each operator's stored
// preference on every sign-in. Gating on the explicit marker instead is the
// D-4 anti-corruption fix: with no marker, `users.locale` is left untouched
// and the session-first resolver renders the operator's own language.
//
// Exported for unit testing.
export async function mirrorLocaleCookie(userId: string): Promise<void> {
  try {
    const store = await cookies();
    const pick = store.get(LOCALE_PICK_COOKIE)?.value;
    if (!pick || !isLocale(pick)) return;
    await prisma.user.update({
      where: { id: userId },
      data: { locale: pick },
    });
    // Consume the marker so it cannot re-apply to an unrelated later operator
    // signing in on the same shared device.
    store.set(LOCALE_PICK_COOKIE, '', {
      maxAge: 0,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    });
  } catch {
    // Non-fatal — locale persistence is a UX nicety, not a security
    // gate. Failures here MUST NOT block sign-in.
  }
}

// ─────────────────────────────────────────────────────────────────────
// Entra signIn gate
// ─────────────────────────────────────────────────────────────────────
//
// Exported for unit testing. Returns true to allow the sign-in,
// false to deny. Mutates `last_login_at` and mirrors the locale
// cookie on the allow path.
//
// Authorization rules (intentionally strict):
//   - the IdP-supplied email must match an active, non-deleted user
//   - the user's role must be `manager` or `admin` — operators do
//     NOT sign in via Entra; they use the PIN flow on /operator
//   - email comparison is case-insensitive (Entra preserves casing
//     idiosyncratically; we lowercase on both sides)
//
// Note on token shape: NextAuth passes `profile` as the IdP-returned
// claims. For Entra OIDC the email claim is `email`; if it's missing
// (e.g. the tenant didn't include it as an optional claim) we fall
// back to `preferred_username`, which is also typed as a string but
// not guaranteed to be RFC-822 — the DB lookup will simply miss.

export interface EntraGateProfile {
  email?: string | null;
  preferred_username?: string | null;
}

export interface EntraGateUser {
  id: string;
  email: string | null;
  name: string;
  role: 'operator' | 'manager' | 'admin';
  primary_site_id: string | null;
  all_sites: boolean;
  is_super_admin: boolean;
  is_active: boolean;
  deleted_at: Date | null;
}

export type EntraGateResult =
  | { ok: true; user: EntraGateUser }
  | { ok: false; reason: 'no_email' | 'unknown' | 'inactive' | 'deleted' | 'wrong_role' };

export async function evaluateEntraSignIn(profile: EntraGateProfile): Promise<EntraGateResult> {
  const raw = profile.email ?? profile.preferred_username ?? '';
  const email = raw.trim().toLowerCase();

  // Log every denial with the attempted email + reason. Without this, a
  // rejected sign-in is an opaque `AccessDenied` with no way to tell whether
  // the email is misspelled, inactive, etc. (cost us hours when
  // janette.tomas@ couldn't sign in — her row had the surname misspelled).
  // The email is an identifier, not a secret (unlike pin_hash); it is safe and
  // necessary to log for support.
  const deny = (reason: Extract<EntraGateResult, { ok: false }>['reason']): EntraGateResult => {
    log.warn(
      { event: 'entra_signin_denied', email: email || null, reason },
      'Entra sign-in denied',
    );
    return { ok: false, reason };
  };

  if (!email) return deny('no_email');

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      primary_site_id: true,
      all_sites: true,
      is_super_admin: true,
      is_active: true,
      deleted_at: true,
    },
  });
  if (!user) return deny('unknown');
  if (user.deleted_at) return deny('deleted');
  if (!user.is_active) return deny('inactive');
  if (user.role !== 'manager' && user.role !== 'admin') {
    return deny('wrong_role');
  }
  return { ok: true, user };
}

// ─────────────────────────────────────────────────────────────────────
// ADR-0053 D2 — session revocation kill-switch (Node-runtime checker)
// ─────────────────────────────────────────────────────────────────────
//
// Registered into `auth.config.ts`'s jwt callback via `setRevocationChecker`.
// Runs on every non-initial jwt pass in the Node runtime (the authorization
// boundary: every sensitive route/RSC re-enters Node through `auth()`). One
// narrow, PK-indexed lookup:
//
//   - user row gone / `!is_active` / `deleted_at` set → REVOKE. This fires even
//     without a switch bump — belt-and-suspenders defense-in-depth on top of the
//     Entra signIn gate (which only runs at sign-in).
//   - `sessions_invalidated_at` set AND strictly newer than the token's
//     issued-at → REVOKE (force re-auth). `iat` is seconds; the column is a
//     millisecond-precision instant — compare in the same unit
//     (`getTime() > iat * 1000`). A token issued AFTER the bump survives; one
//     issued BEFORE is revoked. On re-auth the token is reminted with fresh
//     claims, so a role change (which bumps the switch) also lands the demotion.
//
// `iat` tracks the last time Auth.js persisted the cookie. With the default
// `updateAge` (24h — no override here) it stays ≈ sign-in time, so the compare
// is robust; and it fails CLOSED (an extra re-auth) rather than open at the
// second boundary. Exported for unit testing.
export async function checkTokenRevocation(
  userId: string,
  tokenIatSeconds: number,
): Promise<RevocationVerdict> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { is_active: true, deleted_at: true, sessions_invalidated_at: true },
  });
  if (!u) return 'revoke';
  if (!u.is_active || u.deleted_at) return 'revoke';
  if (u.sessions_invalidated_at && u.sessions_invalidated_at.getTime() > tokenIatSeconds * 1000) {
    return 'revoke';
  }
  return 'ok';
}

setRevocationChecker(checkTokenRevocation);

export const { auth, handlers, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    ...authConfig.providers,
    Credentials({
      id: 'pin',
      name: 'Operator PIN',
      credentials: {
        user_id: { label: 'Operator', type: 'text' },
        pin: { label: 'PIN', type: 'password' },
      },
      async authorize(credentials) {
        const parsed = pinSchema.safeParse(credentials);
        if (!parsed.success) return null;
        const result = await verifyPin(parsed.data.user_id, parsed.data.pin);
        if (!result.ok) return null;
        const user = await prisma.user.findUnique({
          where: { id: result.userId },
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            primary_site_id: true,
          },
        });
        if (!user) return null;
        await mirrorLocaleCookie(user.id);
        return {
          id: user.id,
          email: user.email ?? '',
          name: user.name,
          role: user.role,
          primary_site_id: user.primary_site_id,
          all_sites: false, // operators are single-site (PIN flow); never all-sites
          is_super_admin: false, // operators are never super-admin (ADR-0030)
        };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user, account, profile }) {
      // Operator PIN flow: the credentials provider already enforced
      // its own rules in `authorize`. Allow unconditionally here.
      if (account?.provider === 'pin') return true;

      // Microsoft Entra ID: enforce the manager/admin gate.
      if (account?.provider === 'microsoft-entra-id') {
        const result = await evaluateEntraSignIn(profile ?? {});
        if (!result.ok) return false;

        // Mutate the `User` object NextAuth is about to hand off to
        // the `jwt` callback so it carries our DB-derived role +
        // primary_site_id (the IdP profile doesn't know either).
        user.id = result.user.id;
        user.email = result.user.email ?? '';
        user.name = result.user.name;
        user.role = result.user.role;
        user.primary_site_id = result.user.primary_site_id;
        user.all_sites = result.user.all_sites; // ADR-0024 all-sites manager
        user.is_super_admin = result.user.is_super_admin; // ADR-0030 super-admin

        await prisma.user.update({
          where: { id: result.user.id },
          data: { last_login_at: new Date() },
        });
        await mirrorLocaleCookie(result.user.id);
        return true;
      }

      // Unknown provider: deny by default.
      return false;
    },
  },
});
