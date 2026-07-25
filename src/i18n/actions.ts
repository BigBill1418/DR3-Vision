'use server';

// Server actions for the locale pickers (the /login manager picker and the
// operator floor switcher). Shared, shared-device-safe implementation per
// ADR-0061:
//
//   - When a SESSION is active, the choice is written straight to
//     `users.locale` — the authoritative per-operator preference that
//     resolution now prefers (session-first, D-4). This is the write path a
//     signed-in floor operator triggers with the on-shell switcher (D-3).
//   - When there is NO session (the pre-auth sign-in screens), we set the
//     `dr3_locale` display-hint cookie so those screens localize immediately
//     (D-2), PLUS a short-lived `dr3_locale_pick` marker recording that the
//     operator DELIBERATELY chose this language. On the imminent sign-in,
//     `auth.ts`'s `mirrorLocaleCookie` folds the marker into `users.locale`
//     (D-3 first-shift) and clears it. An ambient device cookie with no
//     marker is never folded — that is the D-4 anti-corruption guarantee.

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE_S,
  LOCALE_COOKIE_SHIFT_MAX_AGE_S,
  LOCALE_PICK_COOKIE,
  LOCALE_PICK_COOKIE_MAX_AGE_S,
  type Locale,
  isLocale,
} from './config';

type CookieStore = Awaited<ReturnType<typeof cookies>>;

function setDisplayCookie(store: CookieStore, locale: Locale, maxAge: number): void {
  store.set(LOCALE_COOKIE, locale, {
    maxAge,
    httpOnly: false, // read by client hydration paths + resolution
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}

function setPickMarker(store: CookieStore, locale: Locale): void {
  store.set(LOCALE_PICK_COOKIE, locale, {
    maxAge: LOCALE_PICK_COOKIE_MAX_AGE_S,
    httpOnly: true, // only the server (mirrorLocaleCookie) consumes it
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}

function clearPickMarker(store: CookieStore): void {
  store.set(LOCALE_PICK_COOKIE, '', {
    maxAge: 0,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}

// `shiftScopedHint` shortens the display-cookie TTL for the floor path so a
// shared kiosk does not carry a stale pre-auth language onto the next
// operator (D-4). The /login manager picker keeps the long TTL (its device
// is typically personal, and session-first resolution makes the length
// harmless anyway).
async function applyLocaleSelection(locale: string, shiftScopedHint: boolean): Promise<void> {
  if (!isLocale(locale)) return;
  const typed: Locale = locale;
  const store = await cookies();

  // Persist to the authenticated user directly when a session exists — this
  // is the durable, session-first source of truth (D-3). No marker needed;
  // clear any stale one so it can't re-apply on a later shared-device login.
  let hasSession = false;
  try {
    const session = await auth();
    if (session?.user?.id) {
      hasSession = true;
      await prisma.user.update({
        where: { id: session.user.id },
        data: { locale: typed },
      });
      clearPickMarker(store);
    }
  } catch {
    // Never fail the picker because session lookup choked — same rationale
    // as get-locale.ts. Fall through to the pre-auth path.
  }

  setDisplayCookie(
    store,
    typed,
    shiftScopedHint ? LOCALE_COOKIE_SHIFT_MAX_AGE_S : LOCALE_COOKIE_MAX_AGE_S,
  );

  // Pre-auth pick: record explicit intent so sign-in folds it into
  // users.locale (D-3 first-shift) without an ambient cookie being able to
  // corrupt a stored preference (D-4).
  if (!hasSession) setPickMarker(store, typed);

  revalidatePath('/', 'layout');
}

// /login manager picker.
export async function setLocaleAction(locale: string): Promise<void> {
  await applyLocaleSelection(locale, false);
}

// Operator floor switcher (mounted on the operator shell). Uses the
// shift-scoped display-hint TTL.
export async function setFloorLocaleAction(locale: string): Promise<void> {
  await applyLocaleSelection(locale, true);
}
