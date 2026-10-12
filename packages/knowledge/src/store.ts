import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { fga, tuple, type FgaClient, type TupleKey } from '@vega/authz';
import { schema, withTenant } from '@vega/db';
import type { ObjectStore } from '@vega/objectstore';
import type { Embedder } from './embed.js';
import { chunk, parseDocument, type DoclingClient } from './parse.js';
import type { Reranker } from './rerank.js';
import { rrf } from './rerank.js';

/**
 * THE KNOWLEDGE BASE — docs/module9.md §7. Ingestion and ACL-aware retrieval:
 *
 *   ingest   parse (structure kept) → chunk → classify (sensitivity, labels) → embed → store
 *            → OpenFGA tuples mirroring who may open the source document
 *   search   dense (pgvector HNSW) + lexical (Postgres FTS) → Reciprocal Rank Fusion → rerank
 *            → ★ ACL GATE: an OpenFGA batch check for the requesting user, AFTER retrieval and
 *              BEFORE return — a chunk of a document the user cannot open is never returned
 *            → sensitivity gate → top k, each with its document, heading path and TAINT
 *            → the retrieval logged, with how many chunks the gate withheld
 *
 * Taint (§7.4): curated documents are ORG; an external email attachment or web content is
 * UNTRUSTED however it entered the index (a CHECK constraint holds the database to it).
 */

export type Taint = 'TRUSTED' | 'ORG' | 'UNTRUSTED';
export type SourceKind = 'upload' | 'gdrive' | 'sharepoint' | 'url' | 'email_attachment';

export interface ClassifierLike {
  classify(text: string): Promise<{ sensitivity: number; labels: string[] }>;
}

export interface IngestInput {
  title: string;
  mime: string;
  data: Uint8Array;
  sourceKind: SourceKind;
  externalRef?: string | null;
  workspaceId?: string | null;
  /** Mirror of the source system's permissions: these users may open it (plus workspace members). */
  aclUsers?: string[];
  createdBy: string;
}

export interface Hit {
  chunkId: string;
  documentId: string;
  title: string;
  headingPath: string[];
  content: string;
  taint: Taint;
  sensitivity: number;
  score: number;
  dense: number | null;
  lexical: number | null;
}

export interface SearchResult {
  hits: Hit[];
  aclFiltered: number;
  sensitivityFiltered: number;
  candidates: number;
  retrievalId: string | null;
}

/** Sensitivity at or above this needs an explicit workflow permission to be retrieved (§11). */
export const SENSITIVE = 70;

export class KnowledgeBase {
  constructor(
    readonly deps: {
      embedder: Embedder;
      reranker: Reranker;
      fga: FgaClient;
      objects: ObjectStore;
      classifier: ClassifierLike;
      docling?: DoclingClient | undefined;
      log?: { warn(o: object, m: string): void; error(o: object, m: string): void };
    },
  ) {}

  /** Who may open the document — the OpenFGA tuples that mirror the source system. */
  private aclTuples(documentId: string, workspaceId: string | null, users: string[]): TupleKey[] {
    const doc = fga.document(documentId);
    return [...(workspaceId ? [tuple(fga.workspace(workspaceId), 'parent', doc)] : []), ...users.map((u) => tuple(fga.user(u), 'viewer', doc))];
  }

  async ingest(tenantId: string, i: IngestInput): Promise<{ id: string; chunks: number; state: string; error?: string }> {
    const external = i.sourceKind === 'email_attachment' || i.sourceKind === 'url';
    const digest = `sha256:${createHash('sha256').update(i.data).digest('hex')}`;
    const contentRef = `kb/${tenantId}/${digest.slice(7)}`;
    await this.deps.objects.put(contentRef, Buffer.from(i.data), i.mime);
    const users = [...new Set(i.aclUsers?.length ? i.aclUsers : i.workspaceId ? [] : [i.createdBy])];
    const [doc] = await withTenant(tenantId, (db) =>
      db
        .insert(schema.kbDocuments)
        .values({ tenantId, workspaceId: i.workspaceId ?? null, sourceKind: i.sourceKind, externalRef: i.externalRef ?? null, title: i.title, contentRef, contentDigest: digest, mime: i.mime, taint: external ? 'UNTRUSTED' : 'ORG', aclRef: 'pending', aclUsers: users, createdBy: i.createdBy })
        .returning(),
    );
    const id = doc!.id;
    await withTenant(tenantId, (db) => db.update(schema.kbDocuments).set({ aclRef: fga.document(id) }).where(eq(schema.kbDocuments.id, id)));
    // The ACL first: a chunk must never be retrievable before its permissions exist.
    await this.deps.fga.write(this.aclTuples(id, i.workspaceId ?? null, users));
    return this.index(tenantId, id, i.data);
  }

  private async index(tenantId: string, id: string, data?: Uint8Array): Promise<{ id: string; chunks: number; state: string; error?: string }> {
    const [doc] = await withTenant(tenantId, (db) => db.select().from(schema.kbDocuments).where(eq(schema.kbDocuments.id, id)));
    if (!doc) throw new Error('no such document');
    try {
      const bytes = data ?? (await this.deps.objects.get(doc.contentRef));
      if (!bytes) throw new Error('the document content is gone from storage');
      const chunks = chunk(await parseDocument(new Uint8Array(bytes), doc.mime, doc.title, this.deps.docling));
      if (!chunks.length) throw new Error('the document has no text');
      const classes = await Promise.all(chunks.map((c) => this.deps.classifier.classify(c.content)));
      const vectors = await this.deps.embedder.embed(chunks.map((c) => [doc.title, ...c.headingPath, c.content].join('\n')));
      await withTenant(tenantId, async (db) => {
        await db.delete(schema.kbChunks).where(eq(schema.kbChunks.documentId, id));
        await db.insert(schema.kbChunks).values(chunks.map((c, n) => ({ tenantId, documentId: id, ordinal: c.ordinal, content: c.content, headingPath: c.headingPath, embedding: vectors[n]!, tokenCount: c.tokenCount })));
        await db
          .update(schema.kbDocuments)
          .set({ state: 'indexed', indexedAt: new Date(), error: null, sensitivity: Math.max(0, ...classes.map((c) => c.sensitivity)), labels: [...new Set(classes.flatMap((c) => c.labels))].sort() })
          .where(eq(schema.kbDocuments.id, id));
      });
      return { id, chunks: chunks.length, state: 'indexed' };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await withTenant(tenantId, (db) => db.update(schema.kbDocuments).set({ state: 'failed', error }).where(eq(schema.kbDocuments.id, id)));
      return { id, chunks: 0, state: 'failed', error };
    }
  }

  reindex(tenantId: string, id: string) {
    return this.index(tenantId, id);
  }

  /** Delete cascades: chunks (FK), the stored bytes, and the ACL tuples (§11). */
  async delete(tenantId: string, id: string): Promise<boolean> {
    const [doc] = await withTenant(tenantId, (db) => db.delete(schema.kbDocuments).where(eq(schema.kbDocuments.id, id)).returning());
    if (!doc) return false;
    await this.deps.fga.write([], this.aclTuples(id, doc.workspaceId, doc.aclUsers)).catch((e) => this.deps.log?.error({ err: e, document_id: id }, 'could not delete ACL tuples'));
    await this.deps.objects.delete?.(doc.contentRef).catch(() => undefined);
    return true;
  }

  async documents(tenantId: string) {
    return withTenant(tenantId, async (db) => {
      const docs = await db.select().from(schema.kbDocuments).orderBy(sql`${schema.kbDocuments.createdAt} DESC`);
      const counts = await db.select({ documentId: schema.kbChunks.documentId, n: sql<number>`count(*)::int` }).from(schema.kbChunks).groupBy(schema.kbChunks.documentId);
      const byDoc = new Map(counts.map((c) => [c.documentId, c.n]));
      return docs.map((d) => ({ ...d, chunks: byDoc.get(d.id) ?? 0 }));
    });
  }

  /** "Who can retrieve this" (§8.2): every user of the tenant, checked against the ACL. */
  async aclPreview(tenantId: string, id: string): Promise<Array<{ userId: string; email: string; canRead: boolean }>> {
    const users = await withTenant(tenantId, (db) => db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(eq(schema.users.status, 'active')));
    const ok = await this.deps.fga.batchCheck(users.map((u) => tuple(fga.user(u.id), 'can_read', fga.document(id))));
    return users.map((u, i) => ({ userId: u.id, email: u.email, canRead: ok[i] === true }));
  }

  async search(
    tenantId: string,
    q: { userId: string; query: string; k?: number; runId?: string | null; purpose?: 'planning' | 'groundedness' | 'search'; allowSensitive?: boolean; taints?: Taint[]; log?: boolean },
  ): Promise<SearchResult> {
    const k = q.k ?? 5;
    const pool = 40;
    const [vec] = await this.deps.embedder.embed([q.query]);
    const literal = `[${vec!.join(',')}]`;
    const { dense, lexical } = await withTenant(tenantId, async (db) => {
      const dense = (await db.execute(sql`SELECT id, 1 - (embedding <=> ${literal}::vector) AS s FROM kb_chunks WHERE embedding IS NOT NULL ORDER BY embedding <=> ${literal}::vector LIMIT ${pool}`)).rows as Array<{ id: string; s: number }>;
      const lexical = (await db.execute(sql`SELECT id, ts_rank(tsv, q) AS s FROM kb_chunks, websearch_to_tsquery('english', ${q.query}) q WHERE tsv @@ q ORDER BY s DESC LIMIT ${pool}`)).rows as Array<{ id: string; s: number }>;
      return { dense, lexical };
    });
    const fused = rrf([dense.map((r) => r.id), lexical.map((r) => r.id)]).slice(0, 30);
    if (!fused.length) return this.log(tenantId, q, { hits: [], aclFiltered: 0, sensitivityFiltered: 0, candidates: 0, retrievalId: null });
    const rows = await withTenant(tenantId, (db) =>
      db
        .select({ id: schema.kbChunks.id, documentId: schema.kbChunks.documentId, content: schema.kbChunks.content, headingPath: schema.kbChunks.headingPath, title: schema.kbDocuments.title, taint: schema.kbDocuments.taint, sensitivity: schema.kbDocuments.sensitivity, state: schema.kbDocuments.state })
        .from(schema.kbChunks)
        .innerJoin(schema.kbDocuments, eq(schema.kbDocuments.id, schema.kbChunks.documentId))
        .where(and(inArray(schema.kbChunks.id, fused.map((f) => f.id)), eq(schema.kbDocuments.state, 'indexed'))),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const candidates = fused.map((f) => byId.get(f.id)).filter((r): r is (typeof rows)[number] => !!r);
    const scores = await this.deps.reranker.rerank(q.query, candidates.map((c) => `${c.title}\n${c.headingPath.join(' › ')}\n${c.content}`));
    const ranked = candidates.map((c, i) => ({ c, score: scores[i]! })).sort((a, b) => b.score - a.score);

    // ★ THE ACL GATE: one batch check per distinct document, for THIS user, before anything is returned.
    const docIds = [...new Set(ranked.map((r) => r.c.documentId))];
    let allowed: boolean[];
    try {
      allowed = await this.deps.fga.batchCheck(docIds.map((d) => tuple(fga.user(q.userId), 'can_read', fga.document(d))));
    } catch (e) {
      // Fail closed: if permissions cannot be checked, nothing is returned.
      this.deps.log?.error({ err: e }, 'ACL check failed: retrieval returns nothing (fail closed)');
      allowed = docIds.map(() => false);
    }
    const may = new Set(docIds.filter((_, i) => allowed[i] === true));
    let aclFiltered = 0;
    let sensitivityFiltered = 0;
    const hits: Hit[] = [];
    const denseScore = new Map(dense.map((d) => [d.id, Number(d.s)]));
    const lexScore = new Map(lexical.map((d) => [d.id, Number(d.s)]));
    for (const { c, score } of ranked) {
      if (!may.has(c.documentId)) {
        aclFiltered++;
        continue;
      }
      if (c.sensitivity >= SENSITIVE && !q.allowSensitive) {
        sensitivityFiltered++;
        continue;
      }
      if (q.taints && !q.taints.includes(c.taint as Taint)) continue;
      if (hits.length < k) hits.push({ chunkId: c.id, documentId: c.documentId, title: c.title, headingPath: c.headingPath, content: c.content, taint: c.taint as Taint, sensitivity: c.sensitivity, score, dense: denseScore.get(c.id) ?? null, lexical: lexScore.get(c.id) ?? null });
    }
    return this.log(tenantId, q, { hits, aclFiltered, sensitivityFiltered, candidates: candidates.length, retrievalId: null });
  }

  private async log(tenantId: string, q: { userId: string; query: string; runId?: string | null; purpose?: string; log?: boolean }, r: SearchResult): Promise<SearchResult> {
    if (q.log === false) return r;
    const [row] = await withTenant(tenantId, (db) =>
      db
        .insert(schema.retrievals)
        .values({ tenantId, runId: q.runId ?? null, purpose: q.purpose ?? 'search', requestedBy: q.userId, query: q.query.slice(0, 2000), chunkIds: r.hits.map((h) => h.chunkId), memoryIds: [], scoresJson: r.hits.map((h) => ({ chunkId: h.chunkId, documentId: h.documentId, score: h.score, dense: h.dense, lexical: h.lexical })), aclFiltered: r.aclFiltered, sensitivityFiltered: r.sensitivityFiltered })
        .returning({ id: schema.retrievals.id }),
    );
    return { ...r, retrievalId: row!.id };
  }
}
