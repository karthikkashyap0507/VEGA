import { randomUUID } from 'node:crypto';
import { canonicalize, digestOf } from '@vega/verifier';
import type { ActionReceipt, PolicyActivatedRecord, ReplayTape, ToolDeclarationRecord, ToolResult } from '@vega/contracts';
import type { Program } from '@vega/dsl';
import { evaluate, MemoryRecorder, RunSuspended, type EntityPort, type ExtractorPort, type ToolInvocation, type ToolPort } from '@vega/interpreter';
import { combine, evaluatePolicies, PRESET_MODES, PRESET_VERSION, presetPolicies, type Match, type Policy, type PolicyInput, type PresetMode } from '@vega/policy-engine';
import { scoreRisk, type RiskInput, type Weights } from '@vega/risk';
import type { EvidenceReader, EvidenceWriter, ReplayRow, StoredChainEntry } from '@vega/db/evidence';
import type { ChainService } from './chain/service.js';
import { ContentRedacted, type ContentStore } from './content.js';

/**
 * DETERMINISTIC REPLAY (module7.md §5.7). Re-runs a recorded decision against the state as it
 * was, from the receipt and the content-addressed store alone:
 *
 *   1  the `action.pre` receipt → its replay tape (program, inputs, every earlier call's result,
 *      extractions, entity lookups, the decision inputs)
 *   2  INTERPRETER, in DRY mode: the program re-executed with every port answered from the tape.
 *      It must reach the same call with the same arguments and the same taint.
 *   3  RISK: the risk function re-scored on the recorded input and weights version.
 *   4  POLICY: the reference evaluator over the policies in force (the preset, by version, and
 *      the tenant bundle from its `policy.activated` entry) → the same matches → the same
 *      combined decision.
 *   5  MODEL: pinned, not re-sampled — reported, never asserted byte-equal (§5.7).
 *
 * The deterministic layers must match EXACTLY; a divergence there is a bug. A layer whose inputs
 * are gone (redacted, or recorded before the tape existed) is `inconclusive`, not a match.
 *
 * ISOLATION (§10 — "worth double-checking in review"). Nothing here can produce a side effect:
 * the only ToolPort is TapeTools, which answers from recorded results and has no route to any
 * connector — the evidence plane holds no connector credential and its network policy has no
 * egress to the execution plane. A program that tries to make a call the tape does not have
 * gets a refusal, and the replay reports it.
 */

export type LayerStatus = 'match' | 'diverged' | 'inconclusive';
export interface LayerResult {
  layer: 'interpreter' | 'risk' | 'policy' | 'model';
  status: LayerStatus;
  deterministic: boolean;
  original: unknown;
  replayed: unknown;
  detail: string;
}

export interface ReplayResult {
  id: string;
  actionId: string;
  entrySeq: number;
  matched: boolean;
  conclusive: boolean;
  layers: LayerResult[];
  originalDigest: string;
  replayDigest: string;
  toolCallsAttempted: number;
  createdAt: string;
}

class TapeExhausted extends Error {}

/** The ONLY tool port replay has. Answers from the tape; executes nothing, ever. */
export class TapeTools implements ToolPort {
  private seq = 0;
  target: ToolInvocation | undefined;
  readonly mismatches: string[] = [];
  /** Calls that reached this port — every one answered from the record. */
  attempted = 0;

  constructor(
    private readonly calls: Array<{ seq: number; tool_id: string; args_digest: string; result: ToolResult<unknown> | null }>,
    private readonly targetSeq: number,
  ) {}

  async invoke(inv: ToolInvocation): Promise<ToolResult<unknown>> {
    this.attempted++;
    const seq = ++this.seq;
    if (seq === this.targetSeq) {
      this.target = inv;
      throw new RunSuspended('held', { nodeId: inv.nodeId, toolId: inv.toolId, reason: 'replay reached the recorded call', argTaint: inv.gate?.argTaint ?? 'TRUSTED' });
    }
    const rec = this.calls.find((c) => c.seq === seq);
    if (!rec || !rec.result) throw new TapeExhausted(`call ${seq} (${inv.toolId}) is not on the tape`);
    const d = digestOf(canonicalize(inv.args));
    if (rec.tool_id !== inv.toolId || rec.args_digest !== d) this.mismatches.push(`call ${seq}: recorded ${rec.tool_id} ${rec.args_digest.slice(0, 19)}…, replayed ${inv.toolId} ${d.slice(0, 19)}…`);
    return rec.result;
  }
}

export class ReplayEngine {
  constructor(
    private readonly deps: {
      reader: EvidenceReader;
      writer: EvidenceWriter;
      content: ContentStore;
      chain: ChainService;
      now?: () => Date;
    },
  ) {}

  /** The newest `action.pre` receipt for an action. */
  async receipt(tenantId: string, actionId: string): Promise<StoredChainEntry | null> {
    const [e] = await this.deps.reader.entries({ tenantId, actionId, kinds: ['action.pre'] }, { limit: 1 });
    return e ?? null;
  }

  async replay(tenantId: string, actionId: string, requestedBy: string, opts: { record?: boolean } = {}): Promise<ReplayResult | null> {
    const entry = await this.receipt(tenantId, actionId);
    if (!entry) return null;
    const receipt = entry.payload as unknown as ActionReceipt;
    const layers: LayerResult[] = [];
    let attempted = 0;

    const tape = receipt.replay_tape_digest ? await this.json<ReplayTape>(tenantId, receipt.replay_tape_digest) : null;
    if (!tape) {
      const why = receipt.replay_tape_digest ? 'the replay tape is not in the content store (redacted or never stored)' : 'this receipt was recorded without a replay tape';
      for (const layer of ['interpreter', 'risk', 'policy'] as const) layers.push({ layer, status: 'inconclusive', deterministic: true, original: null, replayed: null, detail: why });
    } else {
      const interp = await this.interpreter(tenantId, tape);
      attempted = interp.attempted;
      layers.push(interp.layer);
      const risk = await this.risk(tenantId, tape);
      layers.push(risk.layer);
      layers.push(await this.policy(tenantId, entry, tape, risk.score));
    }
    layers.push({
      layer: 'model',
      status: 'match',
      deterministic: false,
      original: { model: receipt.model?.id ?? null, program: receipt.program?.digest ?? null },
      replayed: { model: tape?.program.model_id ?? receipt.model?.id ?? null, program: tape?.program.digest ?? null },
      detail: 'The model is pinned and its output (the program) is replayed from the record, not re-sampled. Model outputs may vary between samples; the deterministic layers carry the audit weight.',
    });

    const det = layers.filter((l) => l.deterministic);
    const conclusive = det.every((l) => l.status !== 'inconclusive');
    const matched = det.every((l) => l.status === 'match');
    const originalDigest = digestOf(canonicalize(det.map((l) => ({ layer: l.layer, value: l.original ?? null }))));
    const replayDigest = digestOf(canonicalize(det.map((l) => ({ layer: l.layer, value: l.replayed ?? null }))));
    const result: ReplayResult = {
      id: randomUUID(),
      actionId,
      entrySeq: entry.seq,
      matched,
      conclusive,
      layers,
      originalDigest,
      replayDigest,
      toolCallsAttempted: attempted,
      createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
    };
    if (opts.record !== false) {
      const divergence = layers.filter((l) => l.status === 'diverged').map((l) => ({ layer: l.layer, detail: l.detail }));
      const row: ReplayRow = { id: result.id, tenantId, actionId, entrySeq: entry.seq, originalDigest, replayDigest, matched, layers, divergence: divergence.length ? divergence : null, requestedBy };
      await this.deps.writer.insertReplay(row);
      await this.deps.chain.append({ tenantId, source: 'evidence', kind: 'replay.recorded', payload: { replayId: result.id, action_id: actionId, entrySeq: entry.seq, matched, conclusive, originalDigest, replayDigest, requestedBy } });
    }
    return result;
  }

  private async json<T>(tenantId: string, digest: string): Promise<T | null> {
    try {
      return await this.deps.content.getJson<T>(tenantId, digest);
    } catch (e) {
      if (e instanceof ContentRedacted) return null;
      throw e;
    }
  }

  // ------------------------------------------------------------------ the interpreter, DRY
  private async interpreter(tenantId: string, tape: ReplayTape): Promise<{ layer: LayerResult; attempted: number }> {
    const original = { tool: tape.target.tool_id, args: tape.target.args_digest, argTaint: tape.target.arg_taint, argTaints: tape.target.arg_taints_digest };
    const inconclusive = (detail: string) => ({ layer: { layer: 'interpreter' as const, status: 'inconclusive' as const, deterministic: true, original, replayed: null, detail }, attempted: 0 });
    const program = await this.json<Program>(tenantId, tape.program.content_digest);
    const decls = await this.json<Array<[string, ToolDeclarationRecord]>>(tenantId, tape.declarations_digest);
    if (!program || !decls) return inconclusive('the program or its tool declarations are no longer in the content store');
    const calls: Array<{ seq: number; tool_id: string; args_digest: string; result: ToolResult<unknown> | null }> = [];
    for (const c of tape.calls) calls.push({ ...c, result: await this.json<ToolResult<unknown>>(tenantId, c.result_digest) });
    if (calls.some((c) => !c.result)) return inconclusive(`a recorded tool result is no longer in the content store (call ${calls.find((c) => !c.result)!.seq})`);

    const extractions = new Map<number, unknown>();
    for (const x of tape.extractions) extractions.set(x.seq, x.value_digest ? await this.json<unknown>(tenantId, x.value_digest) : undefined);
    let xSeq = 0;
    let rSeq = 0;
    const extractor: ExtractorPort = {
      extract: async () => {
        const seq = ++xSeq;
        const rec = tape.extractions.find((x) => x.seq === seq);
        if (!rec) throw new TapeExhausted(`extraction ${seq} is not on the tape`);
        if (rec.error) throw new Error(rec.error);
        return extractions.get(seq);
      },
    };
    const entities: EntityPort = {
      lookup: async (_t, registry, key) => {
        const seq = ++rSeq;
        const rec = tape.lookups.find((l) => l.seq === seq);
        if (!rec || rec.registry !== registry || rec.key !== key) throw new TapeExhausted(`entity lookup ${seq} (${registry}:${key}) is not on the tape`);
        return rec.entity as Awaited<ReturnType<EntityPort['lookup']>>;
      },
    };
    const tools = new TapeTools(calls, tape.target.call_seq);
    const declMap = new Map(decls);
    let error: string | undefined;
    try {
      const res = await evaluate(
        { tools, declarations: { get: async (_t, id) => declMap.get(id) }, extractor, entities, recorder: new MemoryRecorder() },
        program,
        { tenantId: tape.tenant_id, runId: tape.run_id, modelId: tape.program.model_id, mode: 'execute', now: tape.program.now, delegateApproval: true, maxCollection: tape.max_collection, inputs: tape.inputs },
        declMap,
      );
      if (!tools.target) error = res.error ?? res.violation?.detail ?? `the program ended ${res.status}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const t = tools.target;
    const replayed = t
      ? { tool: t.toolId, args: digestOf(canonicalize(t.args)), argTaint: t.gate?.argTaint ?? null, argTaints: digestOf(canonicalize(t.gate?.argTaints ?? [])) }
      : null;
    const diffs: string[] = [...tools.mismatches];
    if (!replayed) diffs.push(`the program did not reach call ${tape.target.call_seq}${error ? ` (${error})` : ''}`);
    else {
      if (replayed.tool !== original.tool) diffs.push(`call ${tape.target.call_seq} is ${replayed.tool}, recorded ${original.tool}`);
      if (replayed.args !== original.args) diffs.push('the arguments differ');
      if (replayed.argTaint !== original.argTaint) diffs.push(`argument taint ${replayed.argTaint}, recorded ${original.argTaint}`);
      if (replayed.argTaints !== original.argTaints) diffs.push('the per-argument taint derivation differs');
    }
    return {
      layer: {
        layer: 'interpreter',
        status: diffs.length ? 'diverged' : 'match',
        deterministic: true,
        original,
        replayed,
        detail: diffs.length ? diffs.join('; ') : `The program reached call ${tape.target.call_seq} (${original.tool}) with the same arguments and taint, after ${tape.calls.length} recorded call${tape.calls.length === 1 ? '' : 's'}.`,
      },
      attempted: tools.attempted,
    };
  }

  // ------------------------------------------------------------------ risk
  private async risk(tenantId: string, tape: ReplayTape): Promise<{ layer: LayerResult; score: ReturnType<typeof scoreRisk> | null }> {
    const d = tape.decision;
    const original = d ? { score: d.recorded.risk_score, tier: d.recorded.risk_tier } : null;
    const input = d?.risk_input_digest ? await this.json<RiskInput>(tenantId, d.risk_input_digest) : null;
    if (!d || !input || !d.weights) return { layer: { layer: 'risk', status: 'inconclusive', deterministic: true, original, replayed: null, detail: 'no recorded risk input for this action' }, score: null };
    const scored = scoreRisk(input, d.weights as unknown as Weights);
    const replayed = { score: scored.score, tier: scored.tier };
    const same = replayed.score === original!.score && replayed.tier === original!.tier;
    return {
      layer: { layer: 'risk', status: same ? 'match' : 'diverged', deterministic: true, original, replayed, detail: same ? `Risk ${scored.score} (${scored.tier}) under weights v${scored.weightsVersion}, as recorded.` : `Risk re-scored ${scored.score} (${scored.tier}); recorded ${original!.score} (${original!.tier}).` },
      score: scored,
    };
  }

  // ------------------------------------------------------------------ policy
  private async policy(tenantId: string, entry: StoredChainEntry, tape: ReplayTape, scored: ReturnType<typeof scoreRisk> | null): Promise<LayerResult> {
    const d = tape.decision;
    const original = d ? { decision: d.recorded.decision, decidedBy: d.recorded.decided_by, matches: d.matches.map((m) => `${m.id}@${m.version}`).sort() } : null;
    const no = (detail: string): LayerResult => ({ layer: 'policy', status: 'inconclusive', deterministic: true, original, replayed: null, detail });
    if (!d || !scored) return no('no recorded policy decision for this action');
    const input = d.policy_input_digest ? await this.json<PolicyInput>(tenantId, d.policy_input_digest) : null;
    if (!input) return no('the recorded policy input is no longer in the content store');
    if (!d.preset || !(PRESET_MODES as readonly string[]).includes(d.preset) || d.preset_version !== PRESET_VERSION) return no(`preset ${d.preset} v${d.preset_version} is not the version this replay engine carries (v${PRESET_VERSION})`);
    const policies: Array<{ policy: Policy; version: number }> = [...presetPolicies(d.preset as PresetMode)];
    if (d.bundle_version) {
      const [act] = (await this.deps.reader.entries({ tenantId, kinds: ['policy.activated'], seqTo: entry.seq }, { limit: 200 })).filter((a) => (a.payload as unknown as PolicyActivatedRecord).version === d.bundle_version);
      if (!act) return no(`the activation of policy bundle v${d.bundle_version} is not in the chain (activated before Module 7?)`);
      for (const p of (act.payload as unknown as PolicyActivatedRecord).policies) {
        const doc = await this.json<Policy>(tenantId, p.document_digest);
        if (!doc) return no(`policy ${p.key}@${p.version} is no longer in the content store`);
        policies.push({ policy: doc, version: p.version });
      }
    }
    const matches: Match[] = evaluatePolicies(policies, input);
    const combined = combine(scored, matches);
    const replayed = { decision: combined.decision, decidedBy: combined.decidedBy.key, matches: matches.map((m) => `${m.id}@${m.version}`).sort() };
    const diffs: string[] = [];
    if (replayed.decision !== original!.decision) diffs.push(`decision ${replayed.decision}, recorded ${original!.decision}`);
    if (replayed.decidedBy !== original!.decidedBy) diffs.push(`decided by ${replayed.decidedBy}, recorded ${original!.decidedBy}`);
    if (replayed.matches.join() !== original!.matches.join()) diffs.push(`matched ${replayed.matches.join(', ') || 'nothing'}, recorded ${original!.matches.join(', ') || 'nothing'}`);
    return {
      layer: 'policy',
      status: diffs.length ? 'diverged' : 'match',
      deterministic: true,
      original,
      replayed,
      detail: diffs.length ? diffs.join('; ') : `${combined.decision}, decided by ${combined.decidedBy.key}; ${matches.length} polic${matches.length === 1 ? 'y' : 'ies'} matched, as recorded.`,
    };
  }
}
