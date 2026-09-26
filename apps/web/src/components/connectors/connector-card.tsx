import Link from 'next/link';
import type { Connector } from '@vega/contracts';
import { Badge } from '@/components/ui/badge';

const STATUS_TONE: Record<Connector['status'], 'success' | 'danger' | 'neutral' | 'info'> = {
  active: 'success',
  pending: 'info',
  degraded: 'danger',
  expired: 'danger',
  revoked: 'neutral',
};

/** Gallery card — docs/module2.md §6.1: status, account, scope, last success, enabled tools. */
export function ConnectorCard({ connector, workspaceName }: { connector: Connector; workspaceName?: string | undefined }) {
  return (
    <Link
      href={`/admin/connectors/${connector.id}`}
      className="grid gap-2 rounded-lg border border-border bg-surface p-3 text-sm hover:border-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="grid">
          <span className="font-medium">{connector.displayName}</span>
          <span className="font-mono text-xs text-muted">{connector.kind}</span>
        </div>
        <Badge tone={STATUS_TONE[connector.status]}>{connector.status}</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
        <dt className="text-muted">Account</dt>
        <dd className="truncate">{connector.accountRef ?? '—'}</dd>
        <dt className="text-muted">Scope</dt>
        <dd>{connector.workspaceId ? (workspaceName ?? 'One workspace') : 'Whole organization'}</dd>
        <dt className="text-muted">Last success</dt>
        <dd>{connector.lastOkAt ? new Date(connector.lastOkAt).toLocaleString() : 'Never'}</dd>
        <dt className="text-muted">Tools enabled</dt>
        <dd>{connector.enabledTools.length}</dd>
      </dl>
    </Link>
  );
}
