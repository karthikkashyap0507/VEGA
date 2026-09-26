import { BRAND } from '@vega/shared/brand';
import { LoginPanel } from './login-panel';

export const metadata = { title: 'Sign in' };

const ERRORS: Record<string, string> = {
  no_account: 'That identity is not a member of any organization here. Ask an admin to invite you, or create a workspace below.',
  account_deactivated: 'Your account has been deactivated. Contact your organization’s admin.',
  tenant_inactive: 'Your organization is not active.',
  invalid_state: 'The sign-in attempt expired or was started in another tab. Please try again.',
  sign_in_failed: 'Sign-in could not be completed. Please try again.',
  access_denied: 'Sign-in was cancelled.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; returnTo?: string }>;
}) {
  const { error, returnTo } = await searchParams;
  const message = error ? (ERRORS[error] ?? 'Sign-in failed. Please try again.') : undefined;
  const safeReturn = returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/action-center';
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="grid w-full max-w-sm gap-6">
        <header className="grid gap-1 text-center">
          <h1 className="text-xl font-semibold tracking-tight">{BRAND.name}</h1>
          <p className="text-sm text-muted">{BRAND.tagline}</p>
        </header>
        {message ? (
          <p role="alert" className="rounded-md border border-border bg-risk-critical-bg px-3 py-2 text-sm text-risk-critical">
            {message}
          </p>
        ) : null}
        <LoginPanel returnTo={safeReturn} allowPassword={process.env['NEXT_PUBLIC_SIGNUP_PASSWORD'] === 'true'} />
      </div>
    </main>
  );
}
