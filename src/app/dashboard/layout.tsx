// Manager-portal route-group layout. Mirrors the operator layout: it
// resolves the locale once, hands the manager dictionary into a Client
// I18nProvider, and lets every dashboard page (server or client) reach
// for `useT()` with manager-namespace keys.
//
// Per CLAUDE.md hard rule #4 EN/ES/UR ship on day 1 across every
// user-facing surface. The /admin surface is explicitly out of scope
// (admin-only, English-only per ADR-0017) and lives under its own
// route group, so it does not inherit this provider.

import { getLocale } from '@/i18n/get-locale';
import { getManagerDictionary } from '@/i18n/dictionary';
import { I18nProvider } from '@/i18n/provider';
import { BackToDashboardNav } from '@/app/_components/back-to-dashboard';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const dict = getManagerDictionary(locale);
  return (
    <I18nProvider locale={locale} dict={dict}>
      <BackToDashboardNav />
      {children}
    </I18nProvider>
  );
}
