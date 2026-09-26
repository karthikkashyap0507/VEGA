import { Activity } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { RISK_TIERS, RiskBadge } from '@/components/ui/risk-badge';

export const metadata = { title: 'Action Center' };

export default function ActionCenterPage() {
  return (
    <EmptyState
      icon={Activity}
      title="Action Center"
      module="Module 8 — Approval, Escalation & Action Center"
      description="Your executive brief: what agents did, what is waiting on you, what is held and can still be pulled back, and how much of your work now completes with no human touch."
      points={[
        'Held actions with a live countdown and one-click revoke',
        'Security center: taint violations, compensation failures, demotions',
        'Usage and cost against your plan’s budget',
        'The autonomy dashboard: which workflows have earned what',
      ]}
    >
      <div className="grid gap-2">
        <p className="text-xs font-medium text-muted">How risk is shown everywhere in the product</p>
        <ul className="flex flex-wrap justify-center gap-2" aria-label="Risk tiers">
          {RISK_TIERS.map((tier) => (
            <li key={tier}>
              <RiskBadge tier={tier} showUsage />
            </li>
          ))}
        </ul>
      </div>
    </EmptyState>
  );
}
