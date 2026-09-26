'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { RETENTION_DAYS_FLOOR } from '@vega/contracts';
import { ErrorText } from '@/components/error-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useCan, useMe } from '@/lib/me';
import { keys, useAction, useTenant } from '@/lib/queries';

/**
 * Tenant settings — module1.md §6.2. The 180-day retention floor (EU AI Act Art. 12) is
 * enforced in this form AND by the API AND by a database CHECK. The form's copy exists so the
 * user learns the rule before the server has to refuse them.
 */
const Settings = z.object({
  name: z.string().min(1, 'Required').max(200),
  retentionDays: z.coerce
    .number()
    .int()
    .min(RETENTION_DAYS_FLOOR, `At least ${RETENTION_DAYS_FLOOR} days — the EU AI Act Art. 12 floor`)
    .max(3650),
});
type SettingsValues = z.infer<typeof Settings>;

export default function OrganizationPage() {
  const me = useMe();
  const can = useCan();
  const tenant = useTenant();
  const form = useForm<SettingsValues>({ resolver: zodResolver(Settings) as never });
  const save = useAction((v: SettingsValues) => api.patch('/v1/tenants/current', v), [keys.tenant, ['me']]);

  useEffect(() => {
    if (tenant.data) form.reset({ name: tenant.data.name, retentionDays: tenant.data.retentionDays });
  }, [tenant.data, form]);

  const editable = can('tenant.update');
  const { errors, isDirty } = form.formState;

  return (
    <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Organization</CardTitle>
            <CardDescription>Name and audit retention.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {tenant.isPending ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : (
            <form className="grid gap-3" onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate>
              <Field id="name" label="Organization name" error={errors.name?.message}>
                <Input id="name" disabled={!editable} aria-invalid={Boolean(errors.name)} {...form.register('name')} />
              </Field>
              <Field
                id="retentionDays"
                label="Audit retention (days)"
                hint={`Minimum ${RETENTION_DAYS_FLOOR} days. Message bodies can still be erased on a data-subject request without breaking the audit chain.`}
                error={errors.retentionDays?.message}
              >
                <Input
                  id="retentionDays"
                  type="number"
                  min={RETENTION_DAYS_FLOOR}
                  max={3650}
                  disabled={!editable}
                  aria-invalid={Boolean(errors.retentionDays)}
                  {...form.register('retentionDays')}
                />
              </Field>
              <ErrorText error={save.error} />
              {editable ? (
                <div className="flex items-center gap-2">
                  <Button type="submit" disabled={!isDirty || save.isPending}>
                    {save.isPending ? 'Saving…' : 'Save changes'}
                  </Button>
                  {save.isSuccess && !isDirty ? <span className="text-xs text-success">Saved</span> : null}
                </div>
              ) : (
                <p className="text-xs text-muted">Only admins can change organization settings.</p>
              )}
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Plan</CardTitle>
            <CardDescription>What this plan exposes. Undo and injection defense are on every plan.</CardDescription>
          </div>
          <Badge tone="info">{me.entitlements.plan}</Badge>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
            <dt className="text-muted">Region</dt>
            <dd>{me.tenant.region}</dd>
            <dt className="text-muted">Seats</dt>
            <dd>{me.entitlements.limits.seats}</dd>
            <dt className="text-muted">Runs / month</dt>
            <dd>{me.entitlements.limits.runsPerMonth.toLocaleString()}</dd>
            <dt className="text-muted">Connectors</dt>
            <dd>{me.entitlements.limits.connectors}</dd>
          </dl>
          <ul className="grid gap-1 border-t border-border pt-2 text-xs">
            {Object.entries(me.entitlements.exposed).map(([feature, on]) => (
              <li key={feature} className="flex justify-between gap-2">
                <span>{feature.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
                <span className={on ? 'text-success' : 'text-muted'}>{on ? 'included' : 'not on this plan'}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
