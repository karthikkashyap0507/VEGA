import { canonicalize, digestOf } from '@vega/verifier';
import { RECEIPT_VERSION, TAPE_VERSION, type ActionReceipt, type ReplayTape } from '@vega/contracts';
import type { Receipt, StepContext } from '@vega/orchestration';
import type { ContentObject } from './evidence-append.js';
import type { ProgramReceipt } from './executor/pass.js';

/**
 * THE RECEIPT (docs/module7.md §5.1), built in the execution plane from what the executor knows
 * at the call. The chain commits to DIGESTS; the bytes travel beside the entry, once, to the
 * evidence plane's content-addressed store — where replay finds them and redaction can erase
 * them without touching the chain (§5.5).
 *
 * One digest rule, everywhere: "sha256:" + hex(SHA-256(bytes)), and JSON is stored as its
 * RFC 8785 (JCS) bytes — so anyone holding the content can recompute the digest a receipt names.
 */

export class ContentBag {
  readonly objects = new Map<string, ContentObject>();

  /** JSON, canonicalized. Returns the digest the receipt commits to. */
  json(value: unknown, sensitivity: 'body' | 'metadata' = 'body'): string {
    let text: string;
    try {
      text = canonicalize(value ?? null);
    } catch {
      // Not representable in JCS (a non-finite number): keep what JSON keeps, digest those bytes.
      text = JSON.stringify(value ?? null);
    }
    const bytes = Buffer.from(text, 'utf8');
    const d = digestOf(bytes);
    if (!this.objects.has(d)) this.objects.set(d, { digest: d, data: bytes.toString('base64'), mediaType: 'application/json', sensitivity });
    return d;
  }

  text(value: string, sensitivity: 'body' | 'metadata' = 'body'): string {
    const bytes = Buffer.from(value, 'utf8');
    const d = digestOf(bytes);
    if (!this.objects.has(d)) this.objects.set(d, { digest: d, data: bytes.toString('base64'), mediaType: 'text/plain; charset=utf-8', sensitivity });
    return d;
  }

  list(): ContentObject[] {
    return [...this.objects.values()];
  }
}

const OUTCOME = { committed: 'COMMITTED', failed: 'FAILED', unknown: 'UNKNOWN' } as const;

/**
 * The people an action is ABOUT — the "data subject" facet (lower-cased addresses and their
 * domains). Wider than `recipientArgs` (who an effect reaches, for taint): a draft to a client
 * reaches no one yet, but "everything about this client" must still find it.
 */
const ADDRESSING = ['to', 'cc', 'bcc', 'attendees', 'email', 'recipients', 'patch.attendees'];
function subjectsOf(ctx: StepContext): string[] {
  const out = new Set<string>();
  const take = (v: unknown) => {
    if (typeof v === 'string' && v.includes('@')) {
      const s = v.trim().toLowerCase();
      out.add(s);
      out.add(`@${s.split('@').pop()}`);
    } else if (Array.isArray(v)) v.forEach(take);
    else if (v && typeof v === 'object') Object.values(v).forEach(take);
  };
  for (const path of new Set([...ctx.tool.recipientArgs, ...ADDRESSING])) take(path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k.replace(/\[\]$/, '')] : undefined), ctx.args));
  return [...out].sort().slice(0, 50);
}

export function actionReceipt(ctx: StepContext, r: Receipt): { payload: ActionReceipt; content: ContentBag } {
  const bag = new ContentBag();
  const rec = r.record ?? {};
  const policy = rec.policy;
  const inputs = policy?.inputs;
  const sources = new Map<string, string>();
  for (const a of ctx.argTaints) for (const s of a.sourceIds) if (!sources.has(s)) sources.set(s, a.dataTaint);

  const payload: ActionReceipt = {
    receipt_version: RECEIPT_VERSION,
    phase: r.phase,
    action_id: ctx.nodeRowId,
    run_id: ctx.runId,
    actor: { principal: ctx.principalUserId, on_behalf_of: ctx.principalUserId, agent: ctx.agentId, agent_version: ctx.agentVersion, agent_identity: null },
    tool: { id: ctx.toolId, connector: ctx.tool.connectorKind, egress: ctx.tool.egressClass, reversibility: ctx.tool.reversibility, idempotency: ctx.tool.idempotency, decl_version: ctx.tool.version },
    connector_id: ctx.connectorId,
    arguments_digest: bag.json(ctx.args),
    arg_taint: ctx.argTaint,
    inputs_read: [...sources].map(([source, taint]) => ({ source, taint })).sort((a, b) => a.source.localeCompare(b.source)),
    program: { version: ctx.programVersion, digest: rec.program?.digest ?? null, call_seq: ctx.callSeq, node_id: ctx.nodeId },
    model: { id: rec.program?.modelId ?? null, prompt_version: null },
    policies_evaluated: (policy?.chain ?? []).filter((s) => s.step === 'policy').map((s) => ({ id: s.id ?? '(unnamed)', version: s.version ?? null, decision: policy?.decision ?? 'ALLOW', citation: s.citation ?? null })),
    policy: policy
      ? {
          decision: policy.decision,
          evaluation_id: policy.evaluationId ?? null,
          decided_by: inputs?.decidedBy ?? null,
          reason: policy.reason ?? null,
          fail_closed: policy.failClosed ?? false,
          preset: inputs?.preset ?? null,
          preset_version: inputs?.presetVersion ?? null,
          bundle_version: inputs?.bundleVersion ?? null,
          bundle_revision: inputs?.bundleRevision ?? null,
          input_digest: inputs?.policy ? bag.json(inputs.policy, 'metadata') : null,
        }
      : null,
    risk: policy ? { score: policy.riskScore ?? null, tier: policy.riskTier ?? null, weights_version: (inputs?.weights?.['version'] as number | undefined) ?? null, input_digest: inputs?.risk ? bag.json(inputs.risk, 'metadata') : null, ...(inputs?.factors ? { factors: inputs.factors } : {}) } : null,
    approval: rec.approval ? { required: rec.approval.required, granted: rec.approval.granted, approver_role: rec.approval.approverRole, by: rec.approval.by, evidence_digest: rec.approval.evidenceDigest ?? null, ...(rec.approval.requestId ? { request_id: rec.approval.requestId } : {}) } : null,
    hold: rec.hold ? { window_ms: rec.hold.windowMs, released: rec.hold.released, revoked: rec.hold.revoked } : null,
    subjects: subjectsOf(ctx),
  };
  if (rec.programArgs) (payload as ActionReceipt & { program_arguments_digest?: string }).program_arguments_digest = bag.json(rec.programArgs);

  if (r.phase === 'pre' && rec.tape) payload.replay_tape_digest = bag.json(replayTape(ctx, rec, bag), 'body');
  if (r.phase === 'post') {
    payload.outcome = r.outcome ? OUTCOME[r.outcome] : undefined;
    payload.effect_digest = rec.result !== undefined ? bag.json(rec.result) : null;
    const effect = r.effect as { summary?: string } | undefined;
    payload.effect_summary = effect?.summary ?? null;
    payload.error = r.error ?? null;
  }
  return { payload, content: bag };
}

function replayTape(ctx: StepContext, rec: NonNullable<Receipt['record']>, bag: ContentBag): ReplayTape {
  const t = rec.tape!;
  const inputs = rec.policy?.inputs;
  const programArgs = rec.programArgs ?? ctx.args;
  return {
    tape_version: TAPE_VERSION,
    tenant_id: ctx.tenantId,
    run_id: ctx.runId,
    program: { version: t.program.version, digest: t.program.digest, content_digest: bag.json(t.program.ast), model_id: t.program.modelId, now: t.program.now },
    inputs: t.inputs,
    max_collection: t.maxCollection,
    declarations_digest: bag.json(t.declarations, 'metadata'),
    calls: t.calls.map((c) => ({ seq: c.seq, tool_id: c.toolId, args_digest: digestOf(canonicalize(c.args)), result_digest: bag.json(c.result) })),
    extractions: t.extractions.map((x) => ({ seq: x.seq, schema: x.schema, value_digest: x.error ? null : bag.json(x.value ?? null), ...(x.error ? { error: x.error } : {}) })),
    lookups: t.lookups.map((l) => ({ seq: l.seq, registry: l.registry, key: l.key, entity: l.entity })),
    target: { call_seq: ctx.callSeq, tool_id: ctx.toolId, args_digest: digestOf(canonicalize(programArgs)), arg_taint: ctx.argTaint, arg_taints_digest: digestOf(canonicalize(ctx.argTaints)) },
    decision:
      inputs && rec.policy && !rec.policy.failClosed
        ? {
            risk_input_digest: inputs.risk ? bag.json(inputs.risk, 'metadata') : null,
            weights: inputs.weights,
            policy_input_digest: inputs.policy ? bag.json(inputs.policy, 'metadata') : null,
            preset: inputs.preset,
            preset_version: inputs.presetVersion,
            bundle_version: inputs.bundleVersion,
            matches: inputs.matches,
            // The ENGINE's decision (before the M3 gate is folded in): what risk + policy replay re-derives.
            recorded: { decision: rec.engineDecision ?? rec.policy.decision, decided_by: inputs.decidedBy, risk_score: rec.policy.riskScore ?? null, risk_tier: rec.policy.riskTier ?? null },
          }
        : null,
  };
}

/** `run.program` (docs/module7.md §5.9 "why"): the plan a run executed, digests only in the entry. */
export function programEntry(p: ProgramReceipt): { payload: Record<string, unknown>; content: ContentBag } {
  const bag = new ContentBag();
  return {
    payload: {
      run_id: p.runId,
      program: { version: p.version, digest: p.programDigest, content_digest: bag.json(p.program) },
      model: { id: p.modelId, prompt_version: null },
      objective_digest: bag.text(p.objective),
      trigger: p.trigger,
      actor: { principal: p.principalUserId, agent: p.agentId, agent_version: p.agentVersion },
    },
    content: bag,
  };
}
