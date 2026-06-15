import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { dirFor } from '@/i18n/config';
import { getLocale } from '@/i18n/get-locale';
import { getDictionary } from '@/i18n/dictionary';
import { I18nProvider } from '@/i18n/provider';
import { UpdatePrompt } from './UpdatePrompt';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'DR3-Vision',
  description: 'Mattress recycling load tracking for SVdP / DR3 facilities.',
  applicationName: 'DR3-Vision',
  robots: { index: false, follow: false },
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    title: 'DR3-Vision',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: '/brand/dr3-vision-logo.jpg',
    apple: '/brand/dr3-vision-logo.jpg',
  },
};

export const viewport: Viewport = {
  themeColor: '#00524C',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

// Per CLAUDE.md hard rule #4 the shell ships English / Spanish / Urdu
// (RTL) on day 1. The `dir` attribute on <html> drives Tailwind's
// logical-property utilities (ms-/me-/ps-/pe-/text-start/text-end)
// across the whole tree — including the manager portal, which is
// out-of-scope for T-008's string translation but still benefits from
// the global RTL flip the moment its strings are localized.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  // The PWA update prompt mounts in the root shell so it appears on every
  // surface (operator, manager, bonus). It needs translated strings, but the
  // root layout has no I18nProvider of its own (the route-group layouts each
  // mount their own). Rather than wrap the whole tree — which would collide
  // with the child providers — we resolve the locale here (already done above
  // for <html dir/lang>) and wrap ONLY the prompt in a scoped provider with the
  // operator dictionary (which carries the app-shell `update_prompt.*` keys).
  const dict = getDictionary(locale);
  return (
    <html lang={locale} dir={dirFor(locale)} className={inter.variable}>
      <body className="min-h-screen bg-dr3-space font-sans text-dr3-mist antialiased">
        {children}
        <I18nProvider locale={locale} dict={dict}>
          <UpdatePrompt />
        </I18nProvider>
      </body>
    </html>
  );
}
