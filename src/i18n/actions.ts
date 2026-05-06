'use server';

// Server actions for the locale picker. Writes the cookie + (when a
// session exists) the user's stored locale, so a sign-in via the
// matching device persists the preference fleet-wide.

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE_S,
  type Locale,
  isLocale,
} from './config';

export async function setLocaleAction(locale: string): Promise<void> {
  if (!isLocale(locale)) return;
  const typed: Locale = locale;
  const cookieStore = await cookies();
  cookieStore.set(LOCALE_COOKIE, typed, {
    maxAge: LOCALE_COOKIE_MAX_AGE_S,
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
  // If a session is active, persist to the user record so their next
  // device login starts in the right language. Operator devices
  // typically pick the locale BEFORE signing in (no session yet) — in
  // that case we rely on `auth.ts` to mirror cookie → user.locale on
  // successful authentication.
  try {
    const session = await auth();
    if (session?.user?.id) {
      await prisma.user.update({
        where: { id: session.user.id },
        data: { locale: typed },
      });
    }
  } catch {
    // Same rationale as `get-locale.ts`: never fail the picker because
    // session lookup choked.
  }
  revalidatePath('/', 'layout');
}
