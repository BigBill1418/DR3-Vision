import type { DefaultSession, DefaultUser } from 'next-auth';
import type { JWT as DefaultJWT } from 'next-auth/jwt';
import type { UserRole } from '@prisma/client';

declare module 'next-auth' {
  interface User extends DefaultUser {
    role: UserRole;
    primary_site_id: string | null;
  }

  interface Session extends DefaultSession {
    user: {
      id: string;
      email: string;
      name: string;
      role: UserRole;
      primary_site_id: string | null;
    } & DefaultSession['user'];
  }
}

declare module 'next-auth/jwt' {
  interface JWT extends DefaultJWT {
    role?: UserRole;
    primary_site_id?: string | null;
    last_seen_at?: number;
    // Microsoft Graph delegated access token (User.Read), persisted from the Entra
    // sign-in so the server-only /api/me/photo route can fetch the profile photo
    // (ADR-0020 / T-119). Kept in the (encrypted) JWT, NEVER exposed in the Session.
    ms_access_token?: string;
    ms_access_token_exp?: number; // epoch seconds
  }
}
