import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * Module 2 through the browser (docs/module2.md §6, §13): the connector gallery, the consent
 * transparency screen generated from declarations, the redirect to the provider with PKCE and
 * EXACTLY the consented scopes, credential-less connectors, the tool inspector, health, revoke.
 *
 * The provider consent page itself is intercepted — completing a real Google grant needs the
 * sandbox tenants of §11.1; the code exchange is covered against provider fakes in
 * services/control/test/connectors.test.ts.
 */

const GATEWAY = process.env['GATEWAY_PUBLIC_URL'] ?? 'http://localhost:3001';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
const suffix = Date.now().toString(36);
const email = `e2e-conn-${suffix}@example.com`;
const password = 'E2e-Password-1!';

test.beforeAll(async () => {
  const res = await fetch(`${GATEWAY}/v1/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, company: `Conn Co ${suffix}`, displayName: 'Conn Owner', password }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const { tenantId } = (await res.json()) as { tenantId: string };
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(`UPDATE tenants SET plan = 'business' WHERE id = $1`, [tenantId]);
  } finally {
    await client.end();
  }
});

async function signIn(page: Page) {
  await page.goto('/admin/connectors');
  await page.waitForURL(/\/login/);
  await page.getByRole('link', { name: 'Continue to sign in' }).click();
  const loginName = page.locator('input[name=loginName]');
  await page.waitForLoadState('networkidle');
  if (await loginName.isVisible().catch(() => false)) {
    await loginName.fill(email);
    await page.click('button[type=submit]');
  }
  await page.fill('input[type=password]', password);
  await page.click('button[type=submit]');
  await page.waitForLoadState('networkidle');
  const skip = page.getByRole('button', { name: /skip/i });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.waitForURL(/\/admin\/connectors$/);
}

test('gallery, consent screen, provider redirect, credential-less connectors, inspector, health, revoke', async ({ page }) => {
  await signIn(page);
  await expect(page.getByText('No connectors yet.')).toBeVisible();

  // ---------------------------------------------------------------- consent → provider
  await page.getByRole('button', { name: 'Add connector' }).click();
  const dialog = page.getByRole('dialog');
  const service = dialog.getByLabel('Service');
  await expect(service.locator('option', { hasText: 'Outlook' })).toBeDisabled(); // no Microsoft client here
  await service.selectOption('gmail');
  // Read-only tools are preselected; sending is opted into explicitly.
  await expect(dialog.getByLabel(/Search mail/)).toBeChecked();
  await expect(dialog.getByLabel(/^Send a message/)).not.toBeChecked();
  await dialog.getByLabel(/^Send a message/).check();
  const consent = dialog.getByRole('region', { name: 'Connect Gmail' });
  await expect(consent.getByText('Held before release, with a window in which it can be pulled back.')).toBeVisible();
  await expect(consent.getByText('Act on instructions contained inside content it reads')).toBeVisible();
  await expect(consent.getByText('gmail.send', { exact: true })).toBeVisible();

  let authorizeUrl: URL | undefined;
  await page.route('https://accounts.google.com/**', async (route) => {
    authorizeUrl = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Google consent (intercepted)</h1>' });
  });
  await dialog.getByRole('button', { name: 'Continue to Gmail' }).click();
  await expect(page.getByRole('heading', { name: 'Google consent (intercepted)' })).toBeVisible();
  expect(authorizeUrl?.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorizeUrl?.searchParams.get('client_id')).toBe('e2e-google-client');
  const scopes = (authorizeUrl?.searchParams.get('scope') ?? '').split(' ').sort();
  expect(scopes).toEqual(['email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'openid']);
  expect(authorizeUrl?.toString()).not.toContain('mail.google.com');

  // ---------------------------------------------------------------- credential-less connectors
  await page.goto('/admin/connectors');
  await expect(page.getByRole('link', { name: /Gmail.*pending/s })).toBeVisible();
  await page.getByRole('button', { name: 'Add connector' }).click();
  await dialog.getByLabel('Service').selectOption('http');
  await dialog.getByLabel(/HTTP request/).check();
  await dialog.getByLabel('Allowed origins').fill('https://api.corp.example/v1');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog.getByRole('alert').filter({ hasText: /exact origin/ })).toBeVisible();
  await dialog.getByLabel('Allowed origins').fill('https://api.corp.example');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Add connector' }).click();
  await dialog.getByLabel('Service').selectOption('web');
  await dialog.getByLabel('Display name').fill('Public web');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('link', { name: /Public web.*active/s })).toBeVisible();

  // ---------------------------------------------------------------- inspector, health, test
  await page.getByRole('link', { name: /Public web/ }).click();
  await page.getByRole('link', { name: 'Tools', exact: true }).click();
  const table = page.getByRole('table');
  await expect(table.getByText('web.fetch')).toBeVisible();
  await expect(table.getByText('R0 · Read-only').first()).toBeVisible();
  await expect(table.getByText('Talks to the public internet').first()).toBeVisible();

  await page.getByRole('link', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Test' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Probe succeeded/ })).toBeVisible();
  await page.getByRole('link', { name: 'Health' }).click();
  await expect(page.getByText('Success rate (7d)')).toBeVisible();
  await expect(page.getByRole('table').getByText('created')).toBeVisible();

  // ---------------------------------------------------------------- revoke
  await page.getByRole('link', { name: 'Overview' }).click();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Revoke' }).click();
  await page.waitForURL(/\/admin\/connectors$/);
  await expect(page.getByRole('link', { name: /Public web.*active/s })).toBeHidden();
  await expect(page.getByText(/revoked connector\(s\)/)).toBeVisible();
});
