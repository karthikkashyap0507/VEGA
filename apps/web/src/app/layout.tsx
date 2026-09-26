import type { Metadata } from 'next';
import { BRAND } from '@vega/shared/brand';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: BRAND.name, template: `%s · ${BRAND.name}` },
  description: BRAND.tagline,
};

/**
 * Applies a stored theme choice before first paint, so an explicit dark/light preference does
 * not flash the other theme. Absent a choice, CSS follows prefers-color-scheme.
 */
const themeScript = `try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light'){document.documentElement.dataset.theme=t}}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
