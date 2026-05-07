'use client';

// Client-side i18n provider. Receives the dictionary + locale from
// the parent server component (zero client-side fetch). Exposes a
// `useT()` hook that does dot-path lookup + interpolation +
// pluralization on the in-memory dict.
//
// The dictionary is small (~3 KB / locale gz) and inlined into the
// RSC payload — no streaming behavior, no flash of untranslated
// content.
//
// Two namespaces share this provider: operator (iPad, mounted under
// the operator route group) and manager (dashboard, mounted under the
// dashboard route group). The dict shape is unioned so consumer hook
// call sites stay identical regardless of which surface they render in.

import { createContext, useCallback, useContext, useMemo } from 'react';
import type { Locale } from './config';
import {
  type Dictionary,
  type ManagerDictionary,
  type TranslateVars,
  translate,
  translatePlural,
} from './dictionary';

type AnyDictionary = Dictionary | ManagerDictionary;

interface I18nContextValue {
  locale: Locale;
  dict: AnyDictionary;
  t: (key: string, vars?: TranslateVars) => string;
  tPlural: (baseKey: string, count: number, vars?: TranslateVars) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  locale,
  dict,
  children,
}: {
  locale: Locale;
  dict: AnyDictionary;
  children: React.ReactNode;
}) {
  const t = useCallback(
    (key: string, vars?: TranslateVars) => translate(dict, key, vars),
    [dict],
  );
  const tPlural = useCallback(
    (baseKey: string, count: number, vars?: TranslateVars) =>
      translatePlural(dict, baseKey, count, vars),
    [dict],
  );
  const value = useMemo<I18nContextValue>(
    () => ({ locale, dict, t, tPlural }),
    [locale, dict, t, tPlural],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n must be called inside an <I18nProvider>');
  }
  return ctx;
}

export function useT(): I18nContextValue['t'] {
  return useI18n().t;
}

export function useTPlural(): I18nContextValue['tPlural'] {
  return useI18n().tPlural;
}

export function useLocale(): Locale {
  return useI18n().locale;
}
