'use client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { ErrorText } from '@/components/error-text';
import { ProvenanceGraph, type GraphNode } from '@/components/provenance/provenance-graph';
import { ProvenanceChip } from '@/components/provenance/taint';
import { ActionCard } from '@/components/runs/action-card';
import { ProgramViewer } from '@/components/runs/program-viewer';
import { RunTimeline } from '@/components/runs/run-timeline';
import { StreamingStatus } from '@/components/runs/status';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { TERMINAL, useRun, useRunStream, type PendingAction } from '@/lib/runs';

/**
 * RUN INSPECTOR — docs/module4.md §6.2: the timeline of nodes (status, duration, effect), the
 * program with its executed path, diffs across replans, the provenance graph (M3), cost and
 * model, and the replan chain with its causes.
 */
export default function RunInspectorPage() {
  const { id } = useParams<{ id: string }>();
  const q = useRun(id);
  const run = q.data?.run;
  const stream = useRunStream(id, Boolean(run && !TERMINAL.has(run.status)));
  const graph = useQuery({ queryKey: ['runs', id, 'provenance'], queryFn: () => api.get<{ nodes: GraphNode[]; edges: Array<{ from: string; to: string }> }>(`/v1/runs/${id}/provenance`), enabled: Boolean(run) });
  if (q.error) return <ErrorText error={q.error} />;
  if (!q.data || !run) return <p className="text-sm text-muted">Loading run…</p>;
  const d = q.data;
  const pending = run.pending as PendingAction | null;
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4">
      <header className="grid gap-1">
        <h1 className="text-lg font-semibold">Run</h1>
        <p className="text-sm">{run.objective.objective}</p>
        <StreamingStatus connected={stream.connected} events={stream.events} status={run.status} />
        {run.statusReason ? <p className="text-sm text-muted">{run.statusReason}</p> : null}
      </header>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Understood</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-xs">
            {run.objective.entities.length ? run.objective.entities.map((e) => <ProvenanceChip key={e.binding} taint="TRUSTED" sourceIds={[`registry:${e.resolvedId}`]} label={`${e.raw} → ${e.name ?? e.email}`} />) : <span className="text-muted">No people or organisations named.</span>}
            {run.objective.ambiguities.map((a) => (
              <span key={a.binding}>
                “{a.raw}”: {a.resolution ? 'resolved by you' : a.blocking ? 'blocked until answered' : 'best guess used'} ({a.candidates.length} candidates)
              </span>
            ))}
            <span className="text-muted">Origin: {run.objective.origin.kind === 'principal' ? 'you' : `trigger rule (${run.trigger})`}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Plan</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-xs">
            <span>Version {run.programVersion} · {run.replanCount} replan(s)</span>
            <span>{d.programs.at(-1)?.modelId ?? '—'}</span>
            <span>Agent v{run.agentVersion} · trigger {run.trigger}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Cost</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-xs">
            <span>{(run.costCents / 100).toFixed(2)} USD (planning + extraction)</span>
            <span>Started {new Date(run.startedAt).toLocaleString()}</span>
            {run.endedAt ? <span>Ended {new Date(run.endedAt).toLocaleString()}</span> : null}
          </CardContent>
        </Card>
      </div>
      {pending?.kind === 'approval' ? <ActionCard action={pending} /> : null}
      <Tabs defaultValue="timeline" className="grid gap-3">
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="program">Program</TabsTrigger>
          <TabsTrigger value="provenance">Provenance</TabsTrigger>
          <TabsTrigger value="replans">Replans ({d.replans.length})</TabsTrigger>
          <TabsTrigger value="actions">Actions ({d.actions.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline">
          <RunTimeline nodes={d.nodes} highlightVersion={run.programVersion} />
        </TabsContent>
        <TabsContent value="program">
          <ProgramViewer programs={d.programs} nodes={d.nodes} />
        </TabsContent>
        <TabsContent value="provenance">
          {graph.data?.nodes.length ? <ProvenanceGraph nodes={graph.data.nodes} edges={graph.data.edges} /> : <p className="text-sm text-muted">No provenance recorded yet.</p>}
        </TabsContent>
        <TabsContent value="replans">
          {d.replans.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>From</Th>
                  <Th>Cause</Th>
                  <Th>Detail</Th>
                  <Th>When</Th>
                </tr>
              </thead>
              <tbody>
                {d.replans.map((r) => (
                  <tr key={r.id}>
                    <Td>v{r.fromVersion}, step {r.fromStep}</Td>
                    <Td>{r.reason.replace(/_/g, ' ')}</Td>
                    <Td className="max-w-md truncate font-mono text-xs">{JSON.stringify(r.detail)}</Td>
                    <Td>{new Date(r.createdAt).toLocaleTimeString()}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="text-sm text-muted">No replans.</p>
          )}
        </TabsContent>
        <TabsContent value="actions">
          <Card>
            <CardHeader>
              <CardDescription>The consequential subset: every executed call that is not a read.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <thead>
                  <tr>
                    <Th>Tool</Th>
                    <Th>State</Th>
                    <Th>Reversibility</Th>
                    <Th>Argument taint</Th>
                    <Th>Committed</Th>
                  </tr>
                </thead>
                <tbody>
                  {d.actions.map((a) => (
                    <tr key={a.id}>
                      <Td className="font-mono">{a.toolId}</Td>
                      <Td>{a.state}</Td>
                      <Td>{a.reversibility}</Td>
                      <Td>
                        <ProvenanceChip taint={a.taint} sourceIds={[]} />
                      </Td>
                      <Td>{a.committedAt ? new Date(a.committedAt).toLocaleTimeString() : '—'}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
