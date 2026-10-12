import { entryHash, entryMessage, keyCovers, payloadDigest, verifySignature, type PublicKeyRecord } from '@vega/verifier';
import type { ActionReceipt } from '@vega/contracts';
import type { EvidenceReader, StoredChainEntry } from '@vega/db/evidence';
import { ContentRedacted, type ContentStore } from './content.js';

/**
 * C8 — EXPLAINABILITY (module7.md §5.9, §6.2). The human-readable view of a run, built from the
 * SAME chain entries an evidence pack carries — never a second source of truth. Each of the six
 * questions is answered from receipts:
 *
 *   What did it do            action.post (committed) with effect summaries
 *   Why                       run.program (objective, plan version, pinned model) + per-step policy reasons
 *   Which tools               every call, arguments by digest (bodies only for `audit.read_bodies`)
 *   What influenced it        inputs_read: sources with their taint (the M3 provenance)
 *   Which policies applied    each decision, what decided it, the policies evaluated, the risk
 *   Was approval required     the approval block: required, granted, by whom, what they saw
 *
 * The machine-readable export is this plus the entries themselves (hashes, signatures), so the
 * trace can be checked against the chain it was read from.
 */

export interface RunTrace {
  runId: string;
  entryCount: number;
  integrity: { ok: boolean; checked: number; failures: number[] };
  window: { from: string | null; to: string | null };
  what: Array<{ actionId: string; tool: string; outcome: string; summary: string | null; at: string; seq: number }>;
  why: {
    objective: string | null;
    programs: Array<{ version: number; digest: string | null; model: string | null; promptVersion: string | null; at: string; seq: number }>;
    steps: Array<{ actionId: string; tool: string; reason: string | null; decision: string | null; seq: number }>;
  };
  tools: Array<{
    actionId: string;
    callSeq: number;
    tool: string;
    egress: string;
    reversibility: string;
    connectorId: string | null;
    argumentsDigest: string;
    arguments: unknown;
    argTaint: string;
    outcome: string | null;
    effectDigest: string | null;
    effect: unknown;
    error: string | null;
    at: string;
    seq: number;
  }>;
  influences: Array<{ source: string; taint: string; actions: string[] }>;
  policies: Array<{
    actionId: string;
    tool: string;
    decision: string | null;
    decidedBy: string | null;
    reason: string | null;
    failClosed: boolean;
    evaluated: ActionReceipt['policies_evaluated'];
    risk: { score: number | null; tier: string | null; weightsVersion: number | null } | null;
    bundleVersion: number | null;
    seq: number;
  }>;
  approvals: Array<{ actionId: string; tool: string; required: boolean; granted: boolean; approverRole: string | null; by: string[]; evidenceDigest: string | null; hold: ActionReceipt['hold']; seq: number }>;
  compensations: Array<{ kind: string; tool: string | null; summary: string | null; at: string; seq: number }>;
  timeline: Array<{ seq: number; ts: string; kind: string; actionId: string | null; tool: string | null; summary: string }>;
}

const receipt = (e: StoredChainEntry) => e.payload as unknown as ActionReceipt;

export class TraceBuilder {
  constructor(
    private readonly deps: {
      reader: EvidenceReader;
      content: ContentStore;
      keys: () => Promise<PublicKeyRecord[]>;
    },
  ) {}

  async entries(tenantId: string, runId: string): Promise<StoredChainEntry[]> {
    const out: StoredChainEntry[] = [];
    for await (const b of this.deps.reader.scan({ tenantId, runId })) out.push(...b);
    return out;
  }

  private async body(tenantId: string, digest: string | null | undefined, allowed: boolean): Promise<unknown> {
    if (!digest) return null;
    if (!allowed) return { redacted: 'requires audit.read_bodies', digest };
    try {
      const b = await this.deps.content.get(tenantId, digest);
      if (!b) return { missing: true, digest };
      const text = b.toString('utf8');
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (e) {
      if (e instanceof ContentRedacted) return { redacted: `erased at ${e.redaction.redactedAt} under ${e.redaction.requestId}`, digest };
      throw e;
    }
  }

  async build(tenantId: string, runId: string, opts: { bodies: boolean }): Promise<RunTrace | null> {
    const entries = await this.entries(tenantId, runId);
    if (!entries.length) return null;
    const keys = new Map((await this.deps.keys()).map((k) => [k.keyId, k]));
    const failures: number[] = [];
    for (const e of entries) {
      const k = keys.get(e.keyId);
      const ok = payloadDigest(e.payload) === e.payloadDigest && entryHash(e, e.prevHash, tenantId, e.seq) === e.entryHash && !!k && keyCovers(k, e.ts) && verifySignature(e.signature, entryMessage(e.entryHash), k);
      if (!ok) failures.push(e.seq);
    }

    const t: RunTrace = {
      runId,
      entryCount: entries.length,
      integrity: { ok: failures.length === 0, checked: entries.length, failures },
      window: { from: entries[0]!.ts, to: entries.at(-1)!.ts },
      what: [],
      why: { objective: null, programs: [], steps: [] },
      tools: [],
      influences: [],
      policies: [],
      approvals: [],
      compensations: [],
      timeline: [],
    };
    const posts = new Map<string, StoredChainEntry>();
    for (const e of entries) if (e.kind === 'action.post') posts.set(receipt(e).action_id, e);
    const influences = new Map<string, { source: string; taint: string; actions: Set<string> }>();

    for (const e of entries) {
      const p = e.payload as Record<string, unknown>;
      if (e.kind === 'run.program') {
        const prog = p['program'] as { version: number; digest: string } | undefined;
        const model = p['model'] as { id?: string; prompt_version?: string } | undefined;
        if (!t.why.objective && typeof p['objective_digest'] === 'string') {
          const obj = await this.body(tenantId, p['objective_digest'], opts.bodies);
          t.why.objective = typeof obj === 'string' ? obj : JSON.stringify(obj);
        }
        t.why.programs.push({ version: prog?.version ?? 0, digest: prog?.digest ?? null, model: model?.id ?? null, promptVersion: model?.prompt_version ?? null, at: e.ts, seq: e.seq });
        t.timeline.push({ seq: e.seq, ts: e.ts, kind: e.kind, actionId: null, tool: null, summary: `Plan v${prog?.version ?? '?'} started${model?.id ? ` (${model.id})` : ''}` });
        continue;
      }
      if (e.kind === 'action.pre') {
        const r = receipt(e);
        const post = posts.get(r.action_id);
        const pr = post ? receipt(post) : undefined;
        t.tools.push({
          actionId: r.action_id,
          callSeq: r.program?.call_seq ?? 0,
          tool: r.tool.id,
          egress: r.tool.egress,
          reversibility: r.tool.reversibility,
          connectorId: r.connector_id,
          argumentsDigest: r.arguments_digest,
          arguments: await this.body(tenantId, r.arguments_digest, opts.bodies),
          argTaint: r.arg_taint,
          outcome: pr?.outcome ?? null,
          effectDigest: pr?.effect_digest ?? null,
          effect: pr?.effect_digest ? await this.body(tenantId, pr.effect_digest, opts.bodies) : null,
          error: pr?.error ?? null,
          at: e.ts,
          seq: e.seq,
        });
        t.why.steps.push({ actionId: r.action_id, tool: r.tool.id, reason: r.policy?.reason ?? null, decision: r.policy?.decision ?? null, seq: e.seq });
        t.policies.push({
          actionId: r.action_id,
          tool: r.tool.id,
          decision: r.policy?.decision ?? null,
          decidedBy: r.policy?.decided_by ?? null,
          reason: r.policy?.reason ?? null,
          failClosed: r.policy?.fail_closed ?? false,
          evaluated: r.policies_evaluated ?? [],
          risk: r.risk ? { score: r.risk.score, tier: r.risk.tier, weightsVersion: r.risk.weights_version } : null,
          bundleVersion: r.policy?.bundle_version ?? null,
          seq: e.seq,
        });
        if (r.approval || r.hold) {
          t.approvals.push({ actionId: r.action_id, tool: r.tool.id, required: r.approval?.required ?? false, granted: r.approval?.granted ?? false, approverRole: r.approval?.approver_role ?? null, by: r.approval?.by ?? [], evidenceDigest: r.approval?.evidence_digest ?? null, hold: r.hold, seq: e.seq });
        }
        for (const i of r.inputs_read ?? []) {
          const k = `${i.source}|${i.taint}`;
          const v = influences.get(k) ?? { source: i.source, taint: i.taint, actions: new Set<string>() };
          v.actions.add(r.action_id);
          influences.set(k, v);
        }
        t.timeline.push({ seq: e.seq, ts: e.ts, kind: e.kind, actionId: r.action_id, tool: r.tool.id, summary: `About to call ${r.tool.id} — ${r.policy?.decision ?? 'no policy decision recorded'}${r.risk?.tier ? `, risk ${r.risk.tier}` : ''}` });
        continue;
      }
      if (e.kind === 'action.post') {
        const r = receipt(e);
        if (r.outcome === 'COMMITTED' && r.tool.reversibility !== 'R0') t.what.push({ actionId: r.action_id, tool: r.tool.id, outcome: r.outcome, summary: r.effect_summary ?? null, at: e.ts, seq: e.seq });
        t.timeline.push({ seq: e.seq, ts: e.ts, kind: e.kind, actionId: r.action_id, tool: r.tool.id, summary: `${r.tool.id}: ${r.outcome ?? 'recorded'}${r.effect_summary ? ` — ${r.effect_summary}` : r.error ? ` (${r.error})` : ''}` });
        continue;
      }
      if (e.kind.startsWith('compensation.')) {
        t.compensations.push({ kind: e.kind, tool: (p['toolId'] as string) ?? null, summary: (p['summary'] as string) ?? (p['error'] ? JSON.stringify(p['error']) : null), at: e.ts, seq: e.seq });
      }
      t.timeline.push({ seq: e.seq, ts: e.ts, kind: e.kind, actionId: e.facets.actionId, tool: e.facets.toolId, summary: e.kind });
    }
    t.influences = [...influences.values()].map((v) => ({ source: v.source, taint: v.taint, actions: [...v.actions] }));
    return t;
  }
}
