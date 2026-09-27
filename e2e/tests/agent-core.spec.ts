import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * Module 4 through the browser (docs/module4.md §8.1, §8.2, §12): Agent Studio gives an agent a
 * spec (autonomy visibly SHADOW, not settable); Gmail is connected through the OAuth round-trip
 * against the SANDBOX provider (the stack runs with CONNECTOR_SANDBOX_URL); a chat objective is
 * understood, planned, executed durably and streamed back; an ambiguous recipient for an
 * irreversible send stops the run for a clarification; the run inspector shows the timeline and
 * the program. Module 5: the external send is held under the Balanced mode, explained, and
 * released early from the card.
 *
 * Requires: `pnpm sandbox:providers` and the services started with CONNECTOR_SANDBOX_URL and a
 * GOOGLE_CLIENT_ID/SECRET pair (any value: the sandbox is the provider).
 */

const GATEWAY = process.env['GATEWAY_PUBLIC_URL'] ?? 'http://localhost:3001';
const SANDBOX = process.env['CONNECTOR_SANDBOX_URL'] ?? 'http://127.0.0.1:3099';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
const suffix = Date.now().toString(36);
const email = `e2e-agent-${suffix}@example.com`;
const mailbox = `mailbox-${suffix}@example.com`;
const password = 'E2e-Password-1!';

async function sandbox<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${SANDBOX}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json()) as T;
}
const sentTo = async (addr: string) => (await sandbox<Array<{ headers: Record<string, string> }>>('/__sent')).filter((m) => JSON.stringify(m).includes(addr)).length;

test.beforeAll(async () => {
  const res = await fetch(`${GATEWAY}/v1/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, company: `Agent Co ${suffix}`, displayName: 'Agent Owner', password }),
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

async function signIn(page: Page, path: string) {
  await page.goto(path);
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
  await page.waitForURL(new RegExp(`${path}$`));
}

const idem = () => ({ 'idempotency-key': crypto.randomUUID() });

test('studio → connect → chat run → clarification → inspector', async ({ page }) => {
  await signIn(page, '/studio');
  const api = page.request;

  // An agent (a principal of its own), created the Module 1 way.
  const ws = (await (await api.get('/v1/workspaces?limit=10')).json()) as { items: Array<{ id: string }> };
  const created = await api.post('/v1/agents', { data: { workspaceId: ws.items[0]!.id, name: `assistant-${suffix}` }, headers: idem() });
  expect(created.status(), await created.text()).toBe(201);

  // ------------------------------------------------------------ Agent Studio
  await page.reload();
  await expect(page.getByText('Autonomy: SHADOW (read-only)')).toBeVisible();
  for (const tool of ['gmail.search', 'gmail.read', 'gmail.draft', 'gmail.send']) await page.getByRole('checkbox', { name: tool }).check();
  await page.getByRole('button', { name: 'Save as new version' }).click();
  await expect(page.getByRole('status').getByText(/Saved as version 1/)).toBeVisible();

  // ------------------------------------------------------------ Gmail, through the sandbox provider
  const conn = await api.post('/v1/connectors', { data: { kind: 'gmail', displayName: 'Inbox', enabledTools: ['gmail.search', 'gmail.read', 'gmail.draft', 'gmail.send'] }, headers: idem() });
  expect(conn.status(), await conn.text()).toBe(201);
  const { authorizeUrl } = (await conn.json()) as { authorizeUrl: string };
  const grant = await sandbox<{ code: string; state: string }>('/__authorize', { url: authorizeUrl, account: mailbox, provider: 'google' });
  await page.goto(`/v1/oauth/google/callback?code=${encodeURIComponent(grant.code)}&state=${encodeURIComponent(grant.state)}`);
  await expect(page.getByText(/Connected/)).toBeVisible();

  for (const [addr, name] of [
    [`peter-${suffix}@partner.example`, 'Peter Quill'],
    [`sam.lee-${suffix}@partner.example`, 'Sam Lee'],
    [`sam.park-${suffix}@partner.example`, 'Sam Park'],
  ] as const) {
    const r = await api.post('/v1/trusted-contacts', { data: { email: addr, displayName: name }, headers: idem() });
    expect(r.status(), await r.text()).toBe(201);
  }

  // ------------------------------------------------------------ a chat objective, end to end
  await page.goto('/chat');
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.getByLabel('Message').fill('Email Peter saying the E2E numbers are attached');
  await page.getByRole('button', { name: 'Send' }).click();
  const first = page.getByTestId('run-card').first();
  await expect(first.getByText('Peter → Peter Quill')).toBeVisible();
  // Module 5: under the Balanced mode an external send is HELD with a window to pull it back,
  // and the card explains why — every factor with its number, never colour alone.
  await expect(first).toHaveAttribute('data-run-status', 'HELD', { timeout: 30_000 });
  const hold = first.getByTestId('hold-card');
  await expect(hold.getByTestId('hold-remaining')).toBeVisible();
  await expect(hold.getByTestId('risk-explanation')).toContainText('External exposure');
  await expect(hold.getByTestId('risk-explanation')).toContainText('external-send-hold');
  expect(await sentTo(`peter-${suffix}@partner.example`)).toBe(0);
  await hold.getByRole('button', { name: 'Send now' }).click();
  await expect(first).toHaveAttribute('data-run-status', 'COMPLETED', { timeout: 30_000 });
  expect(await sentTo(`peter-${suffix}@partner.example`)).toBe(1);

  // ------------------------------------------------------------ blocking ambiguity (§8.2)
  await page.getByLabel('Message').fill('Email Sam saying the contract is signed');
  await page.getByRole('button', { name: 'Send' }).click();
  const prompt = page.getByTestId('clarification-prompt');
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  expect((await sentTo(`sam.lee-${suffix}`)) + (await sentTo(`sam.park-${suffix}`))).toBe(0);
  await prompt.getByLabel(/Sam Park/).check();
  await prompt.getByRole('button', { name: 'Continue with this person' }).click();
  const second = page.getByTestId('run-card').nth(1);
  await expect(second).toHaveAttribute('data-run-status', 'HELD', { timeout: 30_000 });
  await second.getByTestId('hold-card').getByRole('button', { name: 'Send now' }).click();
  await expect(second).toHaveAttribute('data-run-status', 'COMPLETED', { timeout: 30_000 });
  expect(await sentTo(`sam.park-${suffix}`)).toBe(1);
  expect(await sentTo(`sam.lee-${suffix}`)).toBe(0);

  // ------------------------------------------------------------ run inspector
  await second.getByRole('link', { name: 'Inspect' }).click();
  await page.waitForURL(/\/runs\//);
  const timeline = page.getByTestId('run-timeline');
  await expect(timeline.getByText('Plan v1')).toBeVisible();
  await expect(timeline.getByText('Plan v2')).toBeVisible();
  await expect(timeline.getByText('Waiting for your answer')).toBeVisible();
  await expect(timeline.locator('[data-node-status="done"]').getByText('gmail.send')).toBeVisible();
  await page.getByRole('tab', { name: 'Program' }).click();
  await expect(page.getByTestId('program-viewer')).toContainText('call gmail.send');
  await page.getByRole('tab', { name: /Replans/ }).click();
  await expect(page.getByText('No replans.')).toBeVisible();
  // Module 5: every step was decided and recorded, with its reason chain.
  await page.getByRole('tab', { name: /Policy/ }).click();
  await expect(page.getByTestId('run-evaluations').getByTestId('risk-explanation').first()).toBeVisible();
});
