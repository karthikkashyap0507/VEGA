'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { BotMessageSquare } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { CreateAgent, type Agent } from '@vega/contracts';
import { ErrorText } from '@/components/error-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useCan, useMe } from '@/lib/me';
import { keys, useAction, useAgents, useUsers, useWorkspaces } from '@/lib/queries';

function CreateAgentDialog() {
  const me = useMe();
  const workspaces = useWorkspaces();
  const [open, setOpen] = useState(false);
  const form = useForm<CreateAgent>({
    resolver: zodResolver(CreateAgent) as never,
    defaultValues: { workspaceId: me.workspaceIds[0] ?? '' } as CreateAgent,
  });
  const create = useAction((v: CreateAgent) => api.post<Agent>('/v1/agents', v), [keys.agents]);
  const active = (workspaces.data ?? []).filter((w) => !w.archivedAt);
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { form.reset(); create.reset(); } }}>
      <DialogTrigger asChild>
        <Button size="sm">
          <BotMessageSquare aria-hidden /> New agent
        </Button>
      </DialogTrigger>
      <DialogContent title="New agent" description="Creates the agent's own identity. It stays a draft until it has a spec (Agent Studio, Module 4).">
        <form
          className="grid gap-3"
          noValidate
          onSubmit={form.handleSubmit(async (v) => {
            if (await create.mutateAsync(v).catch(() => undefined)) setOpen(false);
          })}
        >
          <Field id="agent-name" label="Name" error={form.formState.errors.name?.message}>
            <Input id="agent-name" placeholder="client-comm" {...form.register('name')} />
          </Field>
          <Field id="agent-ws" label="Workspace" error={form.formState.errors.workspaceId?.message}>
            <Select id="agent-ws" {...form.register('workspaceId')}>
              {active.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <ErrorText error={create.error} />
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Provisioning identity…' : 'Create agent'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AgentRow({ agent, workspaceName }: { agent: Agent; workspaceName: string }) {
  const users = useUsers();
  const update = useAction((body: { ownerUserId?: string; status?: string }) => api.patch(`/v1/agents/${agent.id}`, body), [keys.agents]);
  const archive = useAction(() => api.delete(`/v1/agents/${agent.id}`), [keys.agents]);
  const owners = (users.data ?? []).filter((u) => u.status === 'active');
  return (
    <tr>
      <Td>
        <div className="grid">
          <span className="font-medium">{agent.name}</span>
          <span className="font-mono text-xs text-muted" title="The agent's own machine identity">
            id {agent.idpMachineId}
          </span>
        </div>
      </Td>
      <Td>{workspaceName}</Td>
      <Td>
        <Select aria-label={`Owner of ${agent.name}`} value={agent.ownerUserId} onChange={(e) => update.mutate({ ownerUserId: e.target.value })}>
          {owners.map((u) => (
            <option key={u.id} value={u.id}>
              {u.displayName ?? u.email}
            </option>
          ))}
        </Select>
      </Td>
      <Td>
        <Badge tone={agent.status === 'active' ? 'success' : agent.status === 'suspended' ? 'danger' : 'neutral'}>{agent.status}</Badge>
      </Td>
      <Td className="text-right">
        <div className="flex justify-end gap-1">
          {agent.status === 'suspended' ? null : (
            <Button size="sm" variant="secondary" onClick={() => update.mutate({ status: 'suspended' })}>
              Suspend
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => window.confirm(`Archive ${agent.name}? Its identity is deactivated.`) && archive.mutate(undefined)}>
            Archive
          </Button>
        </div>
        <ErrorText error={update.error ?? archive.error} />
      </Td>
    </tr>
  );
}

export default function AgentsPage() {
  const can = useCan();
  const agents = useAgents();
  const workspaces = useWorkspaces();
  const names = new Map((workspaces.data ?? []).map((w) => [w.id, w.name]));
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Agents</CardTitle>
          <CardDescription>Each agent is a principal with its own identity, acting on behalf of a person.</CardDescription>
        </div>
        {can('agents.create') ? <CreateAgentDialog /> : null}
      </CardHeader>
      <CardContent className="px-0 py-0">
        {agents.isPending ? (
          <p className="px-4 py-3 text-sm text-muted">Loading…</p>
        ) : (agents.data ?? []).length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted">No agents yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Agent</Th>
                <Th>Workspace</Th>
                <Th>Owner</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {(agents.data ?? []).map((a) => (
                <AgentRow key={a.id} agent={a} workspaceName={names.get(a.workspaceId) ?? '—'} />
              ))}
            </tbody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
