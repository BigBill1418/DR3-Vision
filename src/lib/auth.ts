import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { verifyPassword } from '@/lib/argon';
import { verifyPin } from '@/lib/pin-service';
import { authConfig } from '@/lib/auth.config';
import { LOCALE_COOKIE, isLocale } from '@/i18n/config';

// Full Node-runtime auth config. The Credentials provider's
// `authorize` callback hits Prisma; this file therefore only loads
// in the Node runtime (route handlers). Middleware uses
// `auth.config.ts` instead, which has no DB-touching providers.

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(256),
});

const pinSchema = z.object({
  user_id: z.string().min(1),
  pin: z.string().regex(/^\d{4}$/),
});

const SEED_PLACEHOLDER_HASH = 'pending_first_password_reset';

// Mirror the pre-auth `dr3_locale` cookie to `users.locale` on a
// successful credentials login. Per T-008 acceptance: the locale
// picker on /login persists per-user, so the user's NEXT device login
// (which may not carry the cookie) starts in the right language.
// Operator PIN sign-in does the same, so a tap on "Español" before
// PIN entry sticks for the operator's name on that iPad and on every
// other iPad they sign in to.
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

export const { auth, handlers, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const parsed = credentialsSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const user = await prisma.user.findUnique({
          where: { email: parsed.data.email },
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            primary_site_id: true,
            password_hash: true,
            is_active: true,
          },
        });
        if (!user) return null;
        if (!user.is_active) return null;
        if (!user.password_hash) return null;
        if (user.password_hash === SEED_PLACEHOLDER_HASH) return null;

        const ok = await verifyPassword(user.password_hash, parsed.data.password);
        if (!ok) return null;

        await prisma.user.update({
          where: { id: user.id },
          data: { last_login_at: new Date() },
        });
        await mirrorLocaleCookie(user.id);

        return {
          id: user.id,
          email: user.email ?? '',
          name: user.name,
          role: user.role,
          primary_site_id: user.primary_site_id,
        };
      },
    }),
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
        };
      },
    }),
  ],
});
