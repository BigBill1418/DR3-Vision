import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { dirFor } from '@/i18n/config';
import { getLocale } from '@/i18n/get-locale';

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
  return (
    <html lang={locale} dir={dirFor(locale)} className={inter.variable}>
      <body className="min-h-screen bg-dr3-space font-sans text-dr3-mist antialiased">
        {children}
      </body>
    </html>
  );
}
