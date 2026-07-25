// Server-side locale resolution. Precedence (most specific wins) —
// SESSION-FIRST as of ADR-0061 D-4:
//
//   1. URL `?lang=` query param         — explicit override (debug only)
//   2. Active session's `users.locale`  — the signed-in operator's preference
//   3. Cookie `dr3_locale`              — PRE-AUTH display hint only
//   4. `'en'` default                   — never crash
//
// Why session beats the cookie (the D-4 fix): the floor iPad is SHARED.
// A device-global `dr3_locale` cookie that outranked the session let one
// person's pre-auth pick pin the whole shift's language and corrupt each
// operator's stored preference. Language must follow the *operator*, not
// the device. So once someone is signed in, THEIR `users.locale` wins; the
// cookie only localizes the pre-auth sign-in screens (where there is no
// session yet) — which is exactly what a Spanish/Urdu operator needs to
// read in order to sign in. See ADR-0061 and `i18n/actions.ts`.

import 'server-only';
import { cookies } from 'next/headers';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { DEFAULT_LOCALE, LOCALE_COOKIE, type Locale, isLocale } from './config';

export interface LocaleContext {
  locale: Locale;
  source: 'query' | 'session' | 'cookie' | 'default';
}

// Page-level resolver. Reads (optionally) the active session + cookies.
// Pages should call this once near the top of the server component
// and pass the resolved locale down to children + client providers.
export async function resolveLocale(searchParams?: { lang?: string }): Promise<LocaleContext> {
  if (searchParams?.lang && isLocale(searchParams.lang)) {
    return { locale: searchParams.lang, source: 'query' };
  }
  // Session first: the signed-in operator's stored preference outranks the
  // shared-device cookie. `auth()` short-circuits when no JWT is present, so
  // the cost is bounded for unauthenticated visitors (the sign-in screens).
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
    // build-time generation). Falling through is the right behavior —
    // locale is never load-bearing for SSG.
  }
  // Pre-auth hint: with no session, the cookie localizes the sign-in
  // screens so a non-English operator can read them.
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(LOCALE_COOKIE)?.value;
  if (cookieValue && isLocale(cookieValue)) {
    return { locale: cookieValue, source: 'cookie' };
  }
  return { locale: DEFAULT_LOCALE, source: 'default' };
}

// Lighter variant for callers that have a `searchParams`-less route
// (most pages). The cookie + session checks are the same.
export async function getLocale(): Promise<Locale> {
  const ctx = await resolveLocale();
  return ctx.locale;
}
