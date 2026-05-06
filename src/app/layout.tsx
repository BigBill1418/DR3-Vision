import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-dr3-green-deep font-sans text-dr3-cream antialiased">
        {children}
      </body>
    </html>
  );
}
