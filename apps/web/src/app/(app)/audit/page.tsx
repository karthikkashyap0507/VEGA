import { ScrollText } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';

export const metadata = { title: 'Audit' };

export default function AuditPage() {
  return (
    <EmptyState
      icon={ScrollText}
      title="Audit explorer"
      module="Module 7 — Evidence Plane"
      description="Every action carries a signed, independently verifiable receipt in a tamper-evident chain kept in a separate plane with separate keys."
      points={[
        'Filter the chain by agent, person, action or time — then verify it yourself',
        'Replay any action deterministically from its recorded inputs',
        'Export a signed evidence pack for your compliance officer',
      ]}
    />
  );
}
