'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const SECTIONS = [
  { href: '/admin', label: 'Organization' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/workspaces', label: 'Workspaces' },
  { href: '/admin/agents', label: 'Agents' },
  { href: '/admin/connectors', label: 'Connectors' },
  { href: '/admin/sessions', label: 'Sessions' },
  { href: '/admin/security', label: 'Security' },
  { href: '/admin/policies', label: 'Policies' },
  { href: '/admin/risk', label: 'Risk' },
  { href: '/admin/undo', label: 'Undo' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <header className="grid gap-1">
        <h1 className="text-lg font-semibold">Admin & policy console</h1>
        <p className="text-sm text-muted">People, workspaces, agents, connectors, sessions — and the policies and risk weights that decide every action.</p>
      </header>
      <nav aria-label="Admin sections" className="flex gap-1 overflow-x-auto border-b border-border">
        {SECTIONS.map((s) => {
          const active = s.href === '/admin' ? path === '/admin' : path.startsWith(s.href);
          return (
            <Link
              key={s.href}
              href={s.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm',
                active ? 'border-primary text-foreground' : 'border-transparent text-muted hover:text-foreground',
              )}
            >
              {s.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
