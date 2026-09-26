import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, describe, it } from 'vitest';
import plugin from '../src/index.js';

/**
 * FIXTURE TESTS — implementation plan Step 9: "a violating fixture must fail the build".
 * Every rule has code it must reject AND the sanctioned alternative it must accept, so a rule
 * that silently stops matching (or starts over-matching) fails here.
 */

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser as never, ecmaVersion: 2023, sourceType: 'module' },
});

const root = '/repo';
const at = (rel: string) => `${root}/${rel}`;
const rule = (name: keyof typeof plugin.rules) => plugin.rules[name] as never;

tester.run('no-evidence-write-from-execution', rule('no-evidence-write-from-execution'), {
  valid: [
    { filename: at('services/execution/src/main.ts'), code: `import { EvidenceAppendClient } from './evidence-append.js';` },
    { filename: at('services/evidence/src/main.ts'), code: `import { EvidenceWriter } from '@vega/db/evidence';` },
  ],
  invalid: [
    { filename: at('services/execution/src/leak.ts'), code: `import { EvidenceWriter } from '@vega/db/evidence';`, errors: [{ messageId: 'name' }, { messageId: 'source' }] },
    { filename: at('services/execution/src/leak.ts'), code: `export * from '@vega/service-evidence';`, errors: [{ messageId: 'source' }] },
    { filename: at('services/execution/src/leak.ts'), code: `const m = await import('@vega/db/evidence');`, errors: [{ messageId: 'source' }] },
  ],
});

tester.run('no-raw-db-pool', rule('no-raw-db-pool'), {
  valid: [
    { filename: at('packages/db/src/client.ts'), code: `import pg from 'pg'; const p = new pg.Pool({});` },
    { filename: at('services/control/src/x.ts'), code: `import { withTenant } from '@vega/db';` },
  ],
  invalid: [
    { filename: at('services/control/src/x.ts'), code: `import pg from 'pg';`, errors: [{ messageId: 'driver' }] },
    { filename: at('services/gateway/src/x.ts'), code: `import { drizzle } from 'drizzle-orm/node-postgres';`, errors: [{ messageId: 'driver' }] },
    { filename: at('services/control/src/x.ts'), code: `const p = new Pool({});`, errors: [{ messageId: 'pool' }] },
  ],
});

tester.run('no-eval', rule('no-eval'), {
  valid: [
    { filename: at('packages/taint/src/sandbox.ts'), code: `new Function('return 1');` },
    { filename: at('services/control/src/x.ts'), code: `setTimeout(() => undefined, 1);` },
  ],
  invalid: [
    { filename: at('services/control/src/x.ts'), code: `eval('1+1');`, errors: [{ messageId: 'eval' }] },
    { filename: at('services/control/src/x.ts'), code: `new Function('a', 'return a');`, errors: [{ messageId: 'eval' }] },
    { filename: at('services/control/src/x.ts'), code: `import vm from 'node:vm';`, errors: [{ messageId: 'eval' }] },
    { filename: at('services/control/src/x.ts'), code: `globalThis.eval('x');`, errors: [{ messageId: 'eval' }] },
    { filename: at('services/control/src/x.ts'), code: `setTimeout('alert(1)', 10);`, errors: [{ messageId: 'eval' }] },
  ],
});

tester.run('require-tenant-context', rule('require-tenant-context'), {
  valid: [
    { filename: at('services/control/src/routers/users.ts'), code: `import { procedure } from '../trpc.js'; export const r = procedure.query(() => 1);` },
    { filename: at('services/control/src/x.ts'), code: `import { withTenant } from '@vega/db'; const id = principal.tenantId;` },
    { filename: at('packages/db/src/seed.ts'), code: `import { withSystemBypassingRls } from './client.js';` },
  ],
  invalid: [
    { filename: at('services/control/src/x.ts'), code: `import { withSystemBypassingRls } from '@vega/db';`, errors: [{ messageId: 'unscoped' }] },
    { filename: at('services/gateway/src/x.ts'), code: `import { getAppPool } from '@vega/db';`, errors: [{ messageId: 'unscoped' }] },
    { filename: at('services/control/src/routers/x.ts'), code: `export const r = t.procedure.query(() => 1);`, errors: [{ messageId: 'bareProcedure' }] },
    { filename: at('services/control/src/routers/x.ts'), code: `export const r = publicProcedure.query(() => 1);`, errors: [{ messageId: 'bareProcedure' }] },
    { filename: at('services/gateway/src/x.ts'), code: `const t = req.headers['x-tenant-id'];`, errors: [{ messageId: 'requestTenant' }] },
    { filename: at('services/gateway/src/x.ts'), code: `const t = request.query.tenantId;`, errors: [{ messageId: 'requestTenant' }] },
    { filename: at('services/gateway/src/x.ts'), code: `const t = req.body.tenant_id;`, errors: [{ messageId: 'requestTenant' }] },
  ],
});

tester.run('no-plan-branching', rule('no-plan-branching'), {
  valid: [
    { code: `if (entitlements.exposed.sso) show();` },
    { code: `if (user.role === 'OWNER') x();` },
    { code: `const label = { free: 'Free' }[tenant.plan];` },
  ],
  invalid: [
    { code: `if (tenant.plan === 'enterprise') unlock();`, errors: [{ messageId: 'branch' }] },
    { code: `if ('free' !== ctx.plan) x();`, errors: [{ messageId: 'branch' }] },
    { code: `switch (tenant.plan) { case 'pro': a(); break; case 'teams': b(); }`, errors: [{ messageId: 'branch' }, { messageId: 'branch' }] },
    { code: `const x = plan == 'business' ? 1 : 2;`, errors: [{ messageId: 'branch' }] },
  ],
});

const body = `toolId: 'gmail.draft', scopes: [], egressClass: 'INTERNAL', maxTaint: 'TRUSTED', outputTaint: 'ORG', idempotency: 'NATIVE', recipientArgs: [], argsSchema: a, effectSchema: e, simulate() {}, execute() {}`;
const tool = (extra: string) => `defineTool({ ${body}, ${extra} })`;
const file = at('packages/connectors/gmail/src/tools.ts');

tester.run('require-tool-declaration', rule('require-tool-declaration'), {
  valid: [
    { filename: file, code: tool(`reversibility: 'R1', compensatorRef: 'gmail.draft.delete'`) },
    { filename: file, code: tool(`reversibility: 'R2', compensatorRef: 'gmail.send.recall'`) },
    { filename: file, code: tool(`reversibility: 'R0'`) },
    { filename: file, code: tool(`reversibility: 'R3', compensatorRef: null`) },
    { filename: at('services/control/src/x.ts'), code: `defineTool({})` }, // outside connectors: not its concern
    { filename: at('packages/connectors/mcp/src/index.ts'), code: `defineRuntimeTool(body)` },
  ],
  invalid: [
    { filename: file, code: `defineRuntimeTool(body)`, errors: [{ messageId: 'runtimeFactory' }] },
    {
      filename: file,
      code: tool(`reversibility: 'R1'`),
      errors: [{ messageId: 'compensatorRequired', data: { rev: 'R1' } }],
    },
    {
      filename: file,
      code: tool(`reversibility: 'R2', compensatorRef: null`),
      errors: [{ messageId: 'compensatorRequired', data: { rev: 'R2' } }],
    },
    { filename: file, code: tool(`reversibility: 'R3', compensatorRef: 'x.undo'`), errors: [{ messageId: 'compensatorForbidden' }] },
    { filename: file, code: tool(`reversibility: rev, compensatorRef: 'x'`), errors: [{ messageId: 'reversibilityNotLiteral' }] },
    {
      filename: file,
      code: `defineTool({ toolId: 'x.y', reversibility: 'R0', simulate() {}, execute() {} })`,
      errors: ['scopes', 'egressClass', 'maxTaint', 'outputTaint', 'idempotency', 'recipientArgs', 'argsSchema', 'effectSchema'].map(
        (key) => ({ messageId: 'missing' as const, data: { key } }),
      ),
    },
    { filename: file, code: `defineTool(decl)`, errors: [{ messageId: 'notLiteral' }] },
    {
      filename: file,
      code: `defineTool({ ...base, ${body}, reversibility: 'R0' })`,
      errors: [{ messageId: 'spread' }],
    },
  ],
});

tester.run('no-taint-cast', rule('no-taint-cast'), {
  valid: [
    { filename: at('packages/taint/src/value.ts'), code: `const v = x as unknown as TaintedValue<T>;` },
    { filename: at('packages/interpreter/src/a.ts'), code: `const v = derive(1, [a], 'v');` },
  ],
  invalid: [
    { filename: at('packages/interpreter/src/a.ts'), code: `const v = x as unknown as TaintedValue;`, errors: [{ messageId: 'cast' }] },
    { filename: at('services/execution/src/a.ts'), code: `const v = <Untrusted<string>>x;`, errors: [{ messageId: 'cast' }] },
    { filename: at('services/execution/src/a.ts'), code: `const v = x as Array<TaintedValue>;`, errors: [{ messageId: 'cast' }] },
    { filename: at('apps/web/src/a.ts'), code: `const v = x satisfies TaintedValue | null;`, errors: [{ messageId: 'cast' }] },
  ],
});

tester.run('no-untrusted-in-privileged (inert until configured by M3)', rule('no-untrusted-in-privileged'), {
  valid: [
    { filename: at('packages/planner/src/plan.ts'), code: `import { Untrusted } from '@vega/taint';` },
    {
      filename: at('packages/planner/src/plan.ts'),
      code: `import type { TypedExtraction } from '@vega/taint';`,
      options: [{ privilegedPaths: ['packages/planner/'], untrustedTypes: ['Untrusted'] }],
    },
  ],
  invalid: [
    {
      filename: at('packages/planner/src/plan.ts'),
      code: `import type { Untrusted } from '@vega/taint'; let x: Untrusted<string>;`,
      options: [{ privilegedPaths: ['packages/planner/'], untrustedTypes: ['Untrusted'] }],
      errors: [{ messageId: 'type' }, { messageId: 'type' }],
    },
    {
      filename: at('packages/planner/src/plan.ts'),
      code: `import { raw } from '@vega/connectors/gmail';`,
      options: [{ privilegedPaths: ['packages/planner/'], untrustedModules: ['@vega/connectors'] }],
      errors: [{ messageId: 'module' }],
    },
  ],
});
