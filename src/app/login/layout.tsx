// Login route layout — same i18n provider wiring as /operator so the
// locale picker + form copy share the dictionary already on the page.

import { getLocale } from '@/i18n/get-locale';
import { getDictionary } from '@/i18n/dictionary';
import { I18nProvider } from '@/i18n/provider';

export default async function LoginLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const dict = getDictionary(locale);
  return (
    <I18nProvider locale={locale} dict={dict}>
      {children}
    </I18nProvider>
  );
}
