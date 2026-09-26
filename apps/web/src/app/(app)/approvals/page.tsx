import { ClipboardCheck } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';

export const metadata = { title: 'Approvals' };

export default function ApprovalsPage() {
  return (
    <EmptyState
      icon={ClipboardCheck}
      title="Approval inbox"
      module="Module 8 — Approval, Escalation & Action Center"
      description="Actions that policy routes to a human arrive here as decision packets you can read in under ten seconds: what will happen, why it was held, and what can still be undone."
      points={[
        'Approve, edit before release, or reject — each decision signed and receipted',
        'Batched by kind, so one review covers many similar actions',
        'Implausibly fast approvals are flagged: oversight has to be genuine',
      ]}
    />
  );
}
