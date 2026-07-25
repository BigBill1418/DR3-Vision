'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale } from '@/i18n/provider';
import { LOCALES, LOCALE_LABELS, type Locale } from '@/i18n/config';
import { setFloorLocaleAction } from '@/i18n/actions';

// Floor locale switcher (ADR-0061 D-1/D-2/D-3). Floor operators sign in by
// PIN and never reach /login, so the /login LocalePicker is unreachable to
// them. This switcher is mounted on the operator shell (every operator
// screen, including the pre-auth sign-in trio), giving a Spanish/Urdu
// operator a way to:
//
//   - read the sign-in screens in their language BEFORE authenticating
//     (pre-auth → sets the display-hint cookie), and
//   - persist their language to `users.locale` once signed in (post-auth →
//     `setFloorLocaleAction` writes the user record directly), so every
//     future shift renders in their language on any iPad.
//
// It is deliberately placed in the top-corner CHROME, out of the RTL-forced
// numeric zones (keypad / steppers), and floats over any page background so
// it stays legible on both the black sign-in screens and the green shell.
// Buttons are ≥44px tap targets (gloved-hand / ADR-0060 sizing) and each
// label is written in its own script with a matching `lang` attribute.

export function FloorLocaleSwitcher() {
  const router = useRouter();
  const current = useLocale();
  const [isPending, startTransition] = useTransition();

  const pick = (loc: Locale) => {
    if (isPending || loc === current) return;
    startTransition(async () => {
      await setFloorLocaleAction(loc);
      router.refresh();
    });
  };

  return (
    <div
      // Logical `end` keeps it in the trailing top corner in both LTR and RTL.
      className="fixed end-3 top-3 z-50 flex gap-1 rounded-xl border border-white/15 bg-black/55 p-1 backdrop-blur-sm"
      role="group"
      aria-label="Language"
    >
      {LOCALES.map((loc) => {
        const active = loc === current;
        return (
          <button
            key={loc}
            type="button"
            disabled={isPending || active}
            onClick={() => pick(loc)}
            aria-pressed={active}
            lang={loc}
            className={`flex min-h-11 min-w-11 items-center justify-center rounded-lg px-3 text-base font-semibold transition-colors ${
              active
                ? 'bg-dr3-green text-dr3-ink'
                : 'text-white/85 hover:bg-white/10 disabled:cursor-not-allowed'
            }`}
          >
            {LOCALE_LABELS[loc]}
          </button>
        );
      })}
    </div>
  );
}
