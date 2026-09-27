import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * Module 5 through the browser (docs/module5.md §6, §8.2, §12): a compliance-minded ADMIN writes a
 * policy in the console (YAML, validated live), builds a signed bundle, is refused activation
 * until a simulation is attached, simulates, activates — and a chat run that would contact a
 * competitor is then DENIED by that policy, decided by OPA from the bundle it loaded through
 * signed discovery, with the reason chain in the run inspector. Risk weights are tuned with a
 * live preview.
 *
 * Requires the local stack with OPA (signed discovery from SeaweedFS: `pnpm policy:setup`),
 * Presidio, the sandbox provider, and the services with CONNECTOR_SANDBOX_URL.
 */

const GATEWAY = process.env['GATEWAY_PUBLIC_URL'] ?? 'http://localhost:3001';
const SANDBOX = process.env['CONNECTOR_SANDBOX_URL'] ?? 'http://127.0.0.1:3099';
const OPA = process.env['OPA_URL'] ?? 'http://localhost:8181';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
const suffix = Date.now().toString(36);
const email = `e2e-policy-${suffix}@example.com`;
const mailbox = `policy-mailbox-${suffix}@example.com`;
const password = 'E2e-Password-1!';
let tenantId = '';

async function sandbox<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${SANDBOX}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json()) as T;
}
const sentTo = async (addr: string) => (await sandbox<Array<{ headers: Record<string, string> }>>('/__sent')).filter((m) => JSON.stringify(m).includes(addr)).length;
const idem = () => ({ 'idempotency-key': crypto.randomUUID() });

test.beforeAll(async () => {
  const res = await fetch(`${GATEWAY}/v1/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, company: `Policy Co ${suffix}`, displayName: 'Policy Owner', password }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  tenantId = ((await res.json()) as { tenantId: string }).tenantId;
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    // Policy authoring is exposed from the Teams plan (entitlements, D-09).
    await client.query(`UPDATE tenants SET plan = 'teams' WHERE id = $1`, [tenantId]);
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

const RIVALS = `id: no-contact-with-rivals
description: Never write to a competitor
citation: internal-comp-007
severity: critical
when:
  args.recipient.domains: { contains: rival.example }
then:
  decision: DENY
  reason: Competitors are never contacted from this firm
`;

test('author → build → simulate (required) → activate → a run is denied by the policy, explained', async ({ page }) => {
  await signIn(page, '/admin/policies');
  const api = page.request;

  // ------------------------------------------------------------ the console: author in YAML
  await expect(page.getByRole('radio', { name: /balanced/i })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'New policy' }).click();
  const editor = page.locator('.cm-content');
  await editor.fill('id: bad-policy\ndescription: d\nwhen: { tool.nonsense: 1 }\nthen: { decision: DENY }');
  const validation = page.getByTestId('policy-validation');
  await expect(validation).toContainText('then.reason');
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  await editor.fill(RIVALS);
  await expect(validation).toContainText('Valid — compiles to Rego');
  await page.getByRole('button', { name: 'Save draft' }).click();
  const row = page.getByTestId('policy-no-contact-with-rivals');
  await expect(row).toContainText('draft v1');
  await expect(row).toContainText('internal-comp-007');

  // ------------------------------------------------------------ build → activation refused → simulate → activate
  await page.getByRole('button', { name: 'Build candidate' }).click();
  const bundle = page.getByTestId('bundle-v1');
  await expect(bundle).toContainText('candidate');
  await expect(bundle.getByRole('button', { name: 'Activate' })).toBeDisabled();
  await bundle.getByRole('link', { name: 'Simulate' }).click();
  await page.waitForURL(/\/admin\/policies\/simulate/);
  await page.getByRole('button', { name: 'Run simulation' }).click();
  const report = page.getByTestId('simulation-report');
  await expect(report).toContainText('Candidate bundle v1');
  await expect(report.getByTestId('count-newly_denied')).toHaveText('+0');
  await page.getByRole('button', { name: 'Activate after review' }).click();
  await page.waitForURL(/\/admin\/policies$/);
  await expect(page.getByTestId('bundle-v1')).toContainText('active');
  await expect(page.getByTestId('policy-no-contact-with-rivals')).toContainText('active v1');

  // OPA loads the signed bundle through the signed discovery bundle (polling, seconds).
  const bundleName = `t_${tenantId.replace(/-/g, '')}`;
  await expect
    .poll(async () => ((await (await fetch(`${OPA}/v1/data/system/bundles`)).json()) as { result: Record<string, { manifest?: { revision?: string } }> }).result[bundleName]?.manifest?.revision, { timeout: 45_000 })
    .toBe(`${bundleName}@v1`);

  // ------------------------------------------------------------ an agent, Gmail, a contact at a competitor
  const ws = (await (await api.get('/v1/workspaces?limit=10')).json()) as { items: Array<{ id: string }> };
  const created = await api.post('/v1/agents', { data: { workspaceId: ws.items[0]!.id, name: `policy-agent-${suffix}` }, headers: idem() });
  expect(created.status(), await created.text()).toBe(201);
  await page.goto('/studio');
  for (const tool of ['gmail.search', 'gmail.read', 'gmail.draft', 'gmail.send']) await page.getByRole('checkbox', { name: tool }).check();
  await page.getByRole('button', { name: 'Save as new version' }).click();
  await expect(page.getByRole('status').getByText(/Saved as version 1/)).toBeVisible();
  const conn = await api.post('/v1/connectors', { data: { kind: 'gmail', displayName: 'Inbox', enabledTools: ['gmail.search', 'gmail.read', 'gmail.draft', 'gmail.send'] }, headers: idem() });
  expect(conn.status(), await conn.text()).toBe(201);
  const { authorizeUrl } = (await conn.json()) as { authorizeUrl: string };
  const grant = await sandbox<{ code: string; state: string }>('/__authorize', { url: authorizeUrl, account: mailbox, provider: 'google' });
  await page.goto(`/v1/oauth/google/callback?code=${encodeURIComponent(grant.code)}&state=${encodeURIComponent(grant.state)}`);
  await expect(page.getByText(/Connected/)).toBeVisible();
  const rival = `rita-${suffix}@rival.example`;
  const contact = await api.post('/v1/trusted-contacts', { data: { email: rival, displayName: 'Rita Vale' }, headers: idem() });
  expect(contact.status(), await contact.text()).toBe(201);

  // ------------------------------------------------------------ the run: denied, never sent, explained
  await page.goto('/chat');
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.getByLabel('Message').fill('Email Rita saying our prices go up next month');
  await page.getByRole('button', { name: 'Send' }).click();
  const card = page.getByTestId('run-card').first();
  await expect(card).toHaveAttribute('data-run-status', 'FAILED', { timeout: 60_000 });
  await expect(card).toContainText('policy_denial');
  expect(await sentTo(rival)).toBe(0);
  await card.getByRole('link', { name: 'Inspect' }).click();
  await page.waitForURL(/\/runs\//);
  await page.getByRole('tab', { name: /Policy/ }).click();
  const explained = page.getByTestId('run-evaluations');
  await expect(explained).toContainText('no-contact-with-rivals');
  await expect(explained).toContainText('internal-comp-007');
  await expect(explained).toContainText('Denied');
  await expect(explained).toContainText('tenant bundle v1');
});

test('risk weights: bounded sliders, a live preview of the tier shift, saved as a new version', async ({ page }) => {
  await signIn(page, '/admin/risk');
  await expect(page.getByText(/Risk weights — v1 \(platform default\)/)).toBeVisible();
  await expect(page.getByTestId('weights-preview')).toContainText('Recent actions');
  const slider = page.getByRole('slider', { name: 'External exposure' });
  await slider.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: 'Save as a new version' }).click();
  await expect(page.getByText(/Risk weights — v\d+ \(yours\)/)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'this organization' })).toBeVisible();
});
