// Operator route-group layout. Resolves the locale once + injects the
// dictionary into a Client Provider that wraps every operator page.
// Pages receive the `t` function via `useT()` (client) or call
// `getDictionary(locale) + translate(...)` directly (server).

import { getLocale } from '@/i18n/get-locale';
import { getDictionary } from '@/i18n/dictionary';
import { I18nProvider } from '@/i18n/provider';

export default async function OperatorLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const dict = getDictionary(locale);
  return (
    <I18nProvider locale={locale} dict={dict}>
      {children}
    </I18nProvider>
  );
}
