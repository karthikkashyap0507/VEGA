import { schema, withTenant } from '@vega/db';
import type { PlannerInput } from '@vega/contracts';
import type { KnowledgeBase } from '@vega/knowledge';
import type { MemoryStore, Scope } from '@vega/memory';
import type { LoadedRun, RunStore } from '@vega/runs';

/**
 * Module 9 in the control plane: the knowledge base and memory are OWNED here (uploads, the
 * subject's control, ACL previews), and C2 asks this service what the organization already knows
 * before it plans (§6.3, §7.2):
 *
 *   memories   the principal's, the workspace's and the tenant's — relevant to the objective
 *   knowledge  KB passages the PRINCIPAL may open (the OpenFGA gate), TRUSTED/ORG only
 *
 * The retrieval is logged (chunks, memories, how many the ACL withheld) so the decision's trace
 * shows what influenced it, and the passages are pinned on the run's checkpoint: that is the
 * evidence groundedness checks the generated content against in the execution plane — which
 * never needs the ACL graph itself.
 */
export class KnowledgeService {
  constructor(
    readonly kb: KnowledgeBase,
    readonly memory: MemoryStore,
    private readonly runs: RunStore,
    private readonly log: { warn(o: object, m: string): void },
  ) {}

  subjectsFor(p: { tenantId: string; userId: string; workspaceIds: string[] }): Array<{ scope: Scope; subjectId: string }> {
    return [{ scope: 'user', subjectId: p.userId }, ...p.workspaceIds.map((w) => ({ scope: 'workspace' as const, subjectId: w })), { scope: 'tenant', subjectId: p.tenantId }];
  }

  /** PlanningDeps.context: never throws into the planner (planning does not wait on memory). */
  async planningContext(run: LoadedRun): Promise<PlannerInput['context']> {
    const query = run.objective.objective;
    const [memories, knowledge] = await Promise.all([
      this.memory.recall(run.tenantId, this.subjectsFor({ tenantId: run.tenantId, userId: run.principalUserId, workspaceIds: [run.workspaceId] }), query, 8).catch((e) => {
        this.log.warn({ err: e, run_id: run.id }, 'memory unavailable for planning');
        return [];
      }),
      this.kb.search(run.tenantId, { userId: run.principalUserId, query, k: 5, runId: run.id, purpose: 'planning', taints: ['TRUSTED', 'ORG'], log: false }).catch((e) => {
        this.log.warn({ err: e, run_id: run.id }, 'knowledge base unavailable for planning');
        return null;
      }),
    ]);
    // Belt and braces: the planner contract only admits TRUSTED/ORG, and so does this filter.
    const mems = memories.filter((m) => m.taint === 'TRUSTED' || m.taint === 'ORG');
    const hits = (knowledge?.hits ?? []).filter((h) => h.taint === 'TRUSTED' || h.taint === 'ORG');
    await withTenant(run.tenantId, (db) =>
      db.insert(schema.retrievals).values({
        tenantId: run.tenantId,
        runId: run.id,
        purpose: 'planning',
        requestedBy: run.principalUserId,
        query: query.slice(0, 2000),
        chunkIds: hits.map((h) => h.chunkId),
        memoryIds: mems.map((m) => m.id),
        scoresJson: [...hits.map((h) => ({ chunkId: h.chunkId, documentId: h.documentId, score: h.score, dense: h.dense, lexical: h.lexical })), ...mems.map((m) => ({ memoryId: m.id, similarity: m.similarity }))],
        aclFiltered: knowledge?.aclFiltered ?? 0,
        sensitivityFiltered: knowledge?.sensitivityFiltered ?? 0,
      }),
    );
    if (hits.length) {
      await this.runs.updateCheckpoint(run.tenantId, run.id, (cp) => ({ ...cp, knowledge: hits.map((h) => ({ id: `kb:${h.documentId}:${h.chunkId}`, text: `${h.title}\n${h.headingPath.join(' › ')}\n${h.content}`, taint: h.taint as 'TRUSTED' | 'ORG' })) }));
    }
    if (!mems.length && !hits.length) return undefined;
    return {
      memories: mems.map((m) => ({ id: m.id, class: m.class, content: m.content, taint: m.taint, ...(m.needsRevalidation ? { needsRevalidation: true } : {}) })),
      knowledge: hits.map((h) => ({ id: h.chunkId, title: h.title.slice(0, 500), section: h.headingPath.join(' › ').slice(0, 500), content: h.content.slice(0, 4000), taint: h.taint as 'TRUSTED' | 'ORG' })),
    };
  }
}
