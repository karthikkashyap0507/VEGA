import { Building2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

export type Taint = 'TRUSTED' | 'ORG' | 'UNTRUSTED';

/** Label, icon and colour together — never colour alone (module3.md §8.1). */
export const TAINT: Record<Taint, { label: string; plain: string; Icon: typeof ShieldCheck; cls: string; fill: string }> = {
  TRUSTED: { label: 'Trusted', plain: 'From you, or from a registry your organization controls.', Icon: ShieldCheck, cls: 'bg-taint-trusted-bg text-taint-trusted', fill: 'var(--taint-trusted)' },
  ORG: { label: 'Internal', plain: 'From your organization’s own systems.', Icon: Building2, cls: 'bg-taint-org-bg text-taint-org', fill: 'var(--taint-org)' },
  UNTRUSTED: { label: 'Untrusted', plain: 'From outside your organization: email, the web, an inbound document.', Icon: TriangleAlert, cls: 'bg-taint-untrusted-bg text-taint-untrusted', fill: 'var(--taint-untrusted)' },
};

const SYSTEM_NAMES: Record<string, string> = {
  gmail: 'email',
  outlook: 'email',
  web: 'web page',
  gdrive: 'Drive file',
  sharepoint: 'SharePoint',
  gcal: 'calendar',
  slack: 'Slack',
  registry: 'trusted registry',
  input: 'your instruction',
};

function sourceLabel(id: string): string {
  const system = id.split(':')[0] ?? id;
  return SYSTEM_NAMES[system] ?? system;
}

/**
 * A provenance chip: where a claim came from. Hover (or focus) shows every source and the taint.
 */
export function ProvenanceChip({ taint, sourceIds, label }: { taint: Taint; sourceIds: readonly string[]; label?: string }) {
  const t = TAINT[taint];
  const kinds = [...new Set(sourceIds.map((s) => sourceLabel(s)))];
  const text = label ?? (kinds.length ? `from ${kinds.slice(0, 2).join(' + ')}` : t.label.toLowerCase());
  return (
    <span
      tabIndex={0}
      className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 align-baseline text-xs font-medium outline-offset-2', t.cls)}
      title={`${t.label}: ${t.plain}\n${sourceIds.length ? `Sources:\n${sourceIds.map((s) => `  · ${s}`).join('\n')}` : 'No external source'}`}
      aria-label={`${t.label} — ${text}`}
    >
      <t.Icon aria-hidden className="size-3" />
      {text}
    </span>
  );
}

export function TaintLegend() {
  return (
    <div className="flex flex-wrap gap-2 text-xs text-muted">
      {(Object.keys(TAINT) as Taint[]).map((k) => (
        <span key={k} className="inline-flex items-center gap-1">
          <ProvenanceChip taint={k} sourceIds={[]} label={TAINT[k].label} />
        </span>
      ))}
    </div>
  );
}
