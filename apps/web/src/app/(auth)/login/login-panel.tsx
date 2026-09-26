'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { SignupInput } from '@vega/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ApiError, api, loginUrl } from '@/lib/api';

type SignupValues = { email: string; company: string; displayName?: string; password?: string };

export function LoginPanel({ returnTo, allowPassword }: { returnTo: string; allowPassword: boolean }) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [serverError, setServerError] = useState<string>();
  const form = useForm<SignupValues>({ resolver: zodResolver(SignupInput) as never });

  async function onSignup(values: SignupValues) {
    setServerError(undefined);
    try {
      const body = { ...values, ...(allowPassword && values.password ? {} : { password: undefined }) };
      await api.post('/v1/signup', body);
      // Provisioned. Sign in as the new owner; the IdP picks up the email as a hint.
      window.location.href = loginUrl('/action-center', values.email);
    } catch (error) {
      if (error instanceof ApiError) {
        for (const e of error.problem.errors ?? []) {
          const field = e.path.split('.').pop() as keyof SignupValues;
          form.setError(field, { message: e.message });
        }
        setServerError(error.problem.detail ?? error.problem.title);
      } else {
        setServerError('Signup failed. Please try again.');
      }
    }
  }

  if (mode === 'signin') {
    return (
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>With your organization’s identity provider.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Button asChild size="lg">
            <a href={loginUrl(returnTo)}>Continue to sign in</a>
          </Button>
          <p className="text-center text-xs text-muted">
            New here?{' '}
            <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={() => setMode('signup')}>
              Create a workspace
            </button>
          </p>
        </CardContent>
      </Card>
    );
  }

  const { errors, isSubmitting } = form.formState;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Create your workspace</CardTitle>
          <CardDescription>Free plan. Undo and injection defense are included on every plan.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={form.handleSubmit(onSignup)} noValidate>
          <Field id="email" label="Work email" error={errors.email?.message}>
            <Input id="email" type="email" autoComplete="email" aria-invalid={Boolean(errors.email)} {...form.register('email')} />
          </Field>
          <Field id="company" label="Organization" error={errors.company?.message}>
            <Input id="company" autoComplete="organization" aria-invalid={Boolean(errors.company)} {...form.register('company')} />
          </Field>
          <Field id="displayName" label="Your name" error={errors.displayName?.message}>
            <Input id="displayName" autoComplete="name" {...form.register('displayName')} />
          </Field>
          {allowPassword ? (
            <Field id="password" label="Password (local development)" hint="Production sends an invite instead." error={errors.password?.message}>
              <Input id="password" type="password" autoComplete="new-password" {...form.register('password')} />
            </Field>
          ) : null}
          {serverError ? (
            <p role="alert" className="text-xs text-danger">
              {serverError}
            </p>
          ) : null}
          <Button type="submit" size="lg" disabled={isSubmitting}>
            {isSubmitting ? 'Provisioning…' : 'Create workspace'}
          </Button>
          <button type="button" className="text-xs text-muted hover:text-foreground" onClick={() => setMode('signin')}>
            I already have an account
          </button>
        </form>
      </CardContent>
    </Card>
  );
}
