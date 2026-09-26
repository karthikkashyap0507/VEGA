'use client';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useConnector } from '@/lib/queries';

export default function ConnectorLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const path = usePathname();
  const c = useConnector(id);
  const tabs = [
    { href: `/admin/connectors/${id}`, label: 'Overview' },
    { href: `/admin/connectors/${id}/tools`, label: 'Tools' },
    { href: `/admin/connectors/${id}/health`, label: 'Health' },
  ];
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2 text-sm">
        <Link href="/admin/connectors" className="text-muted hover:text-foreground">
          Connectors
        </Link>
        <span className="text-muted">/</span>
        <span className="font-medium">{c.data?.displayName ?? '…'}</span>
        {c.data ? <Badge tone={c.data.status === 'active' ? 'success' : c.data.status === 'revoked' ? 'neutral' : 'danger'}>{c.data.status}</Badge> : null}
      </div>
      <nav aria-label="Connector sections" className="flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            aria-current={path === t.href ? 'page' : undefined}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm', path === t.href ? 'border-primary' : 'border-transparent text-muted hover:text-foreground')}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
