// Server-side locale resolution. Precedence (most specific wins):
//
//   1. URL `?lang=` query param         — explicit override (debug + locale picker reload)
//   2. Cookie `dr3_locale`              — pre-auth picker preference
//   3. Active session's `users.locale`  — authenticated user preference
//   4. `'en'` default                   — never crash
//
// The cookie wins over the session because that's how the picker on
// /login works: tap "Español" → cookie set → reload renders Spanish
// immediately, even though no session exists yet. After the user
// signs in, `auth.ts` writes the cookie value into `users.locale` so
// the next session-based render lines up with the picker choice.

import 'server-only';
import { cookies } from 'next/headers';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { DEFAULT_LOCALE, LOCALE_COOKIE, type Locale, isLocale } from './config';

export interface LocaleContext {
  locale: Locale;
  source: 'query' | 'cookie' | 'session' | 'default';
}

// Page-level resolver. Reads cookies + (optionally) the active session.
// Pages should call this once near the top of the server component
// and pass the resolved locale down to children + client providers.
export async function resolveLocale(searchParams?: {
  lang?: string;
}): Promise<LocaleContext> {
  if (searchParams?.lang && isLocale(searchParams.lang)) {
    return { locale: searchParams.lang, source: 'query' };
  }
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(LOCALE_COOKIE)?.value;
  if (cookieValue && isLocale(cookieValue)) {
    return { locale: cookieValue, source: 'cookie' };
  }
  // Session lookup is the slowest of the three so we save it for last.
  // `auth()` short-circuits when no JWT is present, so the cost is
  // bounded for unauthenticated visitors.
  try {
    const session = await auth();
    if (session?.user?.id) {
      const user = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { locale: true },
      });
      if (user && isLocale(user.locale)) {
        return { locale: user.locale, source: 'session' };
      }
    }
  } catch {
    // `auth()` can throw if invoked outside a request context (e.g.
    // build-time generation). Falling through to the default is the
    // right behavior — locale is never load-bearing for SSG.
  }
  return { locale: DEFAULT_LOCALE, source: 'default' };
}

// Lighter variant for callers that have a `searchParams`-less route
// (most pages). The cookie + session checks are the same.
export async function getLocale(): Promise<Locale> {
  const ctx = await resolveLocale();
  return ctx.locale;
}
