'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { FolderPlus, Users } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { CreateWorkspace, type Workspace } from '@vega/contracts';
import { ErrorText } from '@/components/error-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useCan, useMe } from '@/lib/me';
import { keys, useAction, useMembers, useUsers, useWorkspaces } from '@/lib/queries';

function CreateDialog() {
  const [open, setOpen] = useState(false);
  const form = useForm<CreateWorkspace>({ resolver: zodResolver(CreateWorkspace) as never });
  const create = useAction((v: CreateWorkspace) => api.post<Workspace>('/v1/workspaces', v), [keys.workspaces, ['me']]);
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { form.reset(); create.reset(); } }}>
      <DialogTrigger asChild>
        <Button size="sm">
          <FolderPlus aria-hidden /> New workspace
        </Button>
      </DialogTrigger>
      <DialogContent title="New workspace" description="You become its owner.">
        <form
          className="grid gap-3"
          noValidate
          onSubmit={form.handleSubmit(async (v) => {
            if (await create.mutateAsync(v).catch(() => undefined)) setOpen(false);
          })}
        >
          <Field id="ws-name" label="Name" error={form.formState.errors.name?.message}>
            <Input id="ws-name" {...form.register('name')} />
          </Field>
          <ErrorText error={create.error} />
          <Button type="submit" disabled={create.isPending}>
            Create
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MembersDialog({ workspace }: { workspace: Workspace }) {
  const me = useMe();
  const members = useMembers(workspace.id);
  const users = useUsers();
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<'member' | 'admin' | 'owner'>('member');
  const add = useAction(() => api.post(`/v1/workspaces/${workspace.id}/members`, { userId, role }), [keys.members(workspace.id), ['me']]);
  const remove = useAction((uid: string) => api.delete(`/v1/workspaces/${workspace.id}/members/${uid}`), [keys.members(workspace.id), ['me']]);
  const memberIds = new Set((members.data ?? []).map((m) => m.userId));
  const candidates = (users.data ?? []).filter((u) => u.status !== 'deactivated' && !memberIds.has(u.id));
  const sharing = me.entitlements.exposed.sharedWorkspaces;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary">
          <Users aria-hidden /> Members
        </Button>
      </DialogTrigger>
      <DialogContent title={`Members of ${workspace.name}`} className="max-w-lg">
        <ul className="grid gap-1 text-sm">
          {(members.data ?? []).map((m) => (
            <li key={m.userId} className="flex items-center justify-between gap-2 rounded px-1 py-1 hover:bg-surface-muted">
              <span className="truncate">{m.displayName ?? m.email}</span>
              <span className="flex items-center gap-2">
                <Badge>{m.role}</Badge>
                <Button size="sm" variant="ghost" onClick={() => remove.mutate(m.userId)} aria-label={`Remove ${m.email}`}>
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
        {sharing ? (
          <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
            <Field id="add-user" label="Add person">
              <Select id="add-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Choose…</option>
                {candidates.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName ?? u.email}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="add-role" label="Role">
              <Select id="add-role" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                <option value="member">member</option>
                <option value="admin">admin</option>
                <option value="owner">owner</option>
              </Select>
            </Field>
            <Button size="sm" disabled={!userId || add.isPending} onClick={() => add.mutate(undefined)}>
              Add
            </Button>
          </div>
        ) : (
          <p className="border-t border-border pt-3 text-xs text-muted">Sharing workspaces with colleagues is not on the {me.entitlements.plan} plan.</p>
        )}
        <ErrorText error={add.error ?? remove.error} />
      </DialogContent>
    </Dialog>
  );
}

function WorkspaceRow({ workspace }: { workspace: Workspace }) {
  const [name, setName] = useState(workspace.name);
  const update = useAction((body: { name?: string; archived?: boolean }) => api.patch(`/v1/workspaces/${workspace.id}`, body), [keys.workspaces]);
  const archived = Boolean(workspace.archivedAt);
  return (
    <tr>
      <Td>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name !== workspace.name) update.mutate({ name });
          }}
        >
          <Input aria-label="Workspace name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== workspace.name && update.mutate({ name })} disabled={archived} />
        </form>
      </Td>
      <Td className="font-mono text-xs text-muted">{workspace.slug}</Td>
      <Td>{archived ? <Badge>archived</Badge> : <Badge tone="success">active</Badge>}</Td>
      <Td className="text-right">
        <div className="flex justify-end gap-1">
          {!archived ? <MembersDialog workspace={workspace} /> : null}
          <Button size="sm" variant="ghost" onClick={() => update.mutate({ archived: !archived })}>
            {archived ? 'Restore' : 'Archive'}
          </Button>
        </div>
        <ErrorText error={update.error} />
      </Td>
    </tr>
  );
}

export default function WorkspacesPage() {
  const can = useCan();
  const workspaces = useWorkspaces();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspaces</CardTitle>
        {can('workspaces.create') ? <CreateDialog /> : null}
      </CardHeader>
      <CardContent className="px-0 py-0">
        {workspaces.isPending ? (
          <p className="px-4 py-3 text-sm text-muted">Loading…</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Slug</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {(workspaces.data ?? []).map((w) => (
                <WorkspaceRow key={w.id} workspace={w} />
              ))}
            </tbody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
