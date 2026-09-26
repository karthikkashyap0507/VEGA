import { AlertOctagon, AlertTriangle, CircleCheck, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Risk tier indicator — module1.md §6.3. Colour, label AND icon, always together: tier is
 * never encoded by colour alone (accessibility, and these screens are printed into
 * compliance evidence, often in greyscale).
 */
export type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

const TIERS: Record<RiskTier, { label: string; usage: string; Icon: typeof CircleCheck; cls: string }> = {
  LOW: { label: 'Low', usage: 'Auto-executed', Icon: CircleCheck, cls: 'bg-risk-low-bg text-risk-low' },
  MEDIUM: { label: 'Medium', usage: 'Held for review', Icon: AlertTriangle, cls: 'bg-risk-medium-bg text-risk-medium' },
  HIGH: { label: 'High', usage: 'Requires approval', Icon: ShieldAlert, cls: 'bg-risk-high-bg text-risk-high' },
  CRITICAL: { label: 'Critical', usage: 'Blocked / dual authorization', Icon: AlertOctagon, cls: 'bg-risk-critical-bg text-risk-critical' },
};

export function RiskBadge({ tier, showUsage = false }: { tier: RiskTier; showUsage?: boolean }) {
  const t = TIERS[tier];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold', t.cls)}>
      <t.Icon aria-hidden className="size-3.5" />
      <span>{t.label} risk</span>
      {showUsage ? <span className="font-normal">· {t.usage}</span> : null}
    </span>
  );
}

export const RISK_TIERS = Object.keys(TIERS) as RiskTier[];
