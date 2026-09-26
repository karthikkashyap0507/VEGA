import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * The Step 6 definition of done, through the browser:
 *   sign in → land in tenant → all six surfaces reachable →
 *   invite → workspace → agent create, without touching the database.
 *
 * Setup uses the public signup API (so SIGNUP_ALLOW_PASSWORD must be on locally) and then
 * moves the tenant to a plan with more than one seat. Moving a plan is a DATA change — which
 * is the point of decision D-09 — so doing it with one UPDATE here is the honest shortcut.
 */

const GATEWAY = process.env['GATEWAY_PUBLIC_URL'] ?? 'http://localhost:3001';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
const suffix = Date.now().toString(36);
const email = `e2e-owner-${suffix}@example.com`;
const password = 'E2e-Password-1!';

test.beforeAll(async () => {
  const res = await fetch(`${GATEWAY}/v1/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, company: `E2E Co ${suffix}`, displayName: 'E2E Owner', password }),
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
  await page.goto('/admin');
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
  await page.waitForURL(/\/admin$/);
}

test('sign in, see six surfaces, invite, create workspace and agent', async ({ page }) => {
  await signIn(page);
  await expect(page.getByLabel('Organization name')).toHaveValue(`E2E Co ${suffix}`);

  for (const [name, heading] of [
    ['Action Center', 'Action Center'],
    ['Chat', 'Conversational surface'],
    ['Approvals', 'Approval inbox'],
    ['Audit', 'Audit explorer'],
    ['Agent Studio', 'Agent studio'],
    ['Admin', 'Admin & policy console'],
  ] as const) {
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name }).click();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  }

  // Invite
  await page.getByRole('link', { name: 'Users' }).click();
  await page.getByRole('button', { name: 'Invite' }).click();
  const inviteDialog = page.getByRole('dialog');
  await inviteDialog.getByLabel('Email').fill(`e2e-colleague-${suffix}@example.com`);
  await inviteDialog.getByLabel('Role').selectOption('WORKFLOW_OWNER');
  await inviteDialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText('Invitation created.')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  const invitedRow = page.getByRole('row', { name: new RegExp(`e2e-colleague-${suffix}`) });
  await expect(invitedRow.getByText('invited')).toBeVisible();

  // Workspace
  await page.getByRole('link', { name: 'Workspaces' }).click();
  await page.getByRole('button', { name: 'New workspace' }).click();
  const wsDialog = page.getByRole('dialog');
  await wsDialog.getByLabel('Name').fill('Client Operations');
  await wsDialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(wsDialog).toBeHidden();
  await expect(page.getByText('client-operations')).toBeVisible();

  // Agent
  await page.getByRole('link', { name: 'Agents' }).click();
  await page.getByRole('button', { name: 'New agent' }).click();
  const agentDialog = page.getByRole('dialog');
  await agentDialog.getByLabel('Name').fill('client-comm');
  await agentDialog.getByLabel('Workspace').selectOption({ label: 'Client Operations' });
  await agentDialog.getByRole('button', { name: 'Create agent' }).click();
  await expect(agentDialog).toBeHidden();
  const agentRow = page.getByRole('row', { name: /client-comm/ });
  await expect(agentRow).toBeVisible();
  await expect(agentRow.getByText(/^id \d+/)).toBeVisible();
  await expect(agentRow.getByText('draft')).toBeVisible();
});

test('the retention floor is enforced in the UI', async ({ page }) => {
  await signIn(page);
  await page.getByLabel('Audit retention (days)').fill('90');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('#retentionDays-error')).toContainText('180');
});
