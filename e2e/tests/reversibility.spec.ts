import { createServer, type Server } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * Module 6 through the browser (docs/module6.md §6, §8.1, §12):
 *
 *   · an external email is HELD: the run card shows the blast radius; "View full message" shows
 *     exactly what will be sent; Edit changes the content and the hold starts again
 *   · the principal's phone gets a push with a Revoke button; tapping it (no session) stops the
 *     email in well under 5 seconds — it never reaches the provider
 *   · a draft is created, then undone from the run card; the provider no longer has it
 *   · the Undo admin page shows Time-to-Undo for both
 *
 * The "phone" is ntfy's publish API, played here by a local receiver on NTFY_URL (the execution
 * service publishes there); tapping Revoke is exactly the HTTP call ntfy's app makes.
 */

const GATEWAY = process.env['GATEWAY_PUBLIC_URL'] ?? 'http://localhost:3001';
const SANDBOX = process.env['CONNECTOR_SANDBOX_URL'] ?? 'http://127.0.0.1:3099';
const NTFY_PORT = Number(new URL(process.env['NTFY_URL'] ?? 'http://localhost:8090').port || 8090);
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
const suffix = Date.now().toString(36);
const email = `e2e-undo-${suffix}@example.com`;
const mailbox = `undo-mailbox-${suffix}@example.com`;
const password = 'E2e-Password-1!';
const peter = `peter-${suffix}@northwind.example.com`;

type Push = { topic: string; title: string; message: string; actions: Array<{ action: string; label: string; url: string; method: string; headers: Record<string, string>; body: string }> };
const pushes: Push[] = [];
let ntfy: Server;

async function sandbox<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${SANDBOX}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json()) as T;
}
const sentTo = async (addr: string) => (await sandbox<Array<unknown>>('/__sent')).filter((m) => JSON.stringify(m).includes(addr)).length;
const idem = () => ({ 'idempotency-key': crypto.randomUUID() });

test.beforeAll(async () => {
  ntfy = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        pushes.push(JSON.parse(body) as Push);
      } catch {
        /* a page (text): not ours */
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((r) => ntfy.listen(NTFY_PORT, '127.0.0.1', r));
  const res = await fetch(`${GATEWAY}/v1/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, company: `Undo Co ${suffix}`, displayName: 'Undo Owner', password }) });
  expect(res.status, await res.clone().text()).toBe(201);
  const { tenantId } = (await res.json()) as { tenantId: string };
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(`UPDATE tenants SET plan = 'teams' WHERE id = $1`, [tenantId]);
  } finally {
    await client.end();
  }
});
test.afterAll(async () => {
  await new Promise((r) => ntfy?.close(r));
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

test('held email: blast radius, view, edit, then revoked from the phone in one tap; a draft undone; Time-to-Undo', async ({ page }) => {
  await signIn(page, '/studio');
  const api = page.request;

  // ------------------------------------------------------------ an agent with Gmail, Peter a trusted contact
  const ws = (await (await api.get('/v1/workspaces?limit=10')).json()) as { items: Array<{ id: string }> };
  expect((await api.post('/v1/agents', { data: { workspaceId: ws.items[0]!.id, name: `undo-agent-${suffix}` }, headers: idem() })).status()).toBe(201);
  await page.reload();
  for (const tool of ['gmail.search', 'gmail.read', 'gmail.draft', 'gmail.send']) await page.getByRole('checkbox', { name: tool }).check();
  await page.getByRole('button', { name: 'Save as new version' }).click();
  await expect(page.getByRole('status').getByText(/Saved as version 1/)).toBeVisible();
  const conn = await api.post('/v1/connectors', { data: { kind: 'gmail', displayName: 'Inbox', enabledTools: ['gmail.search', 'gmail.read', 'gmail.draft', 'gmail.send'] }, headers: idem() });
  expect(conn.status(), await conn.text()).toBe(201);
  const { authorizeUrl } = (await conn.json()) as { authorizeUrl: string };
  const grant = await sandbox<{ code: string; state: string }>('/__authorize', { url: authorizeUrl, account: mailbox, provider: 'google' });
  await page.goto(`/v1/oauth/google/callback?code=${encodeURIComponent(grant.code)}&state=${encodeURIComponent(grant.state)}`);
  await expect(page.getByText(/Connected/)).toBeVisible();
  expect((await api.post('/v1/trusted-contacts', { data: { email: peter, displayName: 'Peter Quill' }, headers: idem() })).status()).toBe(201);
  const { topic } = (await (await api.get('/v1/me/push-topic')).json()) as { topic: string };
  expect(topic).toMatch(/^hold-/);

  // ------------------------------------------------------------ held: blast radius, the full message, an edit
  await page.goto('/chat');
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.getByLabel('Message').fill('Email Peter saying the numbers are final');
  await page.getByRole('button', { name: 'Send' }).click();
  const card = page.getByTestId('run-card').first();
  await expect(card).toHaveAttribute('data-run-status', 'HELD', { timeout: 60_000 });
  const blast = card.getByTestId('blast-radius');
  await expect(blast).toContainText('send 1 email');
  await expect(blast).toContainText('northwind.example.com');
  await expect(blast.getByTestId('blast-fidelity')).toContainText('Simulation fidelity: DERIVED for 1 of 1 action');
  const hold = card.getByTestId('hold-card');
  await hold.getByRole('button', { name: 'View full message' }).click();
  await expect(hold.getByTestId('held-content')).toContainText('the numbers are final');
  await hold.getByRole('button', { name: 'Edit' }).click();
  await hold.getByLabel('Edit body').fill('The numbers are final. Please review by Friday.');
  await hold.getByRole('button', { name: 'Save and hold again' }).click();
  await expect(hold).toContainText('(edited — decided again)', { timeout: 30_000 });

  // ------------------------------------------------------------ the phone: one tap, no session
  const push = await expect.poll(() => pushes.filter((p) => p.topic === topic).at(-1), { timeout: 20_000 }).toBeTruthy().then(() => pushes.filter((p) => p.topic === topic).at(-1)!);
  expect(push.message).toContain('Tap Revoke');
  const revoke = push.actions.find((a) => a.label === 'Revoke')!;
  const tapped = Date.now();
  const res = await fetch(revoke.url, { method: revoke.method, headers: revoke.headers, body: revoke.body });
  expect(res.status, await res.clone().text()).toBe(200);
  expect(await res.json()).toMatchObject({ revoked: true });
  await expect(card).toHaveAttribute('data-run-status', 'CANCELLED', { timeout: 5_000 });
  expect(Date.now() - tapped).toBeLessThan(5_000);
  expect(await sentTo(peter)).toBe(0);

  // ------------------------------------------------------------ a draft, undone from the card
  await page.getByLabel('Message').fill('Draft an email to Peter saying the draft terms are attached');
  await page.getByRole('button', { name: 'Send' }).click();
  const draftCard = page.getByTestId('run-card').nth(1);
  await expect(draftCard).toHaveAttribute('data-run-status', 'COMPLETED', { timeout: 60_000 });
  expect((await sandbox<Array<{ subject: string }>>('/__drafts', { account: mailbox })).length).toBe(1);
  const item = draftCard.getByTestId('undo-item');
  await expect(item).toHaveAttribute('data-state', 'armed');
  await expect(item).toContainText('It was never sent, so nobody else is affected');
  await expect(item).toContainText(/available for another 29 days/);
  await item.getByRole('button', { name: 'Undo' }).click();
  await expect(item).toHaveAttribute('data-state', 'succeeded', { timeout: 20_000 });
  await expect(item).toContainText('Deleted the draft');
  expect(await sandbox<unknown[]>('/__drafts', { account: mailbox })).toEqual([]);

  // ------------------------------------------------------------ Time-to-Undo
  await page.goto('/admin/undo');
  const ttu = page.getByTestId('ttu-table');
  await expect(ttu).toContainText('gmail.send');
  await expect(ttu).toContainText('Revoked in its hold');
  await expect(ttu).toContainText('gmail.draft');
  await expect(ttu).toContainText('Compensated');
});
