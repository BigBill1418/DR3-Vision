import type { NextAuthConfig } from 'next-auth';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';

// Edge-runtime-safe base config. The middleware imports this rather
// than the full `auth.ts` because `auth.ts` brings in the Prisma
// client (via the Credentials authorize callback), which does NOT
// run in the edge runtime.
//
// Provider strategy (ADR-0016):
//   - Microsoft Entra ID is the ONLY OAuth provider for managers and
//     admins. Declared here because OIDC providers don't touch the DB
//     during the edge-runtime middleware pass — they're constructed
//     from env vars and validated in the OAuth callback (Node runtime).
//   - The operator PIN provider is a Credentials provider that reads
//     Prisma, so it stays in `auth.ts`.
//   - Email + password is REMOVED. There is no fallback path.
//
// The `signIn` gate that decides whether an Entra-authenticated user
// is allowed in (must be a manager/admin with an active row) lives in
// `auth.ts` — it does Prisma reads, so it can't be edge-resident.
//
// Per Auth.js v5 convention, the provider auto-reads
// `AUTH_MICROSOFT_ENTRA_ID_ID` / `_SECRET` / `_ISSUER` from env. We
// pass empty-string fallbacks so the provider can be constructed in
// environments where the secrets aren't yet populated (e.g. CI before
// the operator runbook in `docs/operator/entra-id-setup.md` has been
// run). In that state the OAuth round-trip will fail at the IdP step
// rather than at module-load time.

// Per-role idle timeouts. Managers/admins follow the SPRINT-1-PLAN
// T-003 contract (12h idle / 30d absolute). Operators on shared
// forklift iPads run a much tighter loop per ADR-0004 — 5 min idle —
// to limit who can hijack the iPad if the operator walks away.
const IDLE_TIMEOUT_MANAGER_S = 12 * 60 * 60; //  12h
const IDLE_TIMEOUT_OPERATOR_S = 5 * 60; //  5min
const ABSOLUTE_TIMEOUT_S = 30 * 24 * 60 * 60; //  30d

function idleTimeoutFor(role: string | undefined): number {
  return role === 'operator' ? IDLE_TIMEOUT_OPERATOR_S : IDLE_TIMEOUT_MANAGER_S;
}

// ─────────────────────────────────────────────────────────────────────
// ADR-0053 D2 — session revocation kill-switch (Node-only checker hook)
// ─────────────────────────────────────────────────────────────────────
//
// This file is the EDGE-runtime-safe base config (the middleware imports it,
// not `auth.ts`). A Prisma call cannot live here directly — it would pull the
// client into the edge bundle and break the middleware build, which is the
// whole reason this file is Prisma-free.
//
// So the revocation check is dependency-injected: `auth.ts` (Node runtime)
// registers a checker via `setRevocationChecker` at module load. The jwt
// callback below calls it on every non-initial pass. In the edge middleware the
// hook is never registered (auth.ts is never imported there), so the callback
// skips the DB read and relies on idle/absolute timeout only — and the
// authoritative kill-switch check runs on every Node route/RSC pass, which is
// the real authorization boundary (every sensitive surface re-enters Node via
// `auth()` from auth.ts). Belt-and-suspenders on top of the Entra signIn gate.
export type RevocationVerdict = 'ok' | 'revoke';
type RevocationChecker = (userId: string, tokenIatSeconds: number) => Promise<RevocationVerdict>;

let revocationChecker: RevocationChecker | null = null;

/** Wire (or clear, with null) the Node-only revocation checker. Called by
 * `auth.ts` at module load. No-op'd on edge because auth.ts never loads there. */
export function setRevocationChecker(fn: RevocationChecker | null): void {
  revocationChecker = fn;
}

export const authConfig = {
  session: { strategy: 'jwt', maxAge: ABSOLUTE_TIMEOUT_S },
  trustHost: true,
  // Route every Auth.js error back to /login?error=<code> so the styled
  // login surface handles the message instead of the bare-bones built-in
  // /api/auth/error page. Most user-facing path: a stale OAuth callback
  // (back-button after a successful sign-in) becomes a clean "Session
  // expired" hint instead of a "Server error / configuration problem".
  pages: { signIn: '/login', error: '/login' },
  providers: [
    MicrosoftEntraID({
      clientId: process.env['AUTH_MICROSOFT_ENTRA_ID_ID'] ?? '',
      clientSecret: process.env['AUTH_MICROSOFT_ENTRA_ID_SECRET'] ?? '',
      issuer: process.env['AUTH_MICROSOFT_ENTRA_ID_ISSUER'] ?? '',
      // User.Read so the resulting access token can fetch /me/photo (ADR-0020 /
      // T-119). These are standard pre-consented delegated scopes; SSO is unchanged.
      authorization: { params: { scope: 'openid profile email User.Read' } },
    }),
  ],
  callbacks: {
    async jwt({ token, user, account }) {
      const nowS = Math.floor(Date.now() / 1000);
      if (user) {
        if (user.id) token.sub = user.id;
        if (user.email != null) token.email = user.email;
        if (user.name != null) token.name = user.name;
        token.role = user.role;
        token.primary_site_id = user.primary_site_id;
        token.all_sites = user.all_sites; // ADR-0024 all-sites manager
        token.is_super_admin = user.is_super_admin; // ADR-0030 super-admin
        // Persist the Graph access token from the Entra sign-in (T-119). Server-only
        // (the session callback never copies it out); used by /api/me/photo.
        if (account?.provider === 'microsoft-entra-id' && account.access_token) {
          token.ms_access_token = account.access_token;
          token.ms_access_token_exp =
            typeof account.expires_at === 'number' ? account.expires_at : nowS + 3000;
        }
        token.last_seen_at = nowS;
        return token;
      }
      const idleS = idleTimeoutFor(token.role);
      if (token.last_seen_at && nowS - token.last_seen_at > idleS) {
        return {} as typeof token;
      }
      // ADR-0053 D2 — session revocation kill-switch. On the Node pass the
      // checker is wired to a fresh, PK-indexed users lookup; on edge it is null
      // and we skip (idle/absolute still apply, and the Node pass on every route
      // enforces this). Returning {} mirrors the idle-timeout path: the emptied
      // token carries no `sub`, so every downstream guard sees no `user.id` and
      // 401s / redirects — forcing re-auth, which remints fresh claims (this is
      // also how a demotion takes effect: the role change bumped the switch).
      if (revocationChecker && token.sub && typeof token.iat === 'number') {
        const verdict = await revocationChecker(token.sub, token.iat);
        if (verdict === 'revoke') return {} as typeof token;
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
      session.user.all_sites = token.all_sites === true; // ADR-0024 (default false)
      session.user.is_super_admin = token.is_super_admin === true; // ADR-0030 (default false)
      return session;
    },
  },
} satisfies NextAuthConfig;
