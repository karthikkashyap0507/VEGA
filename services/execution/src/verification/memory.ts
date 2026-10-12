import { and, eq } from 'drizzle-orm';
import { schema, withTenant } from '@vega/db';
import { MEMORY_CLASSES, type MemoryClass, type MemoryStore, type Scope } from '@vega/memory';
import type { LoadedRun } from '@vega/runs';

/**
 * C7 — WHAT A FINISHED RUN REMEMBERS (docs/module9.md §6.2).
 *
 *   · what the program explicitly asked to remember: an emitted `{ remember: { class, content } }`.
 *     Its taint is the emit's FULL taint (data and control flow) from the M3 lattice — so a value
 *     that came from, or was chosen because of, an email is UNTRUSTED and the store refuses it.
 *   · task history: what was done (tools and counts) for which objective. Metadata the platform
 *     produced and the principal asked for: TRUSTED — never a tool's content.
 *
 * Memory never fails a run: a refusal is an event, an error is logged.
 */

type Taint = 'TRUSTED' | 'ORG' | 'UNTRUSTED';

export interface RememberRequest {
  class: MemoryClass;
  content: string;
}

/** `{ remember: { class, content } }` (or a list of them) inside an emitted value. */
export function rememberOf(data: unknown): RememberRequest[] {
  const one = (v: unknown): RememberRequest | null => {
    if (!v || typeof v !== 'object') return null;
    const r = v as { class?: unknown; content?: unknown };
    return typeof r.content === 'string' && typeof r.class === 'string' && (MEMORY_CLASSES as readonly string[]).includes(r.class) ? { class: r.class as MemoryClass, content: r.content } : null;
  };
  if (!data || typeof data !== 'object' || !('remember' in data)) return [];
  const r = (data as { remember: unknown }).remember;
  return (Array.isArray(r) ? r : [r]).map(one).filter((x): x is RememberRequest => !!x);
}

export function subjectFor(cls: MemoryClass, run: Pick<LoadedRun, 'tenantId' | 'workspaceId' | 'principalUserId'>): { scope: Scope; subjectId: string } {
  if (cls === 'preference' || cls === 'long_term_style') return { scope: 'user', subjectId: run.principalUserId };
  if (cls === 'org_knowledge') return { scope: 'tenant', subjectId: run.tenantId };
  return { scope: 'workspace', subjectId: run.workspaceId };
}

export class RunMemory {
  constructor(
    private readonly store: MemoryStore,
    private readonly log: { warn(o: object, m: string): void; error(o: object, m: string): void },
  ) {}

  async completed(run: LoadedRun, emits: Array<{ data: unknown; taint: Taint; sourceIds: readonly string[] }>): Promise<{ stored: number; refused: number; conflicts: number }> {
    const out = { stored: 0, refused: 0, conflicts: 0 };
    const tally = (s: string) => (s === 'stored' || s === 'duplicate' ? out.stored++ : s === 'rejected_untrusted' ? out.refused++ : s === 'conflict' ? out.conflicts++ : 0);
    try {
      for (const e of emits) {
        for (const r of rememberOf(e.data)) {
          const s = subjectFor(r.class, run);
          const res = await this.store.propose(run.tenantId, { ...s, class: r.class, content: r.content, sourceTaint: e.taint, provenance: { via: 'run', runId: run.id, sourceIds: [...e.sourceIds] } });
          tally(res.status);
        }
      }
      const done = await withTenant(run.tenantId, (db) => db.select({ toolId: schema.actions.toolId }).from(schema.actions).where(and(eq(schema.actions.runId, run.id), eq(schema.actions.state, 'COMMITTED'))));
      if (done.length) {
        const counts = new Map<string, number>();
        for (const d of done) counts.set(d.toolId, (counts.get(d.toolId) ?? 0) + 1);
        const what = [...counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(', ');
        const content = `Done for "${run.objective.objective.slice(0, 300)}": ${what}`;
        tally((await this.store.propose(run.tenantId, { scope: 'workspace', subjectId: run.workspaceId, class: 'task_history', content, sourceTaint: 'TRUSTED', provenance: { via: 'system', runId: run.id, detail: 'committed actions (metadata only)' } })).status);
      }
    } catch (e) {
      this.log.error({ err: e, run_id: run.id }, 'could not write the run’s memories (the run is unaffected)');
    }
    return out;
  }
}
