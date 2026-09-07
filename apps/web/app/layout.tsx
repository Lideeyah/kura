import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { GeistSans } from 'geist/font/sans';
import { JetBrains_Mono } from 'next/font/google';
import './globals.css';

/**
 * Geist ships as a self-hosted `next/font/local` bundle via Vercel's official `geist`
 * package — it is not in this Next version's Google font manifest, and self-hosting
 * avoids a third-party request on first paint either way. JetBrains Mono comes from
 * the Google loader, which does carry it.
 */
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains',
});

export const metadata: Metadata = {
  title: 'KURA // Flight Terminal',
  description:
    'Deterministic invariant arbiter and tamper-evident decision ledger for the RYO-CHAN MCP toolset.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#08090C',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${jetbrainsMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
