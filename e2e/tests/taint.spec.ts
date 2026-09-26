import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

/**
 * Module 3 through the browser (docs/module3.md §8, §12): the plan sandbox on the chat surface
 * validates, dry-runs through the real interpreter, shows provenance chips and the provenance
 * graph, and explains a refusal; the security page lists taint violations and manages the
 * trusted-contacts registry `resolve` endorses from.
 */

const GATEWAY = process.env['GATEWAY_PUBLIC_URL'] ?? 'http://localhost:3001';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
const suffix = Date.now().toString(36);
const email = `e2e-taint-${suffix}@example.com`;
const password = 'E2e-Password-1!';

test.beforeAll(async () => {
  const res = await fetch(`${GATEWAY}/v1/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, company: `Taint Co ${suffix}`, displayName: 'Taint Owner', password }),
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

test('plan sandbox: static rejection, dry run with provenance, graph; security page: contacts and violations', async ({ page }) => {
  await signIn(page, '/chat');
  // Module 4 made conversations the chat surface's first tab; the sandbox sits beside them.
  await page.getByRole('tab', { name: 'Plan sandbox' }).click();
  const program = page.getByLabel('Program');

  // A laundering plan is rejected statically, with the reason, before anything runs.
  await program.fill(`let m = call gmail.read({ messageId: "1" })\nlet c = extract m into ContactDetails\ncall gmail.send({ to: [c.email], subject: "x", body: "y" })`);
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByRole('status').getByText(/TAINT_RECIPIENT/)).toBeVisible();
  await expect(page.getByRole('status').getByText(/CRITICAL/)).toBeVisible();

  // A program over trusted values runs end to end and shows where every output came from.
  await program.fill(`let greeting = "Hello"\nlet who = resolve "nobody@nowhere.example" in directory\nemit render("plain", { greeting: greeting, found: count(who) })`);
  await page.getByRole('button', { name: 'Dry run' }).click();
  await expect(page.getByText('Completed (simulated)')).toBeVisible();
  const figure = page.locator('figure').first();
  await expect(figure).toContainText('greeting: Hello');
  await expect(figure.getByLabel(/Trusted —/)).toBeVisible();
  await page.getByRole('button', { name: 'View provenance graph' }).click();
  await expect(page.getByRole('img', { name: /Provenance graph with \d+ values/ })).toBeVisible();

  // A plan needing a connector that is not connected fails closed, visibly.
  await program.fill(`let r = call gmail.search({ query: "x" })\nemit count(r.messages)`);
  await page.getByRole('button', { name: 'Dry run' }).click();
  await expect(page.getByText('Failed', { exact: true })).toBeVisible();

  // The trusted-contacts registry.
  await page.goto('/admin/security');
  await expect(page.getByRole('heading', { name: 'Taint violations' })).toBeVisible();
  await expect(page.getByText('No open violations.')).toBeVisible();
  await page.getByLabel('Contact email').fill(`partner-${suffix}@acme.example`);
  await page.getByLabel('Contact name').fill('Partner');
  await page.getByRole('button', { name: 'Trust contact' }).click();
  await expect(page.getByText(`partner-${suffix}@acme.example`)).toBeVisible();
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('No trusted contacts yet.')).toBeVisible();
});
