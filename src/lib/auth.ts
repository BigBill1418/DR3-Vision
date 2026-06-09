import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { verifyPin } from '@/lib/pin-service';
import { authConfig } from '@/lib/auth.config';
import { LOCALE_COOKIE, isLocale } from '@/i18n/config';

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

// Mirror the pre-auth `dr3_locale` cookie to `users.locale` on a
// successful sign-in. Per T-008 acceptance: the locale picker on
// /login persists per-user, so the user's NEXT device login (which
// may not carry the cookie) starts in the right language. Operator
// PIN sign-in does the same, so a tap on "Español" before PIN entry
// sticks for the operator's name on that iPad and on every other
// iPad they sign in to.
async function mirrorLocaleCookie(userId: string): Promise<void> {
  try {
    const store = await cookies();
    const value = store.get(LOCALE_COOKIE)?.value;
    if (!value || !isLocale(value)) return;
    await prisma.user.update({
      where: { id: userId },
      data: { locale: value },
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
  is_active: boolean;
  deleted_at: Date | null;
}

export type EntraGateResult =
  | { ok: true; user: EntraGateUser }
  | { ok: false; reason: 'no_email' | 'unknown' | 'inactive' | 'deleted' | 'wrong_role' };

export async function evaluateEntraSignIn(profile: EntraGateProfile): Promise<EntraGateResult> {
  const raw = profile.email ?? profile.preferred_username ?? '';
  const email = raw.trim().toLowerCase();
  if (!email) return { ok: false, reason: 'no_email' };

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      primary_site_id: true,
      all_sites: true,
      is_active: true,
      deleted_at: true,
    },
  });
  if (!user) return { ok: false, reason: 'unknown' };
  if (user.deleted_at) return { ok: false, reason: 'deleted' };
  if (!user.is_active) return { ok: false, reason: 'inactive' };
  if (user.role !== 'manager' && user.role !== 'admin') {
    return { ok: false, reason: 'wrong_role' };
  }
  return { ok: true, user };
}

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
