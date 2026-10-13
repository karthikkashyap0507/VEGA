'use client';
import { useSearchParams } from 'next/navigation';
import { useRouter } from 'next/navigation';
import { Suspense } from 'react';
import { ContentionViews } from '@/components/autonomy/contention';
import { LadderDashboard } from '@/components/autonomy/ladder';
import { ProposalInbox } from '@/components/autonomy/proposals';
import { UsageViews } from '@/components/autonomy/usage';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TIER_TEXT, type Tier } from '@/lib/autonomy';

/**
 * AUTONOMY — docs/module10.md §15. Where an agent earns trust, action by action, on evidence.
 * The ladder, the proposals mined from what approvers actually did, who-is-on-what contention,
 * and usage and cost controls.
 */

const TABS = [
  { key: 'ladder', label: 'Ladder' },
  { key: 'proposals', label: 'Suggestions' },
  { key: 'contention', label: 'Contention' },
  { key: 'usage', label: 'Usage & budget' },
] as const;

function Body() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = TABS.find((t) => t.key === params.get('tab'))?.key ?? 'ladder';
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4">
      <header className="grid gap-1">
        <h1 className="text-lg font-semibold">Autonomy</h1>
        <p className="text-sm text-muted">
          Every action starts with a person in the loop. It earns more only from evidence — the decisions people actually made — and only a named person can grant it. It is taken back automatically the moment something goes wrong.
        </p>
      </header>
      <details className="rounded-lg border border-border bg-surface px-4 py-2 text-sm">
        <summary className="cursor-pointer text-xs font-medium text-muted">What the tiers mean</summary>
        <dl className="mt-2 grid gap-1 sm:grid-cols-[auto_1fr] sm:gap-x-4">
          {(Object.keys(TIER_TEXT) as Tier[]).map((t) => (
            <div key={t} className="contents">
              <dt className="font-medium">{TIER_TEXT[t].label}</dt>
              <dd className="text-muted">{TIER_TEXT[t].meaning}</dd>
            </div>
          ))}
        </dl>
      </details>
      <Tabs value={tab} onValueChange={(v) => router.replace(`/autonomy?tab=${v}`)}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="ladder" className="pt-4">
          <LadderDashboard />
        </TabsContent>
        <TabsContent value="proposals" className="pt-4">
          <ProposalInbox />
        </TabsContent>
        <TabsContent value="contention" className="pt-4">
          <ContentionViews />
        </TabsContent>
        <TabsContent value="usage" className="pt-4">
          <UsageViews />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function AutonomyPage() {
  return (
    <Suspense fallback={null}>
      <Body />
    </Suspense>
  );
}
