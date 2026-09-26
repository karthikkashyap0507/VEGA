import { Bot } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

export const metadata = { title: 'Agent Studio' };

export default function StudioPage() {
  return (
    <EmptyState
      icon={Bot}
      title="Agent studio"
      module="Module 4 — Agent Core"
      description="Define what an agent is for, which tools it may use, and what it must never do. Agents are created today in Admin; their specs are authored here."
      points={[
        'Each agent is a principal with its own identity, distinct from its owner',
        'Tool access is declared, scoped and least-privilege',
        'Autonomy is earned per action type, starting in shadow mode',
      ]}
    >
      <Button asChild variant="secondary" className="mx-auto">
        <Link href="/admin/agents">Manage agents</Link>
      </Button>
    </EmptyState>
  );
}
