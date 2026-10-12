import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { readZip, verifyPack, type PublicKeyRecord, type TreeHead } from '@vega/verifier';

/**
 * Module 7 through the browser (docs/module7.md §6, §8, §12):
 *
 *   · a run's actions are in the signed chain; the run trace answers the six C8 questions
 *   · the Audit Explorer finds them by data subject, expands a receipt, verifies the chain
 *   · a recorded decision is replayed and reproduces exactly
 *   · an evidence pack for "everything about this client" is built, downloaded, and verified
 *     OFFLINE by the published verifier against the keys and anchors from /.well-known — with no
 *     account, as an auditor would
 */

const GATEWAY = process.env['GATEWAY_PUBLIC_URL'] ?? 'http://localhost:3001';
const SANDBOX = process.env['CONNECTOR_SANDBOX_URL'] ?? 'http://127.0.0.1:3099';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
const suffix = Date.now().toString(36);
const email = `e2e-evidence-${suffix}@example.com`;
const mailbox = `evidence-mailbox-${suffix}@example.com`;
const password = 'E2e-Password-1!';
const peter = `peter-${suffix}@northwind.example.com`;
let slug = '';

async function sandbox<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${SANDBOX}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json()) as T;
}
const idem = () => ({ 'idempotency-key': crypto.randomUUID() });

test.beforeAll(async () => {
  const res = await fetch(`${GATEWAY}/v1/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, company: `Evidence Co ${suffix}`, displayName: 'Evidence Owner', password }) });
  expect(res.status, await res.clone().text()).toBe(201);
  const { tenantId } = (await res.json()) as { tenantId: string };
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    // Packs and replay are Enterprise surfaces (§14.1); the chain is written on every plan.
    await client.query(`UPDATE tenants SET plan = 'enterprise' WHERE id = $1`, [tenantId]);
    slug = (await client.query<{ slug: string }>(`SELECT slug FROM tenants WHERE id = $1`, [tenantId])).rows[0]!.slug;
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

test('signed receipts → trace, explorer, replay, and a pack an auditor verifies offline', async ({ page }) => {
  await signIn(page, '/studio');
  const api = page.request;

  // ------------------------------------------------------------ an agent with Gmail; Peter a trusted contact
  const ws = (await (await api.get('/v1/workspaces?limit=10')).json()) as { items: Array<{ id: string }> };
  expect((await api.post('/v1/agents', { data: { workspaceId: ws.items[0]!.id, name: `evidence-agent-${suffix}` }, headers: idem() })).status()).toBe(201);
  await page.reload();
  for (const tool of ['gmail.search', 'gmail.read', 'gmail.draft']) await page.getByRole('checkbox', { name: tool }).check();
  await page.getByRole('button', { name: 'Save as new version' }).click();
  await expect(page.getByRole('status').getByText(/Saved as version 1/)).toBeVisible();
  const conn = await api.post('/v1/connectors', { data: { kind: 'gmail', displayName: 'Inbox', enabledTools: ['gmail.search', 'gmail.read', 'gmail.draft'] }, headers: idem() });
  expect(conn.status(), await conn.text()).toBe(201);
  const { authorizeUrl } = (await conn.json()) as { authorizeUrl: string };
  const grant = await sandbox<{ code: string; state: string }>('/__authorize', { url: authorizeUrl, account: mailbox, provider: 'google' });
  await page.goto(`/v1/oauth/google/callback?code=${encodeURIComponent(grant.code)}&state=${encodeURIComponent(grant.state)}`);
  await expect(page.getByText(/Connected/)).toBeVisible();
  expect((await api.post('/v1/trusted-contacts', { data: { email: peter, displayName: 'Peter Quill' }, headers: idem() })).status()).toBe(201);

  // ------------------------------------------------------------ a run: a draft to Peter
  await page.goto('/chat');
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.getByLabel('Message').fill('Draft an email to Peter saying the numbers are final');
  await page.getByRole('button', { name: 'Send' }).click();
  const card = page.getByTestId('run-card').first();
  await expect(card).toHaveAttribute('data-run-status', 'COMPLETED', { timeout: 60_000 });
  const runHref = await card.getByRole('link').first().getAttribute('href');
  const runId = runHref!.split('/').pop()!;

  // ------------------------------------------------------------ C8: the six questions, from the chain
  await page.goto(`/runs/${runId}/trace`);
  await expect(page.getByTestId('trace-integrity')).toContainText('Every entry of this trace checks out');
  await expect(page.getByTestId('c8-what')).toContainText('gmail.draft');
  await expect(page.getByTestId('c8-why')).toContainText('numbers are final');
  await expect(page.getByTestId('c8-tools')).toContainText('gmail.draft');
  await expect(page.getByTestId('c8-policies')).toContainText(/ALLOW/);
  await expect(page.getByTestId('c8-approvals')).toBeVisible();

  // ------------------------------------------------------------ the Audit Explorer: find, expand, verify
  await page.goto('/audit');
  await page.getByLabel('Data subject').fill(peter);
  await page.getByRole('button', { name: 'Search' }).click();
  const table = page.getByTestId('audit-entries');
  await expect(table).toContainText('gmail.draft');
  await table.getByText('Action — before').first().click();
  const receipt = page.getByTestId('receipt');
  await expect(receipt).toContainText('arguments_digest');
  await expect(receipt).toContainText('ML-DSA-65');
  await page.getByRole('button', { name: 'Verify now' }).click();
  await expect(page.getByTestId('chain-status')).toContainText('Chain intact', { timeout: 20_000 });

  // ------------------------------------------------------------ replay: the decision reproduces exactly
  await receipt.getByRole('link', { name: 'Replay this decision' }).click();
  await page.getByTestId('replay-now').click();
  await expect(page.getByTestId('replay-verdict')).toContainText('The decision reproduces exactly.', { timeout: 30_000 });
  await expect(page.getByTestId('layer-interpreter')).toContainText('Matches');
  await expect(page.getByTestId('layer-policy')).toContainText('Matches');

  // ------------------------------------------------------------ a pack: everything about Peter
  await page.goto('/audit/packs');
  await page.getByRole('button', { name: 'Everything about this client' }).click();
  await page.getByLabel(/Data subject/).fill(peter);
  await expect(page.getByTestId('live-count')).toContainText(/[1-9]\d* entries match/);
  await page.getByTestId('build-pack').click();
  const history = page.getByTestId('pack-history');
  await expect(history.getByText('Built').first()).toBeVisible({ timeout: 60_000 });
  const download = page.waitForEvent('download');
  await history.getByRole('link', { name: 'Download' }).first().click();
  const zip = await (await download).createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of zip) chunks.push(c as Buffer);
  const files = readZip(new Uint8Array(Buffer.concat(chunks)));

  // ------------------------------------------------------------ the auditor: no account, offline verification
  const keys = (await (await fetch(`${GATEWAY}/.well-known/vega/keys`)).json()) as { keys: PublicKeyRecord[] };
  const anchors = (await (await fetch(`${GATEWAY}/.well-known/vega/anchors/${slug}`)).json()) as { anchors: TreeHead[] };
  const report = verifyPack(files, { trustedKeys: keys.keys, publishedAnchors: anchors.anchors });
  expect(report.checks.filter((c) => c.status === 'fail')).toEqual([]);
  expect(report.verified).toBe(true);
  expect(report.checks.find((c) => c.id === 'published')?.status).toBe('ok');
  expect([...files.keys()]).toContain('verifier/vega-verify.mjs');
  expect([...files.keys()]).toContain('control-map.md');
});
