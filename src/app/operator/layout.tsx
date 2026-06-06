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
  // The root <body> ships the logo-keyed DARK identity (bg-dr3-space). The
  // operator iPad field UI MUST stay on its high-contrast GREEN palette
  // (operators work outdoors). This wrapper explicitly re-asserts the green
  // surface so the dark root body never bleeds into the operator subtree.
  return (
    <I18nProvider locale={locale} dict={dict}>
      <div className="min-h-screen bg-dr3-green-deep text-dr3-cream">{children}</div>
    </I18nProvider>
  );
}
