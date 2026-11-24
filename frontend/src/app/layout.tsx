import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Platform Dashboard',
  description: 'Kubernetes Microservice Platform Dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
