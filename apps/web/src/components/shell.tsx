'use client';
import {
  Activity,
  Bot,
  ClipboardCheck,
  LogOut,
  MessageSquare,
  Moon,
  ScrollText,
  Settings,
  Sun,
  SunMoon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BRAND } from '@vega/shared/brand';
import { api } from '@/lib/api';
import { useMe } from '@/lib/me';
import { applyTheme, readTheme, type ThemeChoice } from '@/lib/theme';
import { cn } from '@/lib/utils';

/** The six surfaces of PROJECT.md §6, in the order a design partner meets them. */
export const SURFACES = [
  { href: '/action-center', label: 'Action Center', icon: Activity },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/approvals', label: 'Approvals', icon: ClipboardCheck },
  { href: '/audit', label: 'Audit', icon: ScrollText },
  { href: '/studio', label: 'Agent Studio', icon: Bot },
  { href: '/admin', label: 'Admin', icon: Settings },
] as const;

function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>('system');
  useEffect(() => setChoice(readTheme()), []);
  const next: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' };
  const Icon = choice === 'light' ? Sun : choice === 'dark' ? Moon : SunMoon;
  return (
    <button
      type="button"
      className="rounded-md p-1.5 text-muted hover:bg-surface-muted"
      aria-label={`Theme: ${choice}. Switch to ${next[choice]}`}
      title={`Theme: ${choice}`}
      onClick={() => {
        applyTheme(next[choice]);
        setChoice(next[choice]);
      }}
    >
      <Icon className="size-4" />
    </button>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const path = usePathname();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      const { endSessionUrl } = await api.post<{ endSessionUrl: string | null }>('/v1/auth/logout');
      window.location.href = endSessionUrl ?? '/login';
    } catch {
      window.location.href = '/login';
    }
  }

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <nav aria-label="Primary" className="flex shrink-0 flex-col border-b border-border bg-surface md:w-56 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-4 py-3">
          <Link href="/action-center" className="text-sm font-semibold tracking-tight">
            {BRAND.name}
          </Link>
          <ThemeToggle />
        </div>
        <ul className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible">
          {SURFACES.map(({ href, label, icon: Icon }) => {
            const active = path === href || path.startsWith(`${href}/`);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm',
                    active ? 'bg-surface-muted font-medium text-foreground' : 'text-muted hover:text-foreground',
                  )}
                >
                  <Icon aria-hidden className="size-4" />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="mt-auto hidden border-t border-border px-4 py-3 md:block">
          <p className="truncate text-sm font-medium" title={me.tenant.name}>
            {me.tenant.name}
          </p>
          <p className="truncate text-xs text-muted" title={me.user.email}>
            {me.user.email} · {me.user.role.replace('_', ' ').toLowerCase()}
          </p>
          <button
            type="button"
            onClick={signOut}
            disabled={signingOut}
            className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
          >
            <LogOut aria-hidden className="size-3.5" /> Sign out
          </button>
        </div>
      </nav>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}
