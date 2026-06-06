'use server';

// Server actions for the admin bonus site picker (ADR-0019.2 §1/§6, T-210).
//
// Admins (Bill, Kelsey) reach BOTH bonus sites. Their picked site persists in a
// `dr3_bonus_site` cookie so every `/bonus/**` route in the session scopes to it
// until they "switch". Single-site users (Janette, Rick, Morena) never call
// these — their site is derived from `checkBonusAccess()` and the cookie is
// ignored (the matrix can't be widened by a stale cookie).
//
// Mirrors the locale-picker pattern in `src/i18n/actions.ts`: write the cookie,
// then revalidate. We re-check access server-side before persisting so a
// non-admin can never pin themselves to a site they may not see.

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import {
  checkBonusAccess,
  parseSiteCode,
  BONUS_SITE_COOKIE,
  type SiteCode,
} from '@/lib/bonus/access';

const ONE_DAY_S = 60 * 60 * 24;

/** Persist the picked bonus site and land on the daily-entry grid for it. */
export async function pickBonusSiteAction(formData: FormData): Promise<void> {
  const site = parseSiteCode(formData.get('site')?.toString());
  if (!site) return;

  // Re-derive access server-side; never trust the form value (hard rule #2).
  const session = await auth();
  const access = await checkBonusAccess(session, site);
  if (!access.allowed) return;

  await setBonusSiteCookie(site);
  revalidatePath('/bonus', 'layout');
  redirect(`/bonus?site=${site}`);
}

/** Clear the picked site and return an admin to the picker. */
export async function switchBonusSiteAction(): Promise<void> {
  const store = await cookies();
  store.delete(BONUS_SITE_COOKIE);
  revalidatePath('/bonus', 'layout');
  redirect('/bonus');
}

async function setBonusSiteCookie(site: SiteCode): Promise<void> {
  const store = await cookies();
  store.set(BONUS_SITE_COOKIE, site, {
    maxAge: ONE_DAY_S,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}
