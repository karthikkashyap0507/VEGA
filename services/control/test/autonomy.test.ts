import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { agentCreatedTuples, fga as fgaObj, tenantRoleTuples, tuple, type Role } from '@vega/authz';
import { PgMcpToolStore } from '@vega/connector-mcp';
import { launchRegistry } from '@vega/connectors';
import { DEFAULT_CATALOG } from '@vega/policy-engine';
import { plannerRoute } from '../src/agent/routing.js';
import { AutonomyService } from '../src/autonomy/service.js';
import type { EvidenceClient } from '../src/evidence/client.js';
import { createHarness, problemOf, type Harness } from './harness.js';

/**
 * MODULE 10, CONTROL PLANE (docs/module10.md §4, §6, §10–§12, §16, §18) against real Postgres and
 * OpenFGA, through the real HTTP surface with signed principal assertions.
 *
 * What is proved here is who may do what to the ladder and to contention, and that every human
 * action is recorded. What is NOT proved here — that a tier actually holds a call back — is the
 * executor's job and is tested there (services/execution/test/autonomy.test.ts).
 */

vi.setConfig({ testTimeout: 60_000 });
process.env['LOCAL_KEK_BASE64'] ??= randomBytes(32).toString('base64');

const OWNER_URL = process.env['DATABASE_URL'] ?? 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
const owner = new pg.Pool({ connectionString: OWNER_URL, max: 3 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await owner.query<T>(sql, params)).rows;

// The evidence plane, as far as the control plane is concerned: an append that returns an entry.
const appended: Array<{ tenantId: string; kind: string; payload: Record<string, unknown>; content?: unknown[] }> = [];
let evidenceDown = false;
const evidence = {
  append: async (e: { tenantId: string; kind: string; payload: Record<string, unknown>; content?: unknown[] }) => {
    if (evidenceDown) throw new Error('evidence plane unavailable');
    appended.push(e);
    return { id: randomUUID(), seq: appended.length, entryHash: `sha256:${createHash('sha256').update(JSON.stringify(e)).digest('hex')}` };
  },
} as unknown as EvidenceClient;

let h: Harness;
let svc: AutonomyService;
let T: Awaited<ReturnType<Harness['tenant']>>;
let B: Awaited<ReturnType<Harness['tenant']>>;
const U: Record<'admin' | 'workflowOwner' | 'otherOwner' | 'compliance' | 'auditor' | 'member', string> = { admin: '', workflowOwner: '', otherOwner: '', compliance: '', auditor: '', member: '' };
let agentId = '';
let otherAgentId = '';

const TOOL = 'gcal.create'; // R1: 200 samples to certify
const as = (who: keyof typeof U | 'owner') => h.as(T.tenantId, who === 'owner' ? T.userId : U[who]);

async function mkUser(tenantId: string, role: Role, name: string): Promise<string> {
  const id = (await q<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`, [tenantId, `${name}-${tenantId.slice(0, 6)}@example.com`, name, role]))[0]!.id;
  const t = tenantRoleTuples(tenantId, id, role);
  await h.fga.write([t.current]);
  return id;
}

async function mkAgent(tenantId: string, workspaceId: string, ownerUserId: string, name: string): Promise<string> {
  const id = (await q<{ id: string }>(`INSERT INTO agents (tenant_id, workspace_id, name, owner_user_id, idp_machine_id, status) VALUES ($1, $2, $3, $4, 'm', 'active') RETURNING id`, [tenantId, workspaceId, name, ownerUserId]))[0]!.id;
  await h.fga.write(agentCreatedTuples({ agentId: id, workspaceId, tenantId, ownerUserId }));
  return id;
}

/** `n` decisions on the corpus, the way the executor writes them (one statement; data-modifying CTEs). */
async function decisions(tenantId: string, workspaceId: string, userId: string, agent: string, n: number, o: { toolId?: string; decision?: 'approve' | 'reject'; edited?: boolean; diff?: unknown } = {}) {
  const tool = o.toolId ?? TOOL;
  const decision = o.decision ?? 'approve';
  await q(
    `WITH r AS (
       INSERT INTO runs (tenant_id, workspace_id, agent_id, principal_user_id, trigger, objective_json, status, started_at, cost_cents)
       SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'api', '{"objective":"x"}', 'COMPLETED', now() - (g || ' hours')::interval, 2 FROM generate_series(1, $5::int) g RETURNING id
     ), n AS (
       INSERT INTO task_nodes (tenant_id, run_id, program_version, step_index, kind, tool_id, status)
       SELECT $1::uuid, id, 1, 0, 'TOOL_CALL', $6, 'done' FROM r RETURNING id, run_id
     ), a AS (
       INSERT INTO actions (tenant_id, run_id, node_id, tool_id, args_digest, taint_level, reversibility, state)
       SELECT $1::uuid, run_id, id, $6, 'sha256:x', 'TRUSTED', 'R1', 'COMMITTED' FROM n RETURNING id
     ), q AS (
       INSERT INTO approval_requests (tenant_id, run_id, node_id, approval_key, tool_id, requester, approver_role, packet_json, packet_digest, expires_at, fallback, state)
       SELECT $1::uuid, run_id, id, 'k-' || gen_random_uuid()::text, $6, $4::uuid, 'APPROVER', '{}', 'sha256:x', now() + interval '1 day', 'AUTO_REJECT', $7 FROM n RETURNING id, run_id
     )
     INSERT INTO approval_decisions (tenant_id, request_id, run_id, tool_id, approver_id, decision, edited, edit_diff_json, latency_ms, evidence_opened, surface, packet_digest, packet_chars, created_at)
     SELECT $1::uuid, id, run_id, $6, $4::uuid, $8, $9, $10::jsonb, 6000, true, 'web', 'sha256:x', 300, now() - interval '1 hour' FROM q`,
    [tenantId, workspaceId, agent, userId, n, tool, decision === 'reject' ? 'rejected' : 'approved', decision, o.edited ?? false, o.diff === undefined ? null : JSON.stringify(o.diff)],
  );
}

beforeAll(async () => {
  svc = new AutonomyService({ evidence, log: { warn: () => undefined } });
  h = await createHarness({
    autonomy: svc,
    // Only the declarations are read from here (the registry and the MCP store); the rest is for the connector routes.
    connectors: { registry: launchRegistry(), mcpStore: new PgMcpToolStore(), oauthClients: {}, vault: undefined, execution: undefined, stateSecret: 'autonomy-test-state-secret-long-enough-0123' } as never,
    agent: { core: { execution: { toolDeclarations: async (_t: string, ids: string[]) => ids.map((toolId) => ({ toolId })) } }, coordinator: {} } as never,
    evidence,
  });
  T = await h.tenant('enterprise');
  B = await h.tenant('business');
  U.admin = await mkUser(T.tenantId, 'ADMIN', 'admin');
  U.workflowOwner = await mkUser(T.tenantId, 'WORKFLOW_OWNER', 'wfowner');
  U.otherOwner = await mkUser(T.tenantId, 'WORKFLOW_OWNER', 'other');
  U.compliance = await mkUser(T.tenantId, 'COMPLIANCE_OFFICER', 'compliance');
  U.auditor = await mkUser(T.tenantId, 'AUDITOR', 'auditor');
  U.member = await mkUser(T.tenantId, 'MEMBER', 'member');
  for (const u of [U.workflowOwner, U.otherOwner, U.member]) await h.fga.write([tuple(fgaObj.user(u), 'member', fgaObj.workspace(T.workspaceId))]);
  agentId = await mkAgent(T.tenantId, T.workspaceId, U.workflowOwner, 'client-comm');
  otherAgentId = await mkAgent(T.tenantId, T.workspaceId, U.otherOwner, 'ops-bot');
}, 90_000);

afterAll(async () => {
  await h?.close();
  await owner.end();
});

describe('the ladder starts at SHADOW and only enrolled pairs have a tier', () => {
  it('enrolling is idempotent and creates SHADOW; an unenrolled pair is not on the ladder', async () => {
    const owned = as('workflowOwner');
    expect((await problemOf(owned.autonomy.get.query({ agentId, toolId: TOOL }))).status).toBe(404);
    expect(await owned.autonomy.enroll.mutate({ agentId, toolId: TOOL })).toEqual({ created: true });
    expect(await owned.autonomy.enroll.mutate({ agentId, toolId: TOOL })).toEqual({ created: false });
    const got = await owned.autonomy.get.query({ agentId, toolId: TOOL });
    expect(got.state).toMatchObject({ tier: 'SHADOW', workflowKey: agentId, actionType: TOOL });
    expect((await as('admin').autonomy.list.query()).items.find((r) => r.workflowKey === agentId)).toMatchObject({ tier: 'SHADOW', daysAtTier: 0 });
  });
  it('someone who does not manage the agent cannot put it on the ladder', async () => {
    expect((await problemOf(as('otherOwner').autonomy.enroll.mutate({ agentId, toolId: 'gmail.send' }))).status).toBe(403);
    expect((await problemOf(as('member').autonomy.enroll.mutate({ agentId, toolId: 'gmail.send' }))).status).toBe(403);
  });
  it('an unknown tool is not enrolled', async () => {
    expect((await problemOf(as('workflowOwner').autonomy.enroll.mutate({ agentId, toolId: 'nothing.here' }))).status).toBe(404);
  });
});

describe('certification: signed into the evidence chain before it exists (§4)', () => {
  it('too little history → HOLD, with the sample-size gate failing and the report signed', async () => {
    await decisions(T.tenantId, T.workspaceId, T.userId, agentId, 12);
    const before = appended.length;
    const out = await as('workflowOwner').autonomy.certify.mutate({ agentId, toolId: TOOL, windowDays: 30 });
    expect(out.report.recommendation).toBe('HOLD');
    expect(out.report.sampleSize).toBe(12);
    expect(out.report.gate.find((g) => g.name === 'sample size')).toMatchObject({ pass: false });
    // one chain entry, kind certification.completed, carrying the report as content and its digest
    expect(appended.length).toBe(before + 1);
    const e = appended.at(-1)!;
    expect(e.kind).toBe('certification.completed');
    expect(e.payload).toMatchObject({ workflow_key: agentId, action_type: TOOL, recommendation: 'HOLD', sample_size: 12, requested_by: U.workflowOwner });
    expect(String(e.payload['report_digest'])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(e.content).toHaveLength(1);
    expect(out.certification.reportRef).toBe(`evidence:${out.evidenceEntryId}`);
    const report = await as('compliance').autonomy.report.query({ id: out.certification.id });
    expect(report.signed.reportRef).toBe(out.certification.reportRef);
    expect(report.signed.entryHash).toMatch(/^sha256:/);
    expect(report.ratification).toBeNull();
  });

  it('with no evidence plane the certification is refused and nothing is stored (an unsigned report is a claim)', async () => {
    evidenceDown = true;
    const [{ n: before }] = await q<{ n: string }>(`SELECT count(*)::text n FROM certifications WHERE tenant_id = $1`, [T.tenantId]) as [{ n: string }];
    const p = await problemOf(as('workflowOwner').autonomy.certify.mutate({ agentId, toolId: TOOL, windowDays: 30 }));
    evidenceDown = false;
    expect(p.status).toBeGreaterThanOrEqual(500);
    const [{ n: after }] = await q<{ n: string }>(`SELECT count(*)::text n FROM certifications WHERE tenant_id = $1`, [T.tenantId]) as [{ n: string }];
    expect(after).toBe(before);
  });

  it('a pair that is not on the ladder cannot be certified', async () => {
    expect((await problemOf(as('workflowOwner').autonomy.certify.mutate({ agentId, toolId: 'gcal.update', windowDays: 30 }))).status).toBe(422);
  });

  it('who may ask: the agent’s workflow owner yes; another workflow owner, a member, a compliance officer no', async () => {
    expect((await problemOf(as('otherOwner').autonomy.certify.mutate({ agentId, toolId: TOOL, windowDays: 30 }))).status).toBe(403);
    expect((await problemOf(as('member').autonomy.certify.mutate({ agentId, toolId: TOOL, windowDays: 30 }))).status).toBe(403);
    expect((await problemOf(as('compliance').autonomy.certify.mutate({ agentId, toolId: TOOL, windowDays: 30 }))).status).toBe(403);
  });

  it('the certification ladder is a plan surface: a lower plan cannot run one — but can still demote', async () => {
    const bOwner = h.as(B.tenantId, B.userId);
    const bAgent = await mkAgent(B.tenantId, B.workspaceId, B.userId, 'b-agent');
    await bOwner.autonomy.enroll.mutate({ agentId: bAgent, toolId: TOOL });
    const p = await problemOf(bOwner.autonomy.certify.mutate({ agentId: bAgent, toolId: TOOL, windowDays: 30 }));
    expect(p).toMatchObject({ status: 403, type: 'https://errors.vega.dev/entitlement-required' });
    // promoting is a plan surface too; enforcement and demotion are not.
    await q(`UPDATE autonomy_state SET tier = 'AUTONOMOUS' WHERE tenant_id = $1 AND workflow_key = $2`, [B.tenantId, bAgent]);
    const t = await bOwner.autonomy.demote.mutate({ agentId: bAgent, toolId: TOOL, to: 'SUPERVISED', reason: 'we are not ready' });
    expect(t).toMatchObject({ fromTier: 'AUTONOMOUS', toTier: 'SUPERVISED', trigger: 'manual' });
  });
});

describe('promotion is a human act, re-checked at ratification (§4.1, §18)', () => {
  let certId = '';
  it('a clean, sufficient history yields PROMOTE; the requester cannot ratify their own request', async () => {
    await decisions(T.tenantId, T.workspaceId, T.userId, agentId, 215);
    const out = await as('workflowOwner').autonomy.certify.mutate({ agentId, toolId: TOOL, windowDays: 30 });
    expect(out.report).toMatchObject({ recommendation: 'PROMOTE', recommendedTier: 'SUPERVISED', fromTier: 'SHADOW', criticalErrors: 0 });
    expect(out.report.agreementRate).toBeCloseTo(1, 5);
    expect(out.report.gate.every((g) => g.pass)).toBe(true);
    certId = out.certification.id;
    // A workflow owner holds autonomy.request_promotion, not autonomy.ratify.
    expect((await problemOf(as('workflowOwner').autonomy.promote.mutate({ certificationId: certId }))).status).toBe(403);
    expect((await problemOf(as('member').autonomy.promote.mutate({ certificationId: certId }))).status).toBe(403);
    expect((await problemOf(as('auditor').autonomy.promote.mutate({ certificationId: certId }))).status).toBe(403);
    expect((await q<{ tier: string }>(`SELECT tier FROM autonomy_state WHERE tenant_id = $1 AND workflow_key = $2`, [T.tenantId, agentId]))[0]!.tier).toBe('SHADOW');
  });

  it('a named human ratifies: the tier moves one step, the ratifier is recorded, and it lands in the chain', async () => {
    const before = appended.length;
    const out = await as('compliance').autonomy.promote.mutate({ certificationId: certId });
    expect(out.transition).toMatchObject({ fromTier: 'SHADOW', toTier: 'SUPERVISED', direction: 'PROMOTE', trigger: 'certification', actorId: U.compliance });
    expect(out.certification).toMatchObject({ ratifiedBy: U.compliance });
    const [s] = await q<{ tier: string; ratified_by: string; certification_id: string }>(`SELECT tier, ratified_by, certification_id FROM autonomy_state WHERE tenant_id = $1 AND workflow_key = $2 AND action_type = $3`, [T.tenantId, agentId, TOOL]);
    expect(s).toMatchObject({ tier: 'SUPERVISED', ratified_by: U.compliance, certification_id: certId });
    const e = appended.slice(before).find((x) => x.kind === 'autonomy.changed')!;
    expect(e.payload).toMatchObject({ direction: 'PROMOTE', from: 'SHADOW', to: 'SUPERVISED', ratified_by: U.compliance, certification_id: certId, automatic: false });
    // the platform event a webhook subscribes to
    const ev = await q(`SELECT kind FROM platform_events WHERE tenant_id = $1 AND kind = 'autonomy.promoted'`, [T.tenantId]);
    expect(ev.length).toBeGreaterThan(0);
  });

  it('a certification is acted on once: ratifying it again is refused', async () => {
    const p = await problemOf(as('admin').autonomy.promote.mutate({ certificationId: certId }));
    expect(p.status).toBe(422);
    expect(p.detail).toMatch(/already acted on|not a single promotion|re-certify/);
  });

  it('at ratification the gate is checked again: a connector that changed since certification blocks it', async () => {
    // a fresh pair, certified, then the declared version moves before a human ratifies
    const a = await mkAgent(T.tenantId, T.workspaceId, U.workflowOwner, `drift-${randomUUID().slice(0, 6)}`);
    await as('workflowOwner').autonomy.enroll.mutate({ agentId: a, toolId: TOOL });
    await decisions(T.tenantId, T.workspaceId, T.userId, a, 205);
    const c = await as('workflowOwner').autonomy.certify.mutate({ agentId: a, toolId: TOOL, windowDays: 30 });
    expect(c.report.recommendation).toBe('PROMOTE');
    await q(`UPDATE certifications SET connector_versions = $1 WHERE id = $2`, [JSON.stringify({ [TOOL]: 99 }), c.certification.id]);
    const p = await problemOf(as('admin').autonomy.promote.mutate({ certificationId: c.certification.id }));
    expect(p.status).toBe(422);
    expect(p.detail).toMatch(/connector changed since certification/);
    expect((await q<{ tier: string }>(`SELECT tier FROM autonomy_state WHERE tenant_id = $1 AND workflow_key = $2`, [T.tenantId, a]))[0]!.tier).toBe('SHADOW');
  });

  it('a history with an edit that touched a recipient is a critical error: DEMOTE, and it cannot be ratified', async () => {
    const a = await mkAgent(T.tenantId, T.workspaceId, U.workflowOwner, `crit-${randomUUID().slice(0, 6)}`);
    await as('workflowOwner').autonomy.enroll.mutate({ agentId: a, toolId: 'gmail.send' });
    await decisions(T.tenantId, T.workspaceId, T.userId, a, 20, { toolId: 'gmail.send' });
    await decisions(T.tenantId, T.workspaceId, T.userId, a, 1, { toolId: 'gmail.send', edited: true, diff: [{ path: 'to[0]', op: 'changed', before: 'a@acme.example', after: 'b@other.example' }] });
    const c = await as('workflowOwner').autonomy.certify.mutate({ agentId: a, toolId: 'gmail.send', windowDays: 30 });
    expect(c.report).toMatchObject({ recommendation: 'DEMOTE', criticalErrors: 1 });
    expect(c.report.errorTaxonomy.find((e) => e.key === 'wrong_recipient')).toMatchObject({ critical: true, count: 1 });
    expect(c.report.gate.find((g) => g.name === 'critical errors')?.pass).toBe(false);
    expect((await problemOf(as('admin').autonomy.promote.mutate({ certificationId: c.certification.id }))).status).toBe(422);
  });
});

describe('demotion: always allowed to those who may promote, stricter only, recorded (§6, §18)', () => {
  it('a manual demotion records who, why, and the chain entry; a "demotion" upward is refused', async () => {
    await q(`UPDATE autonomy_state SET tier = 'AUTONOMOUS', since = now() - interval '5 days' WHERE tenant_id = $1 AND workflow_key = $2 AND action_type = $3`, [T.tenantId, agentId, TOOL]);
    const before = appended.length;
    const t = await as('compliance').autonomy.demote.mutate({ agentId, toolId: TOOL, to: 'SUSPENDED', reason: 'customer complaint under review' });
    expect(t).toMatchObject({ fromTier: 'AUTONOMOUS', toTier: 'SUSPENDED', direction: 'DEMOTE', trigger: 'manual', actorId: U.compliance });
    expect((t.evidenceJson as { reason: string }).reason).toBe('customer complaint under review');
    expect(appended.slice(before).find((x) => x.kind === 'autonomy.changed')?.payload).toMatchObject({ direction: 'DEMOTE', trigger: 'manual', to: 'SUSPENDED', by: U.compliance });
    const up = await problemOf(as('admin').autonomy.demote.mutate({ agentId, toolId: TOOL, to: 'AUTONOMOUS', reason: 'trying to go back up' }));
    expect(up.status).toBe(422);
  });
  it('a reason is required; a member and an auditor cannot demote', async () => {
    expect((await problemOf(as('admin').autonomy.demote.mutate({ agentId, toolId: TOOL, to: 'SUSPENDED', reason: ' ' }))).status).toBe(400);
    expect((await problemOf(as('member').autonomy.demote.mutate({ agentId, toolId: TOOL, to: 'SUSPENDED', reason: 'please stop' }))).status).toBe(403);
    expect((await problemOf(as('auditor').autonomy.demote.mutate({ agentId, toolId: TOOL, to: 'SUSPENDED', reason: 'please stop' }))).status).toBe(403);
  });
  it('the full history is readable, newest first', async () => {
    const h1 = await as('admin').autonomy.transitions.query({ agentId, toolId: TOOL });
    expect(h1.items.map((t) => t.trigger)).toEqual(['manual', 'certification']);
  });
  it('re-promotion after a suspension needs a fresh certification: the old one is refused', async () => {
    const [c] = await q<{ id: string }>(`SELECT id FROM certifications WHERE tenant_id = $1 AND workflow_key = $2 AND recommendation = 'PROMOTE' ORDER BY created_at DESC LIMIT 1`, [T.tenantId, agentId]);
    const p = await problemOf(as('admin').autonomy.promote.mutate({ certificationId: c!.id }));
    expect(p.status).toBe(422);
  });
});

describe('P2: changing an agent resets what was certified; templates never start above SHADOW (§11)', () => {
  const spec = (over: Record<string, unknown> = {}) => ({ objectiveTemplate: 'Do the thing', allowedConnectors: [], allowedTools: [TOOL], triggers: [{ kind: 'manual' as const }], policyBindings: [], escalation: { approverRole: 'APPROVER', expiry: '4h', fallback: 'AUTO_REJECT' as const }, limits: { maxSteps: 20, maxCostCents: 200, maxFanout: 5 }, autonomy: 'SHADOW' as const, ...over });

  it('a changed spec demotes pairs above SUPERVISED (version_change); an unchanged re-save does not', async () => {
    const a = await mkAgent(T.tenantId, T.workspaceId, U.workflowOwner, `ver-${randomUUID().slice(0, 6)}`);
    const owned = as('workflowOwner');
    await owned.agents.putSpec.mutate({ id: a, spec: spec() });
    await owned.autonomy.enroll.mutate({ agentId: a, toolId: TOOL });
    await q(`UPDATE autonomy_state SET tier = 'AUTONOMOUS', sample_rate = NULL WHERE tenant_id = $1 AND workflow_key = $2`, [T.tenantId, a]);
    await owned.agents.putSpec.mutate({ id: a, spec: spec() }); // same content
    expect((await q<{ tier: string }>(`SELECT tier FROM autonomy_state WHERE workflow_key = $1`, [a]))[0]!.tier).toBe('AUTONOMOUS');
    await owned.agents.putSpec.mutate({ id: a, spec: spec({ objectiveTemplate: 'Do a different thing' }) });
    const [s] = await q<{ tier: string }>(`SELECT tier FROM autonomy_state WHERE workflow_key = $1`, [a]);
    expect(s!.tier).toBe('SUPERVISED');
    const [t] = await q<{ trigger: string; direction: string; evidence_json: { agentVersion: number } }>(`SELECT trigger, direction, evidence_json FROM autonomy_transitions WHERE workflow_key = $1 ORDER BY created_at DESC LIMIT 1`, [a]);
    expect(t).toMatchObject({ trigger: 'version_change', direction: 'DEMOTE' });
    expect(t!.evidence_json.agentVersion).toBeGreaterThan(1);
    expect(appended.at(-1)!.payload).toMatchObject({ trigger: 'version_change', automatic: true, to: 'SUPERVISED' });
  });

  it('the five team templates are listed; applying one saves a spec and puts its consequential tools at SHADOW', async () => {
    const list = await as('admin').teamTemplates.list.query();
    expect(list.items.map((t) => t.key)).toEqual(['sales', 'operations', 'hr', 'marketing', 'management']);
    expect(list.items.every((t) => t.startsAt === 'SHADOW')).toBe(true);
    const a = await mkAgent(T.tenantId, T.workspaceId, U.admin, `sales-${randomUUID().slice(0, 6)}`);
    const out = await as('admin').teamTemplates.applyTemplate.mutate({ agentId: a, template: 'sales' });
    expect(out.startsAt).toBe('SHADOW');
    expect(out.enrolled).toEqual(expect.arrayContaining(['gmail.send', 'gmail.draft']));
    expect(out.enrolled).not.toContain('web.search'); // reads are not on the ladder
    const rows = await q<{ tier: string }>(`SELECT tier FROM autonomy_state WHERE tenant_id = $1 AND workflow_key = $2`, [T.tenantId, a]);
    expect(rows.length).toBe(out.enrolled.length);
    expect(rows.every((r) => r.tier === 'SHADOW')).toBe(true);
  });

  it('re-applying a template to an agent that earned a tier does not hand it back a higher one — and a changed spec resets it', async () => {
    const a = await mkAgent(T.tenantId, T.workspaceId, U.admin, `reapply-${randomUUID().slice(0, 6)}`);
    await as('admin').teamTemplates.applyTemplate.mutate({ agentId: a, template: 'hr' });
    await q(`UPDATE autonomy_state SET tier = 'SAMPLED', sample_rate = 5 WHERE tenant_id = $1 AND workflow_key = $2 AND action_type = 'gmail.send'`, [T.tenantId, a]);
    await as('admin').teamTemplates.applyTemplate.mutate({ agentId: a, template: 'sales' }); // a different spec
    const [s] = await q<{ tier: string }>(`SELECT tier FROM autonomy_state WHERE workflow_key = $1 AND action_type = 'gmail.send'`, [a]);
    expect(s!.tier).toBe('SUPERVISED');
  });

  it('a member cannot apply a template', async () => {
    expect((await problemOf(as('member').teamTemplates.applyTemplate.mutate({ agentId, template: 'sales' }))).status).toBe(403);
  });
});

describe('learned policy: proposals are read-only artifacts (§5, §18)', () => {
  it('mining proposes; deciding changes no tier and no policy; a decided proposal cannot be decided again', async () => {
    const a = await mkAgent(T.tenantId, T.workspaceId, U.workflowOwner, `prop-${randomUUID().slice(0, 6)}`);
    await as('workflowOwner').autonomy.enroll.mutate({ agentId: a, toolId: 'gcal.update' });
    await decisions(T.tenantId, T.workspaceId, T.userId, a, 34, { toolId: 'gcal.update' });
    const made = await as('workflowOwner').autonomy.generateProposals.mutate();
    const mine = made.created.filter((p) => (p.subjectJson as { workflowKey: string }).workflowKey === a);
    expect(mine.length).toBeGreaterThan(0);
    const p = mine.find((x) => x.kind === 'promote')!;
    expect((p.evidenceJson as { decisionIds: string[] }).decisionIds.length).toBe(34); // cites every decision
    const open = await as('compliance').autonomy.proposals.query();
    expect(open.items.some((x) => x.id === p.id)).toBe(true);

    const tierBefore = (await q<{ tier: string }>(`SELECT tier FROM autonomy_state WHERE workflow_key = $1`, [a]))[0]!.tier;
    const policiesBefore = (await q<{ n: string }>(`SELECT count(*)::text n FROM policies WHERE tenant_id = $1`, [T.tenantId]))[0]!.n;
    const out = await as('compliance').autonomy.decideProposal.mutate({ id: p.id, decision: 'accepted' });
    expect(out.proposal.state).toBe('accepted');
    expect(out.next).toMatchObject({ action: 'request_certification' });
    expect((await q<{ tier: string }>(`SELECT tier FROM autonomy_state WHERE workflow_key = $1`, [a]))[0]!.tier).toBe(tierBefore);
    expect((await q<{ n: string }>(`SELECT count(*)::text n FROM policies WHERE tenant_id = $1`, [T.tenantId]))[0]!.n).toBe(policiesBefore);
    expect((await problemOf(as('compliance').autonomy.decideProposal.mutate({ id: p.id, decision: 'dismissed' }))).status).toBe(422);
    expect((await problemOf(as('member').autonomy.decideProposal.mutate({ id: p.id, decision: 'accepted' }))).status).toBe(403);
  });
});

describe('contention operations: audited, with a reason (§10, §18)', () => {
  it('"who else is on this account" shows every holder; releasing a lock is admin-only, needs a reason, and is recorded', async () => {
    const entity = `crm:acct-${randomUUID().slice(0, 8)}`;
    const got = await svc.locks.acquire({ tenantId: T.tenantId, runId: randomUUID(), agentId, intent: 'update the account owner', riskTier: 'MEDIUM', entityKey: entity, mode: 'EXCLUSIVE_WRITE' });
    expect(got.ok).toBe(true);
    const act = await as('member').contention.activity.query({ entityKey: entity });
    expect(act.holders).toHaveLength(1);
    expect(act.holders[0]).toMatchObject({ agentId, intent: 'update the account owner', mode: 'EXCLUSIVE_WRITE' });
    const lockId = (await as('member').contention.locks.query()).items.find((l) => l.entityKey === entity)!.lockId;

    expect((await problemOf(as('member').contention.releaseLock.mutate({ lockId, reason: 'it is stuck' }))).status).toBe(403);
    expect((await problemOf(as('workflowOwner').contention.releaseLock.mutate({ lockId, reason: 'it is stuck' }))).status).toBe(403);
    expect((await problemOf(as('admin').contention.releaseLock.mutate({ lockId, reason: ' ' }))).status).toBe(400);
    expect(await as('admin').contention.releaseLock.mutate({ lockId, reason: 'run is hung; confirmed with the owner' })).toEqual({ released: true });
    expect((await as('member').contention.activity.query({ entityKey: entity })).holders).toHaveLength(0);
    const [ev] = await q<{ actor_id: string; payload: { reason: string; entityKey: string } }>(`SELECT actor_id, payload FROM platform_events WHERE tenant_id = $1 AND kind = 'lock.admin_released' ORDER BY created_at DESC LIMIT 1`, [T.tenantId]);
    expect(ev).toMatchObject({ actor_id: U.admin, payload: { entityKey: entity, reason: 'run is hung; confirmed with the owner' } });
    expect((await problemOf(as('admin').contention.releaseLock.mutate({ lockId, reason: 'again please' }))).status).toBe(404);
  });

  it('the contact ledger shows cooldowns; an override is an audited exception that says so', async () => {
    const runA = randomUUID();
    const runB = (await q<{ id: string }>(`INSERT INTO runs (tenant_id, workspace_id, agent_id, principal_user_id, trigger, objective_json, status) VALUES ($1,$2,$3,$4,'api','{"objective":"x"}','EXECUTING') RETURNING id`, [T.tenantId, T.workspaceId, otherAgentId, T.userId]))[0]!.id;
    const first = await svc.ledger.attempt({ tenantId: T.tenantId, identity: 'Pat.Lee@Acme.example', channel: 'email', runId: runA, agentId, onBehalfOf: T.userId, relationship: 'prospect' });
    expect(first.ok).toBe(true);
    const blocked = await svc.ledger.attempt({ tenantId: T.tenantId, identity: 'pat.lee@acme.example', channel: 'email', runId: runB, agentId: otherAgentId, onBehalfOf: T.userId, relationship: 'prospect' });
    expect(blocked.ok).toBe(false);

    const rows = await as('auditor').contention.contactLedger.query({ identity: 'PAT.LEE@acme.example' });
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]).toMatchObject({ externalIdentity: 'pat.lee@acme.example', inCooldown: true, byAgentId: agentId });
    expect((await problemOf(as('member').contention.contactLedger.query())).status).toBe(403);

    expect((await problemOf(as('workflowOwner').contention.contactOverride.mutate({ identity: 'pat.lee@acme.example', runId: runB, reason: 'urgent renewal' }))).status).toBe(403);
    expect((await problemOf(as('admin').contention.contactOverride.mutate({ identity: 'pat.lee@acme.example', runId: runB, reason: '' }))).status).toBe(400);
    await as('admin').contention.contactOverride.mutate({ identity: 'pat.lee@acme.example', runId: runB, reason: 'client asked us to follow up today' });
    const after = await as('admin').contention.contactLedger.query({ identity: 'pat.lee@acme.example' });
    const ov = after.items.find((r) => r.overrideReason);
    expect(ov).toMatchObject({ overrideReason: 'client asked us to follow up today', overriddenBy: U.admin, byRunId: runB });
    // the run named may now go through (its own repeat is not a second contact)…
    expect((await svc.ledger.attempt({ tenantId: T.tenantId, identity: 'pat.lee@acme.example', channel: 'email', runId: runB, agentId: otherAgentId, onBehalfOf: T.userId })).ok).toBe(true);
    // …and the platform event is the audit trail
    expect((await q(`SELECT 1 FROM platform_events WHERE tenant_id = $1 AND kind = 'contact.override'`, [T.tenantId])).length).toBeGreaterThan(0);
  });

  it('two different values for one field, equal stakes → escalated to a person, who chooses a winner', async () => {
    const entity = `crm:deal-${randomUUID().slice(0, 8)}`;
    const r1 = randomUUID();
    const r2 = randomUUID();
    const a = await svc.reconciler.declare({ tenantId: T.tenantId, entityKey: entity, field: 'stage', runId: r1, agentId, value: 'won', riskTier: 'HIGH' });
    expect(a.action).toBe('proceed');
    const b = await svc.reconciler.declare({ tenantId: T.tenantId, entityKey: entity, field: 'stage', runId: r2, agentId: otherAgentId, value: 'lost', riskTier: 'HIGH' });
    expect(b.action).toBe('escalate');

    const open = await as('member').contention.writeConflicts.query({ status: 'open' });
    const c = open.items.find((x) => x.entityKey === entity)!;
    expect(c).toMatchObject({ field: 'stage', resolution: 'escalated' });
    expect((await problemOf(as('member').contention.resolveConflict.mutate({ id: c.id, chosenRunId: r1 }))).status).toBe(403);
    // a run that is not one of the proposals cannot be chosen
    expect((await problemOf(as('admin').contention.resolveConflict.mutate({ id: c.id, chosenRunId: randomUUID() }))).status).toBe(422);
    const out = await as('admin').contention.resolveConflict.mutate({ id: c.id, chosenRunId: r1 });
    expect(out.value).toBe('won');
    expect((await as('member').contention.writeConflicts.query({ status: 'open' })).items.some((x) => x.entityKey === entity)).toBe(false);
    expect((await problemOf(as('admin').contention.resolveConflict.mutate({ id: c.id, chosenRunId: r2 }))).status).toBe(422);
  });
});

describe('★ budget behaviors at planning (P5 §12, §19 blocking)', () => {
  const route = plannerRoute(DEFAULT_CATALOG);
  const exceeded = async (tenantId: string) => (await q(`SELECT 1 FROM platform_events WHERE tenant_id = $1 AND kind = 'budget.exceeded'`, [tenantId])).length;
  async function capped(limit: number, behavior: string, spent: number) {
    const E = await h.tenant('enterprise');
    const a = await mkAgent(E.tenantId, E.workspaceId, E.userId, `spender-${randomUUID().slice(0, 6)}`);
    await q(`INSERT INTO runs (tenant_id, workspace_id, agent_id, principal_user_id, trigger, objective_json, status, cost_cents) VALUES ($1,$2,$3,$4,'api','{"objective":"x"}','COMPLETED',$5)`, [E.tenantId, E.workspaceId, a, E.userId, spent]);
    if (limit >= 0) await q(`INSERT INTO budgets (tenant_id, limit_cents, breach_behavior) VALUES ($1,$2,$3)`, [E.tenantId, limit, behavior]);
    return E.tenantId;
  }

  it('under the cap (or no cap) plans with the plan’s model and raises nothing', async () => {
    const none = await capped(-1, 'queue', 5_000);
    expect(await route({ tenantId: none })).toMatchObject({ model: 'claude-opus-5' });
    const under = await capped(10_000, 'halt', 5_000);
    const c = await route({ tenantId: under });
    expect(c.queue).toBeFalsy();
    expect(c.model).toBe('claude-opus-5');
    expect(await exceeded(under)).toBe(0);
  });

  it('queue: at the cap new plans are held, one budget.exceeded per hour, and the model is never upgraded', async () => {
    const tid = await capped(1_000, 'queue', 1_500);
    const c = await route({ tenantId: tid });
    expect(c.queue).toBe(true);
    expect(c.reasons.join(' ')).toMatch(/budget reached/);
    await route({ tenantId: tid });
    expect(await exceeded(tid)).toBe(1);
  });

  it('degrade: planning continues on the economy model — a downgrade, never an upgrade', async () => {
    const tid = await capped(1_000, 'degrade', 1_500);
    const c = await route({ tenantId: tid });
    expect(c).toMatchObject({ model: DEFAULT_CATALOG.economy.planner, queue: false });
    expect(c.reasons.join(' ')).toMatch(/degraded to the economy model/);
    expect(await exceeded(tid)).toBe(1);
  });

  it('halt: new plans are refused (the executor stops runs in flight — see the execution suite)', async () => {
    const tid = await capped(1_000, 'halt', 1_500);
    const c = await route({ tenantId: tid });
    expect(c.queue).toBe(true);
    expect(c.reasons.join(' ')).toMatch(/halted/);
    expect(await exceeded(tid)).toBe(1);
  });
});

describe('P5: usage analytics, anomalies and budgets (§12)', () => {
  it('usage by agent and by user: runs, cost, governed actions, and cost per governed action', async () => {
    const a = await mkAgent(T.tenantId, T.workspaceId, U.workflowOwner, `usage-${randomUUID().slice(0, 6)}`);
    await decisions(T.tenantId, T.workspaceId, U.member, a, 10); // 10 runs × 2¢, 10 governed actions
    const by = await as('auditor').usage.summary.query({ by: 'agent' });
    const row = by.rows.find((r) => r.key === a)!;
    expect(row).toMatchObject({ label: expect.stringMatching(/^usage-/), runs: 10, costCents: 20, governedActions: 10, succeeded: 10, successRate: 1 });
    expect(by.totals.costPerGovernedActionCents).not.toBeNull();
    const byUser = await as('auditor').usage.summary.query({ by: 'user' });
    expect(byUser.rows.find((r) => r.key === U.member)).toMatchObject({ runs: 10, costCents: 20 });
    const wf = await as('auditor').usage.summary.query({ by: 'workflow' });
    expect(wf.rows.find((r) => r.key === `${a}:${TOOL}`)).toMatchObject({ governedActions: 10, costCents: 20 });
    expect((await problemOf(as('member').usage.summary.query({ by: 'agent' }))).status).toBe(403);
  });

  it('spend far above an agent’s own baseline raises one anomaly event per day', async () => {
    const a = await mkAgent(T.tenantId, T.workspaceId, U.workflowOwner, `spike-${randomUUID().slice(0, 6)}`);
    // one run a day for two weeks, then a burst today
    await q(`INSERT INTO runs (tenant_id, workspace_id, agent_id, principal_user_id, trigger, objective_json, status, started_at, cost_cents)
             SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'api', '{"objective":"x"}', 'COMPLETED', now() - (g || ' days')::interval - interval '30 minutes', 5 FROM generate_series(1, 14) g`, [T.tenantId, T.workspaceId, a, U.member]);
    await q(`INSERT INTO runs (tenant_id, workspace_id, agent_id, principal_user_id, trigger, objective_json, status, started_at, cost_cents)
             SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'api', '{"objective":"x"}', 'COMPLETED', date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' + (g || ' seconds')::interval, 20 FROM generate_series(1, 30) g`, [T.tenantId, T.workspaceId, a, U.member]);
    const found = await as('auditor').usage.anomalies.query();
    const mine = found.items.filter((x) => x.subjectId === a);
    expect(mine.map((x) => x.metric).sort()).toEqual(['cost_cents', 'runs']);
    expect(mine.find((x) => x.metric === 'runs')!.factor).toBeGreaterThan(3);

    const first = await as('admin').usage.scanAnomalies.mutate();
    expect(first.raised).toBeGreaterThanOrEqual(2);
    const again = await as('admin').usage.scanAnomalies.mutate();
    expect(again.raised).toBe(0);
    expect((await problemOf(as('auditor').usage.scanAnomalies.mutate())).status).toBe(403);
    const ev = await q(`SELECT 1 FROM platform_events WHERE tenant_id = $1 AND kind = 'usage.anomaly' AND payload->>'subjectId' = $2`, [T.tenantId, a]);
    expect(ev.length).toBe(2);
  });

  it('a budget is a hard cap with a chosen breach behavior; setting it is `budgets.manage`', async () => {
    const t0 = await as('admin').budgets.get.query();
    expect(t0.breachBehavior).toBe('queue');
    expect((await problemOf(as('member').budgets.set.mutate({ limitCents: 1000, breachBehavior: 'halt' }))).status).toBe(403);
    expect((await problemOf(as('workflowOwner').budgets.set.mutate({ limitCents: 1000, breachBehavior: 'halt' }))).status).toBe(403);
    expect((await problemOf(as('admin').budgets.set.mutate({ limitCents: 1000, breachBehavior: 'explode' as never }))).status).toBe(400);
    expect((await problemOf(as('admin').budgets.set.mutate({ limitCents: -1, breachBehavior: 'halt' }))).status).toBe(400);

    await q(`INSERT INTO runs (tenant_id, workspace_id, agent_id, principal_user_id, trigger, objective_json, status, cost_cents) VALUES ($1,$2,$3,$4,'api','{"objective":"x"}','COMPLETED',100)`, [T.tenantId, T.workspaceId, agentId, T.userId]);
    const set = await as('admin').budgets.set.mutate({ limitCents: 25, breachBehavior: 'halt' });
    expect(set).toMatchObject({ limitCents: 25, breachBehavior: 'halt', updatedBy: U.admin });
    expect(set.spentCents).toBeGreaterThan(25);
    expect(set.state).toBe('exceeded');
    expect(set.remainingCents).toBe(0);
    const [row] = await q<{ limit_cents: number; breach_behavior: string }>(`SELECT limit_cents, breach_behavior FROM budgets WHERE tenant_id = $1`, [T.tenantId]);
    expect(row).toEqual({ limit_cents: 25, breach_behavior: 'halt' });

    const roomy = await as('admin').budgets.set.mutate({ limitCents: 10_000_000, breachBehavior: 'degrade' });
    expect(roomy.state).toBe('ok');
    expect(roomy.breachBehavior).toBe('degrade');
  });

  it('another tenant sees none of this (RLS)', async () => {
    const bOwner = h.as(B.tenantId, B.userId);
    expect((await bOwner.autonomy.list.query()).items.every((r) => r.workflowKey !== agentId)).toBe(true);
    expect((await bOwner.budgets.get.query()).breachBehavior).toBe('queue');
    expect((await bOwner.contention.writeConflicts.query()).items).toEqual([]);
  });
});

