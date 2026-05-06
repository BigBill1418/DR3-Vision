import type { NextAuthConfig } from 'next-auth';

// Edge-runtime-safe base config. The middleware imports this rather
// than the full `auth.ts` because `auth.ts` brings in the Prisma
// client (via the Credentials authorize callback), which does NOT
// run in the edge runtime.
//
// The Credentials provider itself is added in `auth.ts`, where it can
// reach Prisma. The `jwt` and `session` callbacks here are pure
// transforms over the token + session — no DB reads — so they're
// edge-safe and shared with the full Node config.

const IDLE_TIMEOUT_S = 12 * 60 * 60; //  12h
const ABSOLUTE_TIMEOUT_S = 30 * 24 * 60 * 60; //  30d

export const authConfig = {
  session: { strategy: 'jwt', maxAge: ABSOLUTE_TIMEOUT_S },
  trustHost: true,
  pages: { signIn: '/login' },
  providers: [],
  callbacks: {
    async jwt({ token, user }) {
      const nowS = Math.floor(Date.now() / 1000);
      if (user) {
        if (user.id) token.sub = user.id;
        if (user.email != null) token.email = user.email;
        if (user.name != null) token.name = user.name;
        token.role = user.role;
        token.primary_site_id = user.primary_site_id;
        token.last_seen_at = nowS;
        return token;
      }
      if (token.last_seen_at && nowS - token.last_seen_at > IDLE_TIMEOUT_S) {
        return {} as typeof token;
      }
      token.last_seen_at = nowS;
      return token;
    },
    async session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      if (token.role) session.user.role = token.role;
      if (token.primary_site_id !== undefined) {
        session.user.primary_site_id = token.primary_site_id;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
