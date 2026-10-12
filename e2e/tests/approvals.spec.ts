import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * Module 8 through the browser (docs/module8.md §6, §8.1, §12): under the Cautious preset an
 * email leaving the organization needs approval. It arrives in the inbox as a decision packet
 * that says what happens if nobody decides; the approver opens the evidence and approves with the
 * keyboard; the run continues into its hold and the email goes out once released. The Action
 * Center and the oversight view show it.
 */

const GATEWAY = process.env['GATEWAY_PUBLIC_URL'] ?? 'http://localhost:3001';
const SANDBOX = process.env['CONNECTOR_SANDBOX_URL'] ?? 'http://127.0.0.1:3099';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
const suffix = Date.now().toString(36);
const email = `e2e-approvals-${suffix}@example.com`;
const mailbox = `approvals-mailbox-${suffix}@example.com`;
const password = 'E2e-Password-1!';
const peter = `peter-${suffix}@northwind.example.com`;

async function sandbox<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${SANDBOX}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json()) as T;
}
const sentTo = async (addr: string) => (await sandbox<Array<unknown>>('/__sent')).filter((m) => JSON.stringify(m).includes(addr)).length;
const idem = () => ({ 'idempotency-key': crypto.randomUUID() });

test.beforeAll(async () => {
  const res = await fetch(`${GATEWAY}/v1/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, company: `Approvals Co ${suffix}`, displayName: 'Approvals Owner', password }) });
  expect(res.status, await res.clone().text()).toBe(201);
  const { tenantId } = (await res.json()) as { tenantId: string };
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(`UPDATE tenants SET plan = 'enterprise', settings = settings || '{"policyPreset": "cautious"}' WHERE id = $1`, [tenantId]);
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

test('an external email needs approval: packet, evidence, keyboard approve, hold, sent; the Action Center shows it', async ({ page }) => {
  await signIn(page, '/studio');
  const api = page.request;
  const ws = (await (await api.get('/v1/workspaces?limit=10')).json()) as { items: Array<{ id: string }> };
  expect((await api.post('/v1/agents', { data: { workspaceId: ws.items[0]!.id, name: `approvals-agent-${suffix}` }, headers: idem() })).status()).toBe(201);
  await page.reload();
  for (const tool of ['gmail.search', 'gmail.read', 'gmail.draft', 'gmail.send']) await page.getByRole('checkbox', { name: tool }).check();
  await page.getByRole('button', { name: 'Save as new version' }).click();
  await expect(page.getByRole('status').getByText(/Saved as version 1/)).toBeVisible();
  const conn = await api.post('/v1/connectors', { data: { kind: 'gmail', displayName: 'Inbox', enabledTools: ['gmail.search', 'gmail.read', 'gmail.draft', 'gmail.send'] }, headers: idem() });
  const { authorizeUrl } = (await conn.json()) as { authorizeUrl: string };
  const grant = await sandbox<{ code: string; state: string }>('/__authorize', { url: authorizeUrl, account: mailbox, provider: 'google' });
  await page.goto(`/v1/oauth/google/callback?code=${encodeURIComponent(grant.code)}&state=${encodeURIComponent(grant.state)}`);
  await expect(page.getByText(/Connected/)).toBeVisible();
  expect((await api.post('/v1/trusted-contacts', { data: { email: peter, displayName: 'Peter Quill' }, headers: idem() })).status()).toBe(201);

  // ------------------------------------------------------------ the run pauses on an approval
  await page.goto('/chat');
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.getByLabel('Message').fill('Email Peter saying the numbers are final');
  await page.getByRole('button', { name: 'Send' }).click();
  const card = page.getByTestId('run-card').first();
  await expect(card).toHaveAttribute('data-run-status', 'AWAITING_APPROVAL', { timeout: 60_000 });
  expect(await sentTo(peter)).toBe(0);

  // ------------------------------------------------------------ the inbox: packet, evidence, keyboard
  await page.goto('/approvals');
  const packet = page.getByTestId('decision-packet');
  await expect(packet).toContainText('northwind.example.com');
  await expect(page.getByTestId('if-nothing')).toContainText(/If you do nothing by .* → Not done — gmail.send will not run/);
  await page.keyboard.press('v');
  await expect(page.getByTestId('evidence-drawer')).toContainText('the numbers are final');
  await page.keyboard.press('v');
  await page.keyboard.press('a');
  await expect(page.getByTestId('inbox-empty')).toBeVisible({ timeout: 20_000 });

  // ------------------------------------------------------------ the hold, then sent
  await page.goto('/chat');
  await expect(card).toHaveAttribute('data-run-status', 'HELD', { timeout: 60_000 });
  await card.getByTestId('hold-card').getByRole('button', { name: /send now|release/i }).click();
  await expect(card).toHaveAttribute('data-run-status', 'COMPLETED', { timeout: 60_000 });
  expect(await sentTo(peter)).toBe(1);

  // ------------------------------------------------------------ the corpus row, the Action Center, oversight
  const quality = await api.get('/v1/approval-quality');
  expect(quality.status()).toBe(200);
  await page.goto('/action-center');
  await expect(page.getByTestId('brief')).toContainText('Decisions awaiting you');
  await expect(page.getByTestId('chain-status')).toBeVisible();
  await page.goto('/admin/approvals');
  await expect(page.getByTestId('approval-quality')).toBeVisible();
});
