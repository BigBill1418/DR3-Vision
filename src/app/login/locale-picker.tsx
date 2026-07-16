'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useT, useLocale } from '@/i18n/provider';
import { LOCALES, LOCALE_LABELS, type Locale } from '@/i18n/config';
import { setLocaleAction } from '@/i18n/actions';

// Login-screen locale picker. Three buttons (EN / ES / UR) above the
// email input. Tapping fires the server action that writes the
// `dr3_locale` cookie + (when a session is active) the user's stored
// locale, then refreshes so the page re-renders in the chosen
// language.

export function LocalePicker() {
  const router = useRouter();
  const t = useT();
  const current = useLocale();
  const [isPending, startTransition] = useTransition();

  const pick = (loc: Locale) => {
    if (isPending || loc === current) return;
    startTransition(async () => {
      await setLocaleAction(loc);
      router.refresh();
    });
  };

  return (
    <div className="flex w-full flex-col gap-2 text-left">
      <span className="text-xs font-medium uppercase tracking-wide text-white/60">
        {t('auth_login.language_label')}
      </span>
      <div className="grid grid-cols-3 gap-2">
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
              className={`rounded-md border px-3 py-2 text-sm font-semibold transition-colors ${
                active
                  ? 'border-dr3-cyan bg-dr3-cyan/20 text-dr3-mist'
                  : 'border-white/20 bg-white/5 text-white/80 hover:bg-white/10'
              } disabled:cursor-not-allowed`}
            >
              {LOCALE_LABELS[loc]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
