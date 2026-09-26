import { MessageSquare } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';

export const metadata = { title: 'Chat' };

export default function ChatPage() {
  return (
    <EmptyState
      icon={MessageSquare}
      title="Conversational surface"
      module="Module 4 — Agent Core"
      description="Give an agent an objective in plain language. It resolves the people and records involved, plans the work, and shows you the plan before anything consequential happens."
      points={[
        'Objectives become a validated task graph — every step annotated with its risk and reversibility',
        'Every factual claim in a draft traces back to its source',
        'Your instruction is the only trusted input; retrieved content never steers the plan',
      ]}
    />
  );
}
