// Operator route-group layout. Resolves the locale once + injects the
// dictionary into a Client Provider that wraps every operator page.
// Pages receive the `t` function via `useT()` (client) or call
// `getDictionary(locale) + translate(...)` directly (server).

import { getLocale } from '@/i18n/get-locale';
import { getDictionary } from '@/i18n/dictionary';
import { I18nProvider } from '@/i18n/provider';
import { FloorLocaleSwitcher } from './_components/floor-locale-switcher';

export default async function OperatorLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const dict = getDictionary(locale);
  // The root <body> ships the logo-keyed DARK identity (bg-dr3-space). The
  // operator iPad field UI MUST stay on its high-contrast GREEN palette
  // (operators work outdoors). This wrapper explicitly re-asserts the green
  // surface so the dark root body never bleeds into the operator subtree.
  //
  // The floor locale switcher (ADR-0061) lives here so it is present on every
  // operator screen — the pre-auth sign-in trio (so a non-English operator can
  // read them and select their language) and the post-auth surfaces (so they
  // can persist/correct it mid-shift).
  return (
    <I18nProvider locale={locale} dict={dict}>
      <div className="min-h-screen bg-dr3-green-deep text-dr3-cream">
        <FloorLocaleSwitcher />
        {children}
      </div>
    </I18nProvider>
  );
}
