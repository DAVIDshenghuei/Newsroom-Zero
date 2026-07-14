import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Newsroom Studio — Important reading, ready to listen.',
  description: 'Trusted news and your own documents, turned into portable audio.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
