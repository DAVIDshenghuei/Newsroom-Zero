import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Newsroom Studio',
  description: 'Self-hosted AI news podcast generator with fact-gated citations and Telegram delivery.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
