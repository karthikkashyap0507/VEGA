'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { InviteUser, Role, type User } from '@vega/contracts';
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
import { keys, useAction, useUsers } from '@/lib/queries';

const ROLE_HELP: Record<string, string> = {
  OWNER: 'Everything, including billing and deleting the organization',
  ADMIN: 'Users, connectors, policy, budgets — not billing',
  COMPLIANCE_OFFICER: 'Full audit read and evidence packs; cannot execute',
  WORKFLOW_OWNER: 'Owns agents and requests autonomy promotion',
  APPROVER: 'Decides approval requests routed to them',
  MEMBER: 'Runs agents within granted scopes',
  AUDITOR: 'Read-only across the audit plane; no message bodies',
};

const label = (role: string) => role.replace('_', ' ').toLowerCase();

function InviteDialog() {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<string>();
  const form = useForm<InviteUser>({ resolver: zodResolver(InviteUser) as never, defaultValues: { role: 'MEMBER' } as InviteUser });
  const invite = useAction(
    (v: InviteUser) => api.post<{ user: User; inviteCode?: string }>('/v1/users/invite', v),
    [keys.users],
  );
  const { errors } = form.formState;
  const roles = Role.options.filter((r) => r !== 'OWNER' || me.user.role === 'OWNER');

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          form.reset();
          invite.reset();
          setCode(undefined);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <UserPlus aria-hidden /> Invite
        </Button>
      </DialogTrigger>
      <DialogContent title="Invite a user" description="They receive an identity in your organization and sign in to accept.">
        {code ? (
          <div className="grid gap-2 text-sm">
            <p>Invitation created.</p>
            <p className="text-muted">
              Development invite code: <code className="font-mono text-foreground">{code}</code>
            </p>
          </div>
        ) : (
          <form
            className="grid gap-3"
            noValidate
            onSubmit={form.handleSubmit(async (v) => {
              const r = await invite.mutateAsync(v).catch(() => undefined);
              if (!r) return;
              if (r.inviteCode) setCode(r.inviteCode);
              else setOpen(false);
            })}
          >
            <Field id="invite-email" label="Email" error={errors.email?.message}>
              <Input id="invite-email" type="email" aria-invalid={Boolean(errors.email)} {...form.register('email')} />
            </Field>
            <Field id="invite-name" label="Name (optional)">
              <Input id="invite-name" {...form.register('displayName')} />
            </Field>
            <Field id="invite-role" label="Role" hint={ROLE_HELP[form.watch('role')]}>
              <Select id="invite-role" {...form.register('role')}>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {label(r)}
                  </option>
                ))}
              </Select>
            </Field>
            <ErrorText error={invite.error} />
            <Button type="submit" disabled={invite.isPending}>
              {invite.isPending ? 'Inviting…' : 'Send invitation'}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function UserRow({ user }: { user: User }) {
  const me = useMe();
  const can = useCan();
  const self = user.id === me.user.id;
  const manage = can('users.manage') && !self && (user.role !== 'OWNER' || me.user.role === 'OWNER');
  const update = useAction((body: { role?: string; status?: string }) => api.patch(`/v1/users/${user.id}`, body), [keys.users]);
  const remove = useAction(() => api.delete(`/v1/users/${user.id}`), [keys.users]);
  const roles = Role.options.filter((r) => r !== 'OWNER' || me.user.role === 'OWNER');

  return (
    <tr>
      <Td>
        <div className="grid">
          <span className="font-medium">{user.displayName ?? user.email}</span>
          <span className="text-xs text-muted">{user.email}</span>
        </div>
      </Td>
      <Td>
        {manage && user.status !== 'deactivated' ? (
          <Select
            aria-label={`Role for ${user.email}`}
            value={user.role}
            disabled={update.isPending}
            onChange={(e) => update.mutate({ role: e.target.value })}
          >
            {roles.map((r) => (
              <option key={r} value={r}>
                {label(r)}
              </option>
            ))}
          </Select>
        ) : (
          <span title={ROLE_HELP[user.role]}>{label(user.role)}</span>
        )}
      </Td>
      <Td>
        <Badge tone={user.status === 'active' ? 'success' : user.status === 'invited' ? 'info' : 'neutral'}>{user.status}</Badge>
      </Td>
      <Td className="text-right">
        {manage ? (
          <div className="flex justify-end gap-1">
            {user.status === 'deactivated' ? (
              <Button size="sm" variant="secondary" onClick={() => update.mutate({ status: 'active' })}>
                Reactivate
              </Button>
            ) : user.status === 'active' ? (
              <Button size="sm" variant="secondary" onClick={() => update.mutate({ status: 'deactivated' })}>
                Deactivate
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (window.confirm(`Remove ${user.email}? Their sessions end immediately.`)) remove.mutate(undefined);
              }}
            >
              Remove
            </Button>
          </div>
        ) : self ? (
          <span className="text-xs text-muted">you</span>
        ) : null}
        <ErrorText error={update.error ?? remove.error} />
      </Td>
    </tr>
  );
}

export default function UsersPage() {
  const can = useCan();
  const users = useUsers();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Users</CardTitle>
        {can('users.manage') ? <InviteDialog /> : null}
      </CardHeader>
      <CardContent className="px-0 py-0">
        {users.isPending ? (
          <p className="px-4 py-3 text-sm text-muted">Loading…</p>
        ) : users.error ? (
          <div className="px-4 py-3">
            <ErrorText error={users.error} />
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>User</Th>
                <Th>Role</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {users.data.map((u) => (
                <UserRow key={u.id} user={u} />
              ))}
            </tbody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
