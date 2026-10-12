import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { schema, withTenant } from '@vega/db';
import type { Embedder } from '@vega/knowledge';

/**
 * MEMORY — docs/module9.md §6. The rule that makes it safe (§1.2, threat T2):
 *
 *   MEMORY MAY BE WRITTEN ONLY FROM TRUSTED OR ORG SOURCES.
 *
 * One email from an attacker must never become a "preference" that persists across every future
 * session. Three layers hold the rule: the M3 taint lattice decides a value's taint (a run's
 * `emit` carries it); this store refuses UNTRUSTED before anything is embedded or stored; and the
 * database's `memory_taint_gate` CHECK refuses it regardless.
 *
 * Never silently overwrite (§6.2): a proposal about the same thing as an active memory, saying
 * something different, opens a conflict for the subject to resolve — with both provenance chains.
 * A user's edit is never overwritten by the system.
 */

export const MEMORY_CLASSES = ['preference', 'working_context', 'task_history', 'org_knowledge', 'long_term_style'] as const;
export type MemoryClass = (typeof MEMORY_CLASSES)[number];
export type Scope = 'user' | 'workspace' | 'tenant';
export type Taint = 'TRUSTED' | 'ORG' | 'UNTRUSTED';

/** Where each class lives and how long it stays fresh unused (§6.1, §6.5); null = indefinite. */
export const CLASS_RULES: Record<MemoryClass, { scope: Scope; ttlDays: number | null }> = {
  preference: { scope: 'user', ttlDays: null },
  working_context: { scope: 'workspace', ttlDays: 30 },
  task_history: { scope: 'workspace', ttlDays: 90 },
  org_knowledge: { scope: 'tenant', ttlDays: null },
  long_term_style: { scope: 'user', ttlDays: null },
};

export interface Proposal {
  scope?: Scope;
  subjectId: string;
  class: MemoryClass;
  content: string;
  /** Resolved from the provenance graph (M3), never from the content itself. */
  sourceTaint: Taint;
  provenance: { via: 'run' | 'user' | 'system'; runId?: string | null; sourceIds?: readonly string[]; detail?: string };
  confidence?: number;
  createdBy?: string | null;
}

export type ProposeResult =
  | { status: 'stored'; id: string }
  | { status: 'duplicate'; id: string }
  | { status: 'conflict'; conflictId: string; existingId: string; similarity: number }
  | { status: 'rejected_untrusted'; reason: string };

export type MemoryRow = typeof schema.memories.$inferSelect;

export class MemoryRejected extends Error {}

/** Near-identical: the same memory again — reinforce it, do not duplicate it. */
const DUPLICATE = 0.97;

export class MemoryStore {
  constructor(
    private readonly deps: {
      embedder: Embedder;
      /** Optional semantic judge for "same topic, different claim" (an LLM, deployed). */
      contradicts?: (existing: string, proposed: string) => Promise<boolean>;
      now?: () => Date;
      log?: { warn(o: object, m: string): void };
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async event(tenantId: string, kind: string, payload: Record<string, unknown>, actorId: string | null = null) {
    await withTenant(tenantId, (db) => db.insert(schema.platformEvents).values({ tenantId, actorId, kind, payload }));
  }

  async propose(tenantId: string, p: Proposal): Promise<ProposeResult> {
    // ★ THE T2 DEFENSE, application layer: untrusted content never becomes a memory. No retry.
    if (p.sourceTaint !== 'TRUSTED' && p.sourceTaint !== 'ORG') {
      await this.event(tenantId, 'memory.rejected_untrusted', { class: p.class, via: p.provenance.via, runId: p.provenance.runId ?? null, sourceIds: p.provenance.sourceIds ?? [], taint: p.sourceTaint });
      this.deps.log?.warn({ tenant_id: tenantId, run_id: p.provenance.runId, class: p.class }, 'memory write from UNTRUSTED content refused (T2)');
      return { status: 'rejected_untrusted', reason: 'memory can only be written from trusted or organization sources' };
    }
    const content = p.content.trim().slice(0, 2000);
    if (!content) throw new MemoryRejected('empty memory');
    const scope = p.scope ?? CLASS_RULES[p.class].scope;
    const [vec] = await this.deps.embedder.embed([content]);
    const literal = `[${vec!.join(',')}]`;
    const similar = await withTenant(tenantId, (db) =>
      db.execute(sql`SELECT id, content, user_edited, 1 - (embedding <=> ${literal}::vector) AS sim FROM memories
        WHERE scope = ${scope} AND subject_id = ${p.subjectId} AND class = ${p.class} AND valid_to IS NULL AND embedding IS NOT NULL
        ORDER BY embedding <=> ${literal}::vector LIMIT 5`),
    );
    for (const r of similar.rows as Array<{ id: string; content: string; user_edited: boolean; sim: number }>) {
      const sim = Number(r.sim);
      if (sim >= DUPLICATE || r.content.trim().toLowerCase() === content.toLowerCase()) {
        await withTenant(tenantId, (db) => db.update(schema.memories).set({ confidence: sql`least(1, ${schema.memories.confidence} + 0.05)`, stale: false }).where(eq(schema.memories.id, r.id)));
        return { status: 'duplicate', id: r.id };
      }
      const same = sim >= this.deps.embedder.sameTopic;
      const contradicts = same && (this.deps.contradicts ? await this.deps.contradicts(r.content, content) : true);
      if (contradicts) {
        const [c] = await withTenant(tenantId, (db) =>
          db.insert(schema.memoryConflicts).values({ tenantId, existingId: r.id, proposedJson: { ...p, scope, content }, similarity: sim }).returning({ id: schema.memoryConflicts.id }),
        );
        await this.event(tenantId, 'memory.conflict', { conflictId: c!.id, existingId: r.id, class: p.class, subjectId: p.subjectId, runId: p.provenance.runId ?? null });
        return { status: 'conflict', conflictId: c!.id, existingId: r.id, similarity: sim };
      }
    }
    return { status: 'stored', id: await this.insert(tenantId, { ...p, scope, content }, vec!) };
  }

  private async insert(tenantId: string, p: Proposal & { scope: Scope }, embedding: number[]): Promise<string> {
    const [row] = await withTenant(tenantId, (db) =>
      db
        .insert(schema.memories)
        .values({
          tenantId,
          scope: p.scope,
          subjectId: p.subjectId,
          class: p.class,
          content: p.content,
          embedding,
          provenanceJson: { via: p.provenance.via, runId: p.provenance.runId ?? null, sourceIds: p.provenance.sourceIds ?? [], detail: p.provenance.detail ?? null, taintAtWrite: p.sourceTaint },
          sourceTaint: p.sourceTaint,
          confidence: p.confidence ?? (p.provenance.via === 'user' ? 0.9 : 0.5),
          createdFromRun: p.provenance.runId ?? null,
          createdBy: p.createdBy ?? null,
          validFrom: this.now(),
        })
        .returning({ id: schema.memories.id }),
    );
    return row!.id;
  }

  // ------------------------------------------------------------------ the subject's control (§6.4)
  async list(tenantId: string, f: { subjects: Array<{ scope: Scope; subjectId: string }>; class?: MemoryClass; includeInactive?: boolean }) {
    if (!f.subjects.length) return [];
    return withTenant(tenantId, (db) =>
      db
        .select({ id: schema.memories.id, scope: schema.memories.scope, subjectId: schema.memories.subjectId, class: schema.memories.class, content: schema.memories.content, provenance: schema.memories.provenanceJson, sourceTaint: schema.memories.sourceTaint, confidence: schema.memories.confidence, createdFromRun: schema.memories.createdFromRun, validFrom: schema.memories.validFrom, validTo: schema.memories.validTo, userEdited: schema.memories.userEdited, pinned: schema.memories.pinned, stale: schema.memories.stale, lastUsedAt: schema.memories.lastUsedAt, useCount: schema.memories.useCount })
        .from(schema.memories)
        .where(and(or(...f.subjects.map((s) => and(eq(schema.memories.scope, s.scope), eq(schema.memories.subjectId, s.subjectId)))), f.class ? eq(schema.memories.class, f.class) : undefined, f.includeInactive ? undefined : isNull(schema.memories.validTo)))
        .orderBy(desc(schema.memories.validFrom)),
    );
  }

  async get(tenantId: string, id: string): Promise<MemoryRow | null> {
    return withTenant(tenantId, async (db) => (await db.select().from(schema.memories).where(eq(schema.memories.id, id)))[0] ?? null);
  }

  /** A person's edit: TRUSTED by definition, confidence raised, never overwritten by the system. */
  async edit(tenantId: string, id: string, content: string, by: string): Promise<MemoryRow> {
    const [vec] = await this.deps.embedder.embed([content]);
    const [row] = await withTenant(tenantId, (db) =>
      db.update(schema.memories).set({ content: content.trim().slice(0, 2000), embedding: vec!, userEdited: true, confidence: sql`greatest(0.9, ${schema.memories.confidence})`, stale: false, sourceTaint: 'TRUSTED' }).where(eq(schema.memories.id, id)).returning(),
    );
    if (!row) throw new MemoryRejected('no such memory');
    await this.event(tenantId, 'memory.edited', { memoryId: id }, by);
    return row;
  }

  async setFlags(tenantId: string, id: string, f: { pinned?: boolean; stale?: boolean }): Promise<void> {
    await withTenant(tenantId, (db) => db.update(schema.memories).set({ ...f, ...(f.pinned ? { confidence: 1, stale: false } : {}) }).where(eq(schema.memories.id, id)));
  }

  /** Immediate and permanent (§6.4). The event records THAT it was deleted — never the content. */
  async delete(tenantId: string, id: string, by: string): Promise<boolean> {
    const deleted = await withTenant(tenantId, async (db) => {
      await db.update(schema.memories).set({ supersededBy: null }).where(eq(schema.memories.supersededBy, id));
      return db.delete(schema.memories).where(eq(schema.memories.id, id)).returning({ id: schema.memories.id, class: schema.memories.class });
    });
    if (!deleted.length) return false;
    await this.event(tenantId, 'memory.deleted', { memoryId: id, class: deleted[0]!.class }, by);
    return true;
  }

  async conflicts(tenantId: string, subjects: Array<{ scope: Scope; subjectId: string }>) {
    if (!subjects.length) return [];
    return withTenant(tenantId, async (db) => {
      const open = await db.select().from(schema.memoryConflicts).where(isNull(schema.memoryConflicts.resolution));
      const existing = open.length ? await db.select().from(schema.memories).where(inArray(schema.memories.id, open.map((c) => c.existingId))) : [];
      const byId = new Map(existing.map((m) => [m.id, m]));
      return open
        .filter((c) => {
          const m = byId.get(c.existingId);
          return m && subjects.some((s) => s.scope === m.scope && s.subjectId === m.subjectId);
        })
        .map((c) => ({ id: c.id, detectedAt: c.detectedAt, similarity: c.similarity, existing: { id: byId.get(c.existingId)!.id, content: byId.get(c.existingId)!.content, provenance: byId.get(c.existingId)!.provenanceJson, userEdited: byId.get(c.existingId)!.userEdited }, proposed: c.proposedJson as Proposal & { scope: Scope } }));
    });
  }

  /** The subject decides (§8.1): keep, take the new one, merge into their own words, or keep both. */
  async resolve(tenantId: string, conflictId: string, r: { resolution: 'keep_existing' | 'accept_new' | 'merge' | 'both_valid'; mergedContent?: string; by: string }): Promise<{ memoryId: string | null }> {
    const [c] = await withTenant(tenantId, (db) => db.select().from(schema.memoryConflicts).where(eq(schema.memoryConflicts.id, conflictId)));
    if (!c || c.resolution) throw new MemoryRejected('no open conflict with that id');
    const p = c.proposedJson as Proposal & { scope: Scope };
    // The proposal was gated when it was made; check again — a conflict row is not a way around the gate.
    if (p.sourceTaint !== 'TRUSTED' && p.sourceTaint !== 'ORG') throw new MemoryRejected('an untrusted proposal cannot be accepted');
    let memoryId: string | null = null;
    if (r.resolution === 'accept_new' || r.resolution === 'both_valid' || r.resolution === 'merge') {
      const content = r.resolution === 'merge' ? (r.mergedContent ?? '').trim() : p.content;
      if (!content) throw new MemoryRejected('a merge needs the merged text');
      const [vec] = await this.deps.embedder.embed([content]);
      memoryId = await this.insert(tenantId, r.resolution === 'merge' ? { ...p, content, sourceTaint: 'TRUSTED', provenance: { ...p.provenance, via: 'user', detail: `merged by the subject from conflict ${conflictId}` }, createdBy: r.by } : p, vec!);
      if (r.resolution !== 'both_valid') await withTenant(tenantId, (db) => db.update(schema.memories).set({ validTo: this.now(), supersededBy: memoryId }).where(eq(schema.memories.id, c.existingId)));
      if (r.resolution === 'merge') await withTenant(tenantId, (db) => db.update(schema.memories).set({ userEdited: true, confidence: 0.9 }).where(eq(schema.memories.id, memoryId!)));
    }
    await withTenant(tenantId, (db) => db.update(schema.memoryConflicts).set({ resolution: r.resolution, resolvedBy: r.by, resolvedAt: this.now() }).where(eq(schema.memoryConflicts.id, conflictId)));
    return { memoryId };
  }

  // ------------------------------------------------------------------ the read path (§6.3, §6.5)
  /**
   * The memories relevant to a query, for these subjects, with taint and provenance — and their
   * use recorded. A stale or low-confidence memory is returned flagged: it must be revalidated
   * before it influences a HIGH-tier action.
   */
  async recall(tenantId: string, subjects: Array<{ scope: Scope; subjectId: string }>, query: string, k = 5) {
    if (!subjects.length) return [];
    const [vec] = await this.deps.embedder.embed([query]);
    const literal = `[${vec!.join(',')}]`;
    const conds = sql.join(subjects.map((s) => sql`(scope = ${s.scope} AND subject_id = ${s.subjectId})`), sql` OR `);
    const rows = (
      await withTenant(tenantId, (db) =>
        db.execute(sql`SELECT id, scope, class, content, source_taint, confidence, stale, provenance_json, created_from_run, last_used_at, 1 - (embedding <=> ${literal}::vector) AS sim
          FROM memories WHERE valid_to IS NULL AND (${conds}) ORDER BY embedding <=> ${literal}::vector LIMIT ${k}`),
      )
    ).rows as Array<{ id: string; scope: string; class: MemoryClass; content: string; source_taint: 'TRUSTED' | 'ORG'; confidence: string; stale: boolean; provenance_json: unknown; created_from_run: string | null; sim: number }>;
    if (rows.length) await withTenant(tenantId, (db) => db.update(schema.memories).set({ lastUsedAt: this.now(), useCount: sql`${schema.memories.useCount} + 1` }).where(inArray(schema.memories.id, rows.map((r) => r.id))));
    return rows.map((r) => ({ id: r.id, scope: r.scope, class: r.class, content: r.content, taint: r.source_taint, confidence: Number(r.confidence), similarity: Number(r.sim), provenance: r.provenance_json, createdFromRun: r.created_from_run, needsRevalidation: r.stale || Number(r.confidence) < 0.3 }));
  }

  /** Decay (§6.5): a memory unused past its class's TTL becomes stale and loses confidence. */
  async decay(tenantId: string): Promise<number> {
    let n = 0;
    for (const [cls, rule] of Object.entries(CLASS_RULES)) {
      if (!rule.ttlDays) continue;
      const cutoff = new Date(this.now().getTime() - rule.ttlDays * 86_400_000);
      const out = await withTenant(tenantId, (db) =>
        db
          .update(schema.memories)
          .set({ stale: true, confidence: sql`least(${schema.memories.confidence}, 0.25)` })
          .where(and(eq(schema.memories.class, cls), isNull(schema.memories.validTo), eq(schema.memories.pinned, false), eq(schema.memories.userEdited, false), eq(schema.memories.stale, false), sql`coalesce(${schema.memories.lastUsedAt}, ${schema.memories.validFrom}) < ${cutoff}`))
          .returning({ id: schema.memories.id }),
      );
      n += out.length;
    }
    return n;
  }

  /** Export on request (§6.4): everything about these subjects, with provenance. */
  async export(tenantId: string, subjects: Array<{ scope: Scope; subjectId: string }>) {
    return { exportedAt: this.now().toISOString(), memories: await this.list(tenantId, { subjects, includeInactive: true }) };
  }
}
