// Operator route-group layout. Resolves the locale once + injects the
// dictionary into a Client Provider that wraps every operator page.
// Pages receive the `t` function via `useT()` (client) or call
// `getDictionary(locale) + translate(...)` directly (server).

import { getLocale } from '@/i18n/get-locale';
import { getDictionary } from '@/i18n/dictionary';
import { I18nProvider } from '@/i18n/provider';
import { FloorShell } from './_components/floor-shell';

export default async function OperatorLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const dict = getDictionary(locale);
  // The root <body> ships the logo-keyed DARK identity (bg-dr3-space). The
  // operator iPad field UI MUST stay on its high-contrast GREEN palette
  // (operators work outdoors) — FloorShell re-asserts that surface so the dark
  // root body never bleeds into the operator subtree, and drops to the ADR-0014
  // black treatment on the pre-PIN auth trio.
  //
  // ADR-0065 — FloorShell also mounts the floor chrome (back / Log Out /
  // language) here, so all 9 operator screens inherit it from ONE place. The
  // locale switcher (ADR-0061) rides inside that chrome, keeping it present on
  // the pre-auth sign-in trio (so a non-English operator can read them before
  // authenticating) and on the post-auth surfaces (so they can correct it
  // mid-shift).
  return (
    <I18nProvider locale={locale} dict={dict}>
      <FloorShell>{children}</FloorShell>
    </I18nProvider>
  );
}
