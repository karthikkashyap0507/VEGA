'use client';
import { FlaskConical, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { ProvenanceGraph, type GraphNode } from '@/components/provenance/provenance-graph';
import { SecurityPanel, type CallTraceView } from '@/components/provenance/security-panel';
import { ProvenanceChip, TaintLegend, type Taint } from '@/components/provenance/taint';
import { ErrorText } from '@/components/error-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useAction, useTools } from '@/lib/queries';

/**
 * Plan sandbox — the chat surface's view of a plan before anything happens (module3.md §8).
 * Module 4's planner writes these programs; here a person can write one, validate it, and dry
 * run it through the capability interpreter: reads run, effects are only simulated, every value
 * carries provenance, and every gate decision is explained.
 */

const EXAMPLE = `let inbox = call gmail.search({ query: "meeting" })
let msg = call gmail.read({ messageId: inbox.messages[0].id })
let req = extract msg into MeetingRequest
let who = resolve req.fromEmail in contacts
call gmail.draft({ to: [coalesce(who.email, "me@example.com")], subject: "Re: meeting", body: render("meeting-offer", { times: req.proposedTimes }) }) as draft
emit render("meeting-offer", { times: req.proposedTimes })`;

interface Issue {
  code: string;
  message: string;
  nodeId?: string;
  severity?: string;
}
interface DryRun {
  runId: string;
  status: 'completed' | 'awaiting_approval' | 'violated' | 'invalid' | 'failed';
  emits: Array<{ data: unknown; taint: Taint; dataTaint: Taint; sourceIds: string[]; valueRef: string }>;
  calls: CallTraceView[];
  validationErrors?: Issue[];
  violation?: { kind: string; toolId: string; argPath: string; severity: string; detail: string };
  error?: string;
}
interface Provenance {
  nodes: GraphNode[];
  edges: Array<{ from: string; to: string }>;
}

const STATUS: Record<DryRun['status'], { tone: 'success' | 'danger' | 'neutral' | 'info'; text: string }> = {
  completed: { tone: 'success', text: 'Completed (simulated)' },
  awaiting_approval: { tone: 'info', text: 'Would pause for approval' },
  violated: { tone: 'danger', text: 'Blocked: security violation' },
  invalid: { tone: 'danger', text: 'Rejected before running' },
  failed: { tone: 'danger', text: 'Failed' },
};

function show(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v, null, 1);
}

export function ProgramSandbox() {
  const [source, setSource] = useState(EXAMPLE);
  const [graph, setGraph] = useState<Provenance | undefined>();
  const tools = useTools();
  const recipients = new Map((tools.data ?? []).map((t) => [t.toolId, t.recipientArgs]));
  const validate = useAction((program: string) => api.post<{ valid: boolean; errors: Issue[]; calls: Array<{ nodeId: string; toolId: string; expected: string; argTaint: Taint }> }>('/v1/programs/validate', { program }), []);
  const run = useAction((program: string) => api.post<DryRun>('/v1/programs/dry-run', { program }), []);
  const loadGraph = useAction((runId: string) => api.get<Provenance>(`/v1/runs/${encodeURIComponent(runId)}/provenance`), []);
  const result = run.data;

  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Plan sandbox</CardTitle>
            <CardDescription>Write or paste a plan. Reads run for real; nothing is sent, shared or changed.</CardDescription>
          </div>
          <TaintLegend />
        </CardHeader>
        <CardContent className="grid gap-3">
          <textarea
            aria-label="Program"
            spellCheck={false}
            className="min-h-48 rounded border border-border bg-surface p-2 font-mono text-xs"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => validate.mutate(source)} disabled={validate.isPending}>
              <ShieldCheck aria-hidden /> Validate
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setGraph(undefined);
                run.mutate(source);
              }}
              disabled={run.isPending}
            >
              <FlaskConical aria-hidden /> {run.isPending ? 'Running…' : 'Dry run'}
            </Button>
          </div>
          <ErrorText error={validate.error ?? run.error} />
          {validate.data ? (
            <div role="status" className="grid gap-1 text-sm">
              <p className={validate.data.valid ? 'text-success' : 'text-risk-critical'}>{validate.data.valid ? 'Valid.' : `${validate.data.errors.length} problem(s):`}</p>
              <ul className="grid gap-0.5 pl-4 text-xs">
                {validate.data.errors.map((e, i) => (
                  <li key={i} className="list-disc">
                    <span className="font-mono">{e.code}</span>
                    {e.severity ? ` (${e.severity})` : ''} — {e.message}
                  </li>
                ))}
                {validate.data.calls.map((c) => (
                  <li key={c.nodeId} className="list-disc text-muted">
                    {c.nodeId} <span className="font-mono">{c.toolId}</span>: {c.expected.toLowerCase().replace('_', ' ')} (arguments {c.argTaint.toLowerCase()})
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {result ? (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Result</CardTitle>
              <CardDescription className="font-mono">{result.runId}</CardDescription>
            </div>
            <Badge tone={STATUS[result.status].tone}>{STATUS[result.status].text}</Badge>
          </CardHeader>
          <CardContent className="grid gap-4">
            {result.validationErrors?.length ? (
              <ul className="grid gap-1 text-sm text-risk-critical">
                {result.validationErrors.map((e, i) => (
                  <li key={i}>
                    <span className="font-mono">{e.code}</span> — {e.message}
                  </li>
                ))}
              </ul>
            ) : null}
            {result.violation ? (
              <p role="alert" className="rounded border border-risk-critical bg-risk-critical-bg p-2 text-sm text-risk-critical">
                {result.violation.severity} {result.violation.kind} violation on <span className="font-mono">{result.violation.toolId}</span> ({result.violation.argPath}): {result.violation.detail}. Recorded as a security incident.
              </p>
            ) : null}
            {result.error && !result.violation ? <p className="text-sm text-risk-critical">{result.error}</p> : null}

            {result.emits.map((e) => (
              <figure key={e.valueRef} className="grid gap-1 rounded border border-border p-3">
                <pre className="whitespace-pre-wrap text-sm">{show(e.data)}</pre>
                <figcaption>
                  <ProvenanceChip taint={e.taint} sourceIds={e.sourceIds} />
                </figcaption>
              </figure>
            ))}

            {result.calls.length ? (
              <Table>
                <thead>
                  <tr>
                    <Th>Step</Th>
                    <Th>Tool</Th>
                    <Th>Gate</Th>
                    <Th>Arguments</Th>
                    <Th>Ran?</Th>
                  </tr>
                </thead>
                <tbody>
                  {result.calls.map((c, i) => (
                    <tr key={`${c.nodeId}-${i}`}>
                      <Td className="font-mono text-xs">{c.nodeId}</Td>
                      <Td className="font-mono text-xs">{c.toolId}</Td>
                      <Td>
                        <Badge tone={c.gate === 'PROCEED' ? 'success' : c.gate === 'VIOLATION' ? 'danger' : 'info'}>{c.gate.toLowerCase().replace('_', ' ')}</Badge>
                      </Td>
                      <Td>
                        <ProvenanceChip taint={c.argTaint} sourceIds={[...new Set(c.argTaints.flatMap((a) => a.sourceIds))]} />
                      </Td>
                      <Td className="text-xs">{c.executed ? 'read ran' : 'simulated'}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : null}

            {result.calls
              .filter((c) => c.argTaint !== 'TRUSTED' && c.gate !== 'PROCEED')
              .map((c, i) => (
                <SecurityPanel key={`p-${c.nodeId}-${i}`} call={c} recipientArgs={recipients.get(c.toolId) ?? []} />
              ))}

            <div>
              <Button size="sm" variant="secondary" onClick={async () => setGraph(await loadGraph.mutateAsync(result.runId).catch(() => undefined))}>
                View provenance graph
              </Button>
              <ErrorText error={loadGraph.error} />
            </div>
            {graph ? <ProvenanceGraph nodes={graph.nodes} edges={graph.edges} /> : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
