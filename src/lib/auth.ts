import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { verifyPassword } from '@/lib/argon';
import { verifyPin } from '@/lib/pin-service';
import { authConfig } from '@/lib/auth.config';

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
