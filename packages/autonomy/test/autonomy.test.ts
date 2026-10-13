import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closePools, migrate } from '@vega/db';
import { AutonomyStore, CertificationEngine, DemotionEngine, PromotionEngine, PromotionRefused, ProposalMiner, type CertificationReport, type ToolFacts } from '../src/index.js';
import { addDecision, addMany, OWNER_URL, seedTenant, type Tenant } from './fixtures.js';

// These suites seed real history and share one database with the rest of the workspace's suites;
// under a full parallel run the 5s default is a flake, not a signal.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Module 10A against real Postgres (RLS enforced through withTenant): certification on seeded
 * history, the promotion gate (every condition, positive and negative), automatic demotion on
 * every trigger, and learned-policy mining. §19 "BLOCKING" suites are marked ★.
 */

let pool: pg.Pool;
const store = new AutonomyStore();
const certifier = new CertificationEngine(store);
const promoter = new PromotionEngine(store);
const demoter = new DemotionEngine(store);

const TOOL: ToolFacts = { toolId: 'gmail.send', version: 3, reversibility: 'R2', simulateFidelity: 'DERIVED', recipientArgs: ['to', 'cc'] };
const R1_TOOL: ToolFacts = { ...TOOL, toolId: 'gcal.create', reversibility: 'R1', recipientArgs: ['attendees'] };
const reports: CertificationReport[] = [];
const sign = async (r: CertificationReport) => {
  reports.push(r);
  return { reportRef: `sha256:report-${reports.length}`, signature: `sig-${reports.length}` };
};
const window = () => ({ windowFrom: new Date(Date.now() - 120 * 86_400_000), windowTo: new Date(Date.now() + 60_000) });

beforeAll(async () => {
  await migrate(OWNER_URL);
  pool = new pg.Pool({ connectionString: OWNER_URL, max: 4 });
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await closePools();
});

async function certify(t: Tenant, over: Partial<Parameters<CertificationEngine['certify']>[0]> = {}) {
  return certifier.certify({ tenantId: t.tenantId, workflowKey: t.agentId, actionType: TOOL.toolId, tool: TOOL, sign, ...window(), ...over });
}

describe('★ certification correctness on seeded history (§4)', () => {
  it('scores agreement, edit rate and the error taxonomy from the override corpus', async () => {
    const t = await seedTenant(pool);
    await addMany(pool, t, 170, {}); // approved unedited
    await addMany(pool, t, 22, { edited: true, diff: [{ path: 'body', op: 'changed' }] }); // content edits
    await addMany(pool, t, 5, { decision: 'reject', reason: 'tone was too casual' });
    await addMany(pool, t, 3, { decision: 'reject', reason: 'missing context about the contract' });
    const { report, row } = await certify(t);
    expect(report.sampleSize).toBe(200);
    expect(report.agreementRate).toBeCloseTo(170 / 200, 6);
    expect(report.editRate).toBeCloseTo(22 / 200, 6);
    expect(report.criticalErrors).toBe(0);
    expect(Object.fromEntries(report.errorTaxonomy.map((c) => [c.key, c.count]))).toEqual({ content_edit: 22, tone_mismatch: 5, missing_context: 3 });
    expect(report.errorTaxonomy.find((c) => c.key === 'content_edit')!.examples).toHaveLength(3);
    // persisted with the signature the evidence chain returned
    expect(row).toMatchObject({ sampleSize: 200, recommendation: 'HOLD', reportRef: expect.stringMatching(/^sha256:report-/), signature: expect.stringMatching(/^sig-/) });
    // …and the report names what failed: 85% is below 95%
    expect(report.gate.find((g) => g.name === 'agreement')).toMatchObject({ pass: false });
  });

  it('only decisions of THIS workflow × action inside the window count', async () => {
    const t = await seedTenant(pool);
    const other = (await pool.query<{ id: string }>(`INSERT INTO agents (tenant_id, workspace_id, name, owner_user_id, idp_machine_id, status) VALUES ($1,$2,'other',$3,'m','active') RETURNING id`, [t.tenantId, t.workspaceId, t.userId])).rows[0]!.id;
    await addMany(pool, t, 10, {});
    await addMany(pool, t, 7, { toolId: 'gcal.create' });
    await addMany(pool, t, 4, { agentId: other });
    await addDecision(pool, t, { daysAgo: 300 });
    const { report } = await certify(t);
    expect(report.sampleSize).toBe(10);
  });

  it('a recipient change is CRITICAL-class, and counted as such', async () => {
    const t = await seedTenant(pool);
    await addMany(pool, t, 50, {});
    await addDecision(pool, t, { edited: true, diff: [{ path: 'to[0]', op: 'changed', before: 'a@x.example', after: 'b@y.example' }] });
    const { report } = await certify(t);
    expect(report.criticalErrors).toBe(1);
    expect(report.errorTaxonomy.find((c) => c.key === 'wrong_recipient')).toMatchObject({ critical: true, count: 1 });
    expect(report.recommendation).toBe('DEMOTE');
  });

  it('M3 taint violations, M6 failed compensations and M9 post-commit failures are critical; a pre-commit abort is counted, not critical', async () => {
    const t = await seedTenant(pool);
    const a = await addDecision(pool, t, {});
    await addMany(pool, t, 20, {});
    await pool.query(`INSERT INTO taint_violations (tenant_id, run_id, tool_id, kind, attempted_taint, declared_max, arg_path, program_ref, severity) VALUES ($1,$2,'gmail.send','RECIPIENT','UNTRUSTED','TRUSTED','to[0]','sha256:x','CRITICAL')`, [t.tenantId, a.runId]);
    const b = await addDecision(pool, t, {});
    await pool.query(
      `INSERT INTO compensations (tenant_id, run_id, node_id, connector_id, tool_id, compensator_ref, token_sealed, token_digest, confidence, side_effects, description, ttl_ms, state)
       VALUES ($1,$2,$3,gen_random_uuid(),'gmail.send','x','{}','d','EXACT','SILENT','undo',1000,'failed')`,
      [t.tenantId, b.runId, b.nodeId],
    );
    const c = await addDecision(pool, t, {});
    await pool.query(`INSERT INTO verifications (tenant_id, run_id, node_id, agent_id, tool_id, phase, checks_json, outcome, failed_check) VALUES ($1,$2,$3,$4,'gmail.send','post_commit','[]','COMPENSATE','consequence')`, [t.tenantId, c.runId, c.nodeId, t.agentId]);
    const d = await addDecision(pool, t, {});
    await pool.query(`INSERT INTO verifications (tenant_id, run_id, node_id, agent_id, tool_id, phase, checks_json, outcome, failed_check) VALUES ($1,$2,$3,$4,'gmail.send','pre_commit','[]','ABORT','groundedness')`, [t.tenantId, d.runId, d.nodeId, t.agentId]);
    const { report } = await certify(t);
    expect(report.criticalErrors).toBe(3);
    expect(report.errorTaxonomy.find((c) => c.key === 'verification_abort')).toMatchObject({ critical: false, count: 1 });
    expect(report.errorTaxonomy.filter((c) => c.critical).map((c) => c.key).sort()).toEqual(['compensation_failed', 'post_commit_verification_failure', 'taint_violation']);
  });

  it('pins the connector and model versions it was certified against', async () => {
    const t = await seedTenant(pool);
    await addMany(pool, t, 30, { modelId: 'claude-opus-5' });
    const { row } = await certify(t);
    expect(row.connectorVersions).toEqual({ 'gmail.send': 3 });
    expect(row.modelVersions).toEqual(['claude-opus-5']);
  });
});

/** A tenant with a perfect, long, R1 history — everything the gate wants. */
async function ready(): Promise<Tenant> {
  const t = await seedTenant(pool);
  await addMany(pool, t, 210, { toolId: R1_TOOL.toolId });
  return t;
}
const certifyR1 = (t: Tenant, over: Partial<Parameters<CertificationEngine['certify']>[0]> = {}) => certify(t, { actionType: R1_TOOL.toolId, tool: R1_TOOL, ...over });
const ratify = (t: Tenant, certificationId: string, over: Partial<Parameters<PromotionEngine['ratify']>[0]> = {}) =>
  promoter.ratify({ tenantId: t.tenantId, certificationId, ratifiedBy: t.userId, currentConnectorVersion: R1_TOOL.version, currentSimulateFidelity: 'DERIVED', ...over });

describe('★ the promotion gate: every condition, positive and negative (§4.1)', () => {
  it('all conditions hold → PROMOTE, and a named human ratifies it', async () => {
    const t = await ready();
    const { report, row } = await certifyR1(t);
    expect(report.gate.every((g) => g.pass)).toBe(true);
    expect(report).toMatchObject({ recommendation: 'PROMOTE', recommendedTier: 'SUPERVISED', fromTier: null });
    const { transition, certification } = await ratify(t, row.id);
    expect(transition).toMatchObject({ fromTier: 'SHADOW', toTier: 'SUPERVISED', direction: 'PROMOTE', trigger: 'certification', actorId: t.userId });
    expect(certification).toMatchObject({ decidedBy: t.userId });
    const state = await store.get(t.tenantId, t.agentId, R1_TOOL.toolId);
    expect(state).toMatchObject({ tier: 'SUPERVISED', ratifiedBy: t.userId, certificationId: row.id });
  });

  it('promotion is never automatic: certifying alone changes nothing', async () => {
    const t = await ready();
    await certifyR1(t);
    expect(await store.get(t.tenantId, t.agentId, R1_TOOL.toolId)).toBeNull();
    expect(await store.transitions(t.tenantId, t.agentId)).toEqual([]);
  });

  it('too small a sample → HOLD (and R2/R3 need more than R1)', async () => {
    const t = await seedTenant(pool);
    await addMany(pool, t, 150, {});
    const small = await certify(t);
    expect(small.report.recommendation).toBe('HOLD');
    expect(small.report.gate.find((g) => g.name === 'sample size')).toMatchObject({ pass: false });

    // 250 clean decisions satisfy R1's 200 but not an R2 tool's 400
    const t2 = await seedTenant(pool);
    await addMany(pool, t2, 250, {});
    expect((await certify(t2)).report.gate.find((g) => g.name === 'sample size')).toMatchObject({ pass: false, detail: expect.stringContaining('need 400') });
    expect((await certify(t2, { actionType: 'gmail.send', tool: { ...TOOL, reversibility: 'R1' } })).report.gate.find((g) => g.name === 'sample size')!.pass).toBe(true);
  });

  it('agreement below threshold → HOLD', async () => {
    const t = await seedTenant(pool);
    await addMany(pool, t, 180, { toolId: R1_TOOL.toolId });
    await addMany(pool, t, 25, { toolId: R1_TOOL.toolId, decision: 'reject', reason: 'not right' });
    const { report, row } = await certifyR1(t);
    expect(report.gate.find((g) => g.name === 'agreement')).toMatchObject({ pass: false });
    expect(report.recommendation).toBe('HOLD');
    await expect(ratify(t, row.id)).rejects.toBeInstanceOf(PromotionRefused);
  });

  it('edit rate above 25% → HOLD', async () => {
    const t = await seedTenant(pool);
    await addMany(pool, t, 140, { toolId: R1_TOOL.toolId });
    await addMany(pool, t, 70, { toolId: R1_TOOL.toolId, edited: true, diff: [{ path: 'body', op: 'changed' }] });
    const { report } = await certifyR1(t);
    expect(report.gate.find((g) => g.name === 'edit rate')).toMatchObject({ pass: false });
    expect(report.recommendation).toBe('HOLD');
  });

  it('★ a single critical error, ever → DEMOTE, and ratification is refused', async () => {
    const t = await ready();
    await addDecision(pool, t, { toolId: R1_TOOL.toolId, edited: true, diff: [{ path: 'attendees[0]', op: 'changed' }] });
    const { report, row } = await certifyR1(t);
    expect(report.gate.find((g) => g.name === 'critical errors')).toMatchObject({ pass: false });
    expect(report.recommendation).toBe('DEMOTE');
    await expect(ratify(t, row.id)).rejects.toThrow(/recommends DEMOTE/);
  });

  it('a DECLARED simulation fidelity blocks promotion (M6 §5.6)', async () => {
    const t = await ready();
    const { report } = await certifyR1(t, { tool: { ...R1_TOOL, simulateFidelity: 'DECLARED' } });
    expect(report.gate.find((g) => g.name === 'simulation fidelity is not DECLARED')).toMatchObject({ pass: false });
    expect(report.recommendation).toBe('HOLD');
  });

  it('★ a connector version change since certification invalidates it at ratification', async () => {
    const t = await ready();
    const { row } = await certifyR1(t);
    await expect(ratify(t, row.id, { currentConnectorVersion: R1_TOOL.version + 1 })).rejects.toThrow(/connector changed since certification/);
    expect(await store.get(t.tenantId, t.agentId, R1_TOOL.toolId)).toBeNull();
  });

  it('a version change between two certifications fails the next gate', async () => {
    const t = await ready();
    await certifyR1(t);
    const { report } = await certifyR1(t, { tool: { ...R1_TOOL, version: R1_TOOL.version + 1 } });
    expect(report.gate.find((g) => g.name === 'connector version unchanged')).toMatchObject({ pass: false });
    expect(report.recommendation).toBe('HOLD');
  });

  it('a new model in the window fails the model-version gate', async () => {
    const t = await seedTenant(pool);
    await addMany(pool, t, 210, { toolId: R1_TOOL.toolId, modelId: 'claude-opus-5' });
    await certifyR1(t);
    await addMany(pool, t, 5, { toolId: R1_TOOL.toolId, modelId: 'claude-sonnet-5' });
    const { report } = await certifyR1(t);
    expect(report.gate.find((g) => g.name === 'model versions unchanged')).toMatchObject({ pass: false });
  });

  it('a certification can be acted on once, and only one rung at a time', async () => {
    const t = await ready();
    const { row } = await certifyR1(t);
    await ratify(t, row.id);
    await expect(ratify(t, row.id)).rejects.toThrow(/already acted on/);
  });

  it('the pair keeps climbing only through fresh certifications: SHADOW → SUPERVISED → SAMPLED', async () => {
    const t = await ready();
    await ratify(t, (await certifyR1(t)).row.id);
    const second = await certifyR1(t);
    expect(second.report).toMatchObject({ fromTier: 'SUPERVISED', recommendation: 'PROMOTE', recommendedTier: 'SAMPLED' });
    const { transition } = await ratify(t, second.row.id, { sampleRate: 5 });
    expect(transition).toMatchObject({ fromTier: 'SUPERVISED', toTier: 'SAMPLED' });
    expect(await store.get(t.tenantId, t.agentId, R1_TOOL.toolId)).toMatchObject({ tier: 'SAMPLED', sampleRate: 5 });
  });
});

describe('★ automatic demotion on every trigger (§6)', () => {
  const TRIGGERS = [
    ['critical_error', 'SUSPENDED'],
    ['comp_failure', 'SUSPENDED'],
    ['taint_violation', 'SUSPENDED'],
    ['error_rate', 'SUPERVISED'],
    ['version_change', 'SUPERVISED'],
    ['volume_spike', 'SUPERVISED'],
  ] as const;

  async function atAutonomous(): Promise<Tenant> {
    const t = await seedTenant(pool);
    await store.transition({ tenantId: t.tenantId, workflowKey: t.agentId, actionType: 'gmail.send', fromTier: 'SAMPLED', toTier: 'AUTONOMOUS', direction: 'PROMOTE', trigger: 'certification', evidence: {}, actorId: t.userId });
    return t;
  }

  for (const [trigger, to] of TRIGGERS) {
    it(`${trigger} → ${to}, instantly, with the evidence recorded and no actor`, async () => {
      const t = await atAutonomous();
      const r = await demoter.demote(t.tenantId, t.agentId, 'gmail.send', trigger, { detail: `because ${trigger}` });
      expect(r).toMatchObject({ demoted: true, from: 'AUTONOMOUS', to });
      expect(await store.get(t.tenantId, t.agentId, 'gmail.send')).toMatchObject({ tier: to, ratifiedBy: null });
      const [last] = await store.transitions(t.tenantId, t.agentId, 'gmail.send');
      expect(last).toMatchObject({ direction: 'DEMOTE', trigger, toTier: to, actorId: null, evidenceJson: { detail: `because ${trigger}` } });
    });
  }

  it('a softer trigger never loosens an already-stricter tier', async () => {
    const t = await atAutonomous();
    await demoter.demote(t.tenantId, t.agentId, 'gmail.send', 'critical_error', {});
    const r = await demoter.demote(t.tenantId, t.agentId, 'gmail.send', 'volume_spike', {});
    expect(r).toMatchObject({ demoted: false, from: 'SUSPENDED' });
    expect((await store.get(t.tenantId, t.agentId, 'gmail.send'))!.tier).toBe('SUSPENDED');
  });

  it('★ there is no restore path: only a fresh certification and a ratifier raise it again', async () => {
    const t = await seedTenant(pool);
    await addMany(pool, t, 210, { toolId: R1_TOOL.toolId });
    await store.transition({ tenantId: t.tenantId, workflowKey: t.agentId, actionType: R1_TOOL.toolId, fromTier: 'SAMPLED', toTier: 'AUTONOMOUS', direction: 'PROMOTE', trigger: 'certification', evidence: {}, actorId: t.userId });
    await demoter.demote(t.tenantId, t.agentId, R1_TOOL.toolId, 'taint_violation', {});
    // an OLD certification (made before the demotion) cannot be used to climb back
    const stale = (await pool.query(`INSERT INTO certifications (tenant_id, workflow_key, action_type, window_from, window_to, sample_size, agreement_rate, edit_rate, critical_errors, error_taxonomy, connector_versions, model_versions, from_tier, recommendation, recommended_tier, report_ref, signature, created_at)
       VALUES ($1,$2,$3, now() - interval '90 days', now() - interval '10 days', 300, 0.99, 0.01, 0, '[]', $4, '[]', 'SUSPENDED', 'PROMOTE', 'SHADOW', 'sha256:old', 'sig', now() - interval '5 days') RETURNING id`, [t.tenantId, t.agentId, R1_TOOL.toolId, JSON.stringify({ [R1_TOOL.toolId]: R1_TOOL.version })])).rows[0].id;
    await expect(ratify(t, stale)).rejects.toThrow(PromotionRefused);
    expect((await store.get(t.tenantId, t.agentId, R1_TOOL.toolId))!.tier).toBe('SUSPENDED');
    // a manual "demotion" cannot raise a tier either
    await expect(promoter.manualDemote({ tenantId: t.tenantId, workflowKey: t.agentId, actionType: R1_TOOL.toolId, to: 'AUTONOMOUS', by: t.userId, reason: 'restore' })).rejects.toBeInstanceOf(PromotionRefused);
    await expect(promoter.manualDemote({ tenantId: t.tenantId, workflowKey: t.agentId, actionType: R1_TOOL.toolId, to: 'SUPERVISED', by: t.userId, reason: 'restore' })).rejects.toBeInstanceOf(PromotionRefused);
  });

  it('a manual demotion is always allowed and always recorded with who and why', async () => {
    const t = await atAutonomous();
    const tr = await promoter.manualDemote({ tenantId: t.tenantId, workflowKey: t.agentId, actionType: 'gmail.send', to: 'SUPERVISED', by: t.userId, reason: 'client escalation' });
    expect(tr).toMatchObject({ trigger: 'manual', actorId: t.userId, evidenceJson: { reason: 'client escalation' }, toTier: 'SUPERVISED' });
  });

  it('tiers are independent per workflow × action type (§2)', async () => {
    const t = await seedTenant(pool);
    await store.transition({ tenantId: t.tenantId, workflowKey: t.agentId, actionType: 'gcal.create', fromTier: 'SAMPLED', toTier: 'AUTONOMOUS', direction: 'PROMOTE', trigger: 'certification', evidence: {} });
    await store.transition({ tenantId: t.tenantId, workflowKey: t.agentId, actionType: 'gmail.send', fromTier: 'SHADOW', toTier: 'SUPERVISED', direction: 'PROMOTE', trigger: 'certification', evidence: {} });
    await demoter.demote(t.tenantId, t.agentId, 'gmail.send', 'critical_error', {});
    expect((await store.get(t.tenantId, t.agentId, 'gcal.create'))!.tier).toBe('AUTONOMOUS');
    expect((await store.get(t.tenantId, t.agentId, 'gmail.send'))!.tier).toBe('SUSPENDED');
  });
});

describe('learned policy from the override corpus (§5)', () => {
  it('"you approved 47 of 47" → a promote proposal that cites every decision and never applies itself', async () => {
    const t = await seedTenant(pool);
    const ids: string[] = [];
    for (let i = 0; i < 47; i++) ids.push((await addDecision(pool, t, { daysAgo: 2 + (i % 30), latencyMs: 6000 })).decisionId);
    const made = await new ProposalMiner(store).generate(t.tenantId);
    const promote = made.find((p) => p.kind === 'promote')!;
    expect(promote).toBeDefined();
    expect(promote.state).toBe('open');
    expect((promote.evidenceJson as { decisions: number; edits: number; rejections: number; medianLatencyMs: number; decisionIds: string[] })).toMatchObject({ decisions: 47, edits: 0, rejections: 0, medianLatencyMs: 6000 });
    expect((promote.evidenceJson as { decisionIds: string[] }).decisionIds.sort()).toEqual([...ids].sort());
    // nothing changed: proposals are read-only artifacts
    expect(await store.get(t.tenantId, t.agentId, 'gmail.send')).toBeNull();
  });

  it('one rejection or edit in the run means no promote proposal', async () => {
    const t = await seedTenant(pool);
    await addMany(pool, t, 45, {});
    await addDecision(pool, t, { decision: 'reject', reason: 'no' });
    expect((await new ProposalMiner(store).generate(t.tenantId)).filter((p) => p.kind === 'promote')).toEqual([]);
  });

  it('3 of the last 10 edited → a demote proposal citing the edits', async () => {
    const t = await seedTenant(pool);
    await addMany(pool, t, 7, { daysAgo: 20 });
    for (let i = 0; i < 3; i++) await addDecision(pool, t, { daysAgo: 1 + i * 0.1, edited: true, diff: [{ path: 'body', op: 'changed' }] });
    const made = await new ProposalMiner(store).generate(t.tenantId, { promoteMin: 999 });
    const demote = made.find((p) => p.kind === 'demote')!;
    expect(demote).toBeDefined();
    expect(demote.evidenceJson).toMatchObject({ recent: 10, edits: 3 });
    expect(demote.proposedChange).toMatchObject({ action: 'set_tier', tier: 'SUPERVISED' });
  });

  it('three approvers adding the same disclaimer is ONE missing policy — grouped by structure, not text', async () => {
    const t = await seedTenant(pool);
    await addDecision(pool, t, { edited: true, diff: [{ path: 'attachments[0]', op: 'added', after: 'disclaimer-v1.pdf' }] });
    await addDecision(pool, t, { edited: true, diff: [{ path: 'attachments[1]', op: 'added', after: 'terms.pdf' }] });
    await addDecision(pool, t, { edited: true, diff: [{ path: 'attachments[0]', op: 'added', after: 'Disclaimer.PDF' }] });
    await addDecision(pool, t, { edited: true, diff: [{ path: 'subject', op: 'changed' }] });
    const made = await new ProposalMiner(store).generate(t.tenantId, { promoteMin: 999, recentEditsMin: 99 });
    const policy = made.filter((p) => p.kind === 'new_policy');
    expect(policy).toHaveLength(1);
    expect(policy[0]!.proposedChange).toMatchObject({ field: 'attachments[]', structuralChange: 'added' });
    expect((policy[0]!.evidenceJson as { edits: number }).edits).toBe(3);
  });

  it('dismissals are training signal: a class dismissed three times stops being generated', async () => {
    const t = await seedTenant(pool);
    await addMany(pool, t, 40, {});
    const miner = new ProposalMiner(store);
    for (let i = 0; i < 3; i++) {
      const [p] = (await miner.generate(t.tenantId)).filter((x) => x.kind === 'promote');
      expect(p).toBeDefined();
      await miner.decide(t.tenantId, p!.id, 'dismissed', t.userId);
    }
    expect((await miner.generate(t.tenantId)).filter((x) => x.kind === 'promote')).toEqual([]);
  });

  it('an open proposal is not generated twice; deciding it is once-only', async () => {
    const t = await seedTenant(pool);
    await addMany(pool, t, 40, {});
    const miner = new ProposalMiner(store);
    const first = await miner.generate(t.tenantId);
    expect(first.length).toBeGreaterThan(0);
    expect(await miner.generate(t.tenantId)).toEqual([]);
    expect(await miner.decide(t.tenantId, first[0]!.id, 'accepted', t.userId)).toMatchObject({ state: 'accepted', decidedBy: t.userId });
    expect(await miner.decide(t.tenantId, first[0]!.id, 'dismissed', t.userId)).toBeNull();
  });

  it('proposals expire; stale evidence produces nothing', async () => {
    const t = await seedTenant(pool);
    await addMany(pool, t, 40, { daysAgo: 100 }); // older than the 90-day window
    const miner = new ProposalMiner(store);
    expect(await miner.generate(t.tenantId)).toEqual([]);
    await addMany(pool, t, 40, {});
    const [p] = await miner.generate(t.tenantId);
    expect(await new ProposalMiner(store, () => new Date(Date.now() + 31 * 86_400_000)).expire(t.tenantId)).toBe(1);
    expect((await store.proposals(t.tenantId, 'expired')).map((x) => x.id)).toContain(p!.id);
  });
});
