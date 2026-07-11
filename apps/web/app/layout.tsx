import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Newsroom Zero',
  description: 'Autonomous multi-agent newsroom — live feeds to Telegram.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
