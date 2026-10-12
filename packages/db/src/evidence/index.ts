import { readdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * EVIDENCE PLANE database access — `@vega/db/evidence`.
 *
 * A separate entry point on purpose. The evidence instance is physically separate
 * (module1.md §3.2) and the execution plane holds NO credential for it; the execution plane
 * reaches evidence only through the evidence service's HTTP /append. This module is imported
 * by services/evidence and by nothing else — `no-evidence-write-from-execution` and PLANE-001
 * fail the build if services/execution imports it.
 *
 * Invariant 1 has four layers. This code relies on, and never substitutes for, the other
 * three: network policy, the INSERT-only grant, and the append-only trigger.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'evidence-migrations');
const LOCK_KEY = 0x65766964; // 'evid'

/** Applies evidence-plane migrations as the evidence OWNER. Same ledger shape as the primary. */
export async function migrateEvidence(ownerUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), checksum text NOT NULL)`,
    );
    const { rows } = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM _migrations');
    const seen = new Map(rows.map((r) => [r.name, r.checksum]));
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      const text = readFileSync(join(MIGRATIONS, file), 'utf8');
      const checksum = createHash('sha256').update(text).digest('hex');
      const prev = seen.get(file);
      if (prev) {
        if (prev !== checksum) throw new Error(`evidence migration ${file} was modified after being applied`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(text);
        await client.query('INSERT INTO _migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`evidence migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

export interface InboxEntry {
  tenantId: string;
  source: string;
  kind: string;
  payload: Record<string, unknown>;
}

/**
 * INSERT-only writer, connected as vega_evi_writer. It exposes append() and nothing else:
 * there is no read, update or delete method to call, and the role could not execute one.
 */
export class EvidenceWriter {
  private readonly pool: pg.Pool;

  constructor(writerUrl: string) {
    this.pool = new pg.Pool({ connectionString: writerUrl, max: 5, application_name: 'evidence-writer' });
  }

  async append(entry: InboxEntry): Promise<{ id: string; receivedAt: Date }> {
    const id = randomUUID();
    const receivedAt = new Date();
    await this.pool.query(
      `INSERT INTO evidence_inbox (id, received_at, tenant_id, source, kind, payload) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, receivedAt, entry.tenantId, entry.source, entry.kind, JSON.stringify(entry.payload)],
    );
    return { id, receivedAt };
  }

  /**
   * Appends one entry to a tenant's chain (module7.md §5.2). Under a per-tenant advisory lock:
   * read the head through `evidence_chain_head()` (the writer's only read), let `seal` compute
   * and sign the entry for `seq = head + 1`, insert it. A failure rolls the whole thing back, so
   * a sequence number is never burnt: no gaps, by construction — and UNIQUE(tenant, seq) makes
   * a fork impossible even if the lock were bypassed.
   */
  async appendEntry(tenantId: string, seal: (head: { seq: number; entryHash: string | null }) => Promise<SealedEntry>): Promise<SealedEntry> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 7))', [tenantId]);
      const { rows } = await client.query<{ seq: string; entry_hash: string }>('SELECT seq, entry_hash FROM evidence_chain_head($1)', [tenantId]);
      const head = rows[0] ? { seq: Number(rows[0].seq), entryHash: rows[0].entry_hash } : { seq: 0, entryHash: null };
      const e = await seal(head);
      if (e.seq !== head.seq + 1) throw new Error(`chain seal returned seq ${e.seq} for head ${head.seq}`);
      await client.query(
        `INSERT INTO audit_entries (tenant_id, seq, id, ts, kind, source, payload_json, payload_digest, prev_hash, entry_hash, signature, key_id, leaf_index,
                                    run_id, action_id, actor, agent_id, tool_id, connector_id, risk_tier, decision, outcome, subjects)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [
          tenantId, e.seq, e.id, e.ts, e.kind, e.source, JSON.stringify(e.payload), e.payloadDigest, e.prevHash, e.entryHash, e.signature, e.keyId, e.seq - 1,
          e.facets.runId ?? null, e.facets.actionId ?? null, e.facets.actor ?? null, e.facets.agentId ?? null, e.facets.toolId ?? null, e.facets.connectorId ?? null,
          e.facets.riskTier ?? null, e.facets.decision ?? null, e.facets.outcome ?? null, e.facets.subjects ?? [],
        ],
      );
      await client.query('COMMIT');
      return e;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Content index row. Idempotent: the same digest stored twice is one object. */
  async insertContent(c: { tenantId: string; digest: string; sizeBytes: number; mediaType: string; sensitivity: 'body' | 'metadata'; storageKey: string; retainUntil: Date }): Promise<void> {
    await this.pool.query(
      `INSERT INTO content_objects (tenant_id, digest, size_bytes, media_type, sensitivity, storage_key, retain_until) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [c.tenantId, c.digest, c.sizeBytes, c.mediaType, c.sensitivity, c.storageKey, c.retainUntil],
    );
  }

  async insertKey(k: { keyId: string; alg: string; publicKey: string; notBefore: Date; custody: string }): Promise<void> {
    await this.pool.query(`INSERT INTO signing_keys (key_id, alg, public_key, not_before, custody) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [k.keyId, k.alg, k.publicKey, k.notBefore, k.custody]);
  }

  async insertAnchor(a: AnchorRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO anchors (id, tenant_id, chain_head_seq, chain_head_hash, tree_size, root_hash, method, external_ref, timestamp_token, key_id, signature, anchored_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
      [a.id, a.tenantId, a.chainHeadSeq, a.chainHeadHash, a.treeSize, a.rootHash, a.method, a.externalRef, a.timestampToken, a.keyId, a.signature, a.anchoredAt],
    );
  }

  async insertRedaction(r: RedactionRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO redactions (id, tenant_id, digest, request_id, reason, requested_by, entry_seq, redacted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [r.id, r.tenantId, r.digest, r.requestId, r.reason, r.requestedBy, r.entrySeq, r.redactedAt],
    );
  }

  async insertPack(p: { id: string; tenantId: string; query: Record<string, unknown>; requestedBy: string; includeBodies: boolean; expiresAt: Date | null }): Promise<void> {
    await this.pool.query(`INSERT INTO evidence_packs (id, tenant_id, query_json, requested_by, include_bodies, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, [
      p.id, p.tenantId, JSON.stringify(p.query), p.requestedBy, p.includeBodies, p.expiresAt,
    ]);
  }

  async insertPackBuild(b: PackBuildRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO evidence_pack_builds (pack_id, tenant_id, status, entry_count, artifact_ref, digest, signature, size_bytes, duration_ms, error, entry_seq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [b.packId, b.tenantId, b.status, b.entryCount, b.artifactRef, b.digest, b.signature, b.sizeBytes, b.durationMs, b.error, b.entrySeq],
    );
  }

  async insertReplay(r: ReplayRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO replay_runs (id, tenant_id, action_id, entry_seq, original_digest, replay_digest, matched, layers_json, divergence_json, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [r.id, r.tenantId, r.actionId, r.entrySeq, r.originalDigest, r.replayDigest, r.matched, JSON.stringify(r.layers), r.divergence ? JSON.stringify(r.divergence) : null, r.requestedBy],
    );
  }

  async insertVerification(v: { tenantId: string; ok: boolean; entries: number; headSeq: number | null; detail: Record<string, unknown> }): Promise<void> {
    await this.pool.query(`INSERT INTO chain_verifications (id, tenant_id, ok, entries, head_seq, detail_json) VALUES ($1,$2,$3,$4,$5,$6)`, [
      randomUUID(), v.tenantId, v.ok, v.entries, v.headSeq, JSON.stringify(v.detail),
    ]);
  }

  /** Readiness: the connection works. Deliberately reads no table — the role cannot. */
  async ping(): Promise<boolean> {
    await this.pool.query('SELECT 1');
    return true;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// =============================================================================== the chain

/** What the chain stores per entry — everything the verifier needs, plus the explorer's facets. */
export interface SealedEntry {
  id: string;
  seq: number;
  ts: string;
  kind: string;
  source: string;
  payload: Record<string, unknown>;
  payloadDigest: string;
  prevHash: string;
  entryHash: string;
  signature: string;
  keyId: string;
  facets: EntryFacets;
}

export interface EntryFacets {
  runId?: string | null;
  actionId?: string | null;
  actor?: string | null;
  agentId?: string | null;
  toolId?: string | null;
  connectorId?: string | null;
  riskTier?: string | null;
  decision?: string | null;
  outcome?: string | null;
  subjects?: string[];
}

export interface StoredChainEntry extends Omit<SealedEntry, 'facets'> {
  tenantId: string;
  facets: Required<EntryFacets>;
}

export interface AnchorRow {
  id: string;
  tenantId: string;
  chainHeadSeq: number;
  chainHeadHash: string;
  treeSize: number;
  rootHash: string;
  method: string;
  externalRef: string | null;
  timestampToken: string | null;
  keyId: string;
  signature: string;
  anchoredAt: string;
}

export interface RedactionRow {
  id: string;
  tenantId: string;
  digest: string;
  requestId: string;
  reason: string;
  requestedBy: string;
  entrySeq: number;
  redactedAt: string;
}

export interface PackRow {
  id: string;
  tenantId: string;
  query: Record<string, unknown>;
  requestedBy: string;
  includeBodies: boolean;
  requestedAt: string;
  expiresAt: string | null;
  build: PackBuildRow | null;
}

export interface PackBuildRow {
  packId: string;
  tenantId: string;
  status: 'built' | 'failed';
  entryCount: number | null;
  artifactRef: string | null;
  digest: string | null;
  signature: string | null;
  sizeBytes: number | null;
  durationMs: number;
  error: string | null;
  entrySeq: number | null;
  builtAt?: string;
}

export interface ReplayRow {
  id: string;
  tenantId: string;
  actionId: string;
  entrySeq: number;
  originalDigest: string;
  replayDigest: string;
  matched: boolean;
  layers: unknown;
  divergence: unknown;
  requestedBy: string;
  createdAt?: string;
}

export interface ContentRow {
  tenantId: string;
  digest: string;
  sizeBytes: number;
  mediaType: string;
  sensitivity: 'body' | 'metadata';
  storageKey: string;
  storedAt: string;
  retainUntil: string;
}

/** The Audit Explorer's facets (module7.md §6.1). Every filter is optional; all are ANDed. */
export interface EntryQuery {
  tenantId: string;
  from?: string | undefined;
  to?: string | undefined;
  kinds?: string[] | undefined;
  runId?: string | undefined;
  actionId?: string | undefined;
  actor?: string | undefined;
  agentId?: string | undefined;
  toolId?: string | undefined;
  connectorId?: string | undefined;
  riskTier?: string | undefined;
  decision?: string | undefined;
  subject?: string | undefined;
  seqFrom?: number | undefined;
  seqTo?: number | undefined;
}

const ENTRY_COLUMNS = `tenant_id, seq, id, ts, kind, source, payload_json, payload_digest, prev_hash, entry_hash, signature, key_id,
  run_id, action_id, actor, agent_id, tool_id, connector_id, risk_tier, decision, outcome, subjects`;

type EntryDbRow = {
  tenant_id: string; seq: string; id: string; ts: Date; kind: string; source: string; payload_json: Record<string, unknown>; payload_digest: string;
  prev_hash: string; entry_hash: string; signature: string; key_id: string; run_id: string | null; action_id: string | null; actor: string | null;
  agent_id: string | null; tool_id: string | null; connector_id: string | null; risk_tier: string | null; decision: string | null; outcome: string | null; subjects: string[];
};

function toEntry(r: EntryDbRow): StoredChainEntry {
  return {
    tenantId: r.tenant_id,
    seq: Number(r.seq),
    id: r.id,
    ts: r.ts.toISOString(),
    kind: r.kind,
    source: r.source,
    payload: r.payload_json,
    payloadDigest: r.payload_digest,
    prevHash: r.prev_hash,
    entryHash: r.entry_hash,
    signature: r.signature,
    keyId: r.key_id,
    facets: { runId: r.run_id, actionId: r.action_id, actor: r.actor, agentId: r.agent_id, toolId: r.tool_id, connectorId: r.connector_id, riskTier: r.risk_tier, decision: r.decision, outcome: r.outcome, subjects: r.subjects },
  };
}

function where(q: EntryQuery): { sql: string; params: unknown[] } {
  const params: unknown[] = [q.tenantId];
  const parts = ['tenant_id = $1'];
  const add = (cond: (p: string) => string, v: unknown) => {
    params.push(v);
    parts.push(cond(`$${params.length}`));
  };
  if (q.from) add((p) => `ts >= ${p}`, q.from);
  if (q.to) add((p) => `ts < ${p}`, q.to);
  if (q.kinds?.length) add((p) => `kind = ANY(${p})`, q.kinds);
  if (q.runId) add((p) => `run_id = ${p}`, q.runId);
  if (q.actionId) add((p) => `action_id = ${p}`, q.actionId);
  if (q.actor) add((p) => `actor = ${p}`, q.actor);
  if (q.agentId) add((p) => `agent_id = ${p}`, q.agentId);
  if (q.toolId) add((p) => `tool_id = ${p}`, q.toolId);
  if (q.connectorId) add((p) => `connector_id = ${p}`, q.connectorId);
  if (q.riskTier) add((p) => `risk_tier = ${p}`, q.riskTier);
  if (q.decision) add((p) => `decision = ${p}`, q.decision);
  if (q.subject) add((p) => `subjects @> ARRAY[${p}]::text[]`, q.subject);
  if (q.seqFrom !== undefined) add((p) => `seq >= ${p}`, q.seqFrom);
  if (q.seqTo !== undefined) add((p) => `seq <= ${p}`, q.seqTo);
  return { sql: parts.join(' AND '), params };
}

/**
 * The evidence plane's READ side, connected as vega_evi_reader (SELECT only). Used by the
 * evidence service's own query, pack, replay, anchoring and verification paths — never by any
 * other plane: the control plane asks the evidence service, it holds no evidence credential.
 */
export class EvidenceReader {
  private readonly pool: pg.Pool;

  constructor(readerUrl: string) {
    this.pool = new pg.Pool({ connectionString: readerUrl, max: 8, application_name: 'evidence-reader' });
  }

  async ping(): Promise<boolean> {
    await this.pool.query('SELECT 1');
    return true;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Newest first, cursor-paginated by seq — never OFFSET (module7.md §6.1). */
  async entries(q: EntryQuery, page: { limit: number; before?: number | undefined; order?: 'asc' | 'desc' }): Promise<StoredChainEntry[]> {
    const w = where(q);
    const asc = page.order === 'asc';
    if (page.before !== undefined) w.params.push(page.before);
    const cursor = page.before !== undefined ? ` AND seq ${asc ? '>' : '<'} $${w.params.length}` : '';
    w.params.push(page.limit);
    const { rows } = await this.pool.query<EntryDbRow>(`SELECT ${ENTRY_COLUMNS} FROM audit_entries WHERE ${w.sql}${cursor} ORDER BY seq ${asc ? 'ASC' : 'DESC'} LIMIT $${w.params.length}`, w.params);
    return rows.map(toEntry);
  }

  /** Streams every matching entry in seq order, in batches (packs, verification). */
  async *scan(q: EntryQuery, batch = 5_000): AsyncGenerator<StoredChainEntry[]> {
    let after: number | undefined;
    for (;;) {
      const rows = await this.entries(q, { limit: batch, order: 'asc', ...(after !== undefined ? { before: after } : {}) });
      if (!rows.length) return;
      yield rows;
      after = rows.at(-1)!.seq;
      if (rows.length < batch) return;
    }
  }

  async count(q: EntryQuery): Promise<number> {
    const w = where(q);
    const { rows } = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM audit_entries WHERE ${w.sql}`, w.params);
    return Number(rows[0]!.n);
  }

  async entry(tenantId: string, id: string): Promise<StoredChainEntry | null> {
    const { rows } = await this.pool.query<EntryDbRow>(`SELECT ${ENTRY_COLUMNS} FROM audit_entries WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    return rows[0] ? toEntry(rows[0]) : null;
  }

  async entryBySeq(tenantId: string, seq: number): Promise<StoredChainEntry | null> {
    const { rows } = await this.pool.query<EntryDbRow>(`SELECT ${ENTRY_COLUMNS} FROM audit_entries WHERE tenant_id = $1 AND seq = $2`, [tenantId, seq]);
    return rows[0] ? toEntry(rows[0]) : null;
  }

  /** Every entry hash of a tenant's log up to `size`, in leaf order (the Merkle tree's leaves). */
  async leaves(tenantId: string, size?: number): Promise<string[]> {
    const { rows } = await this.pool.query<{ entry_hash: string }>(
      `SELECT entry_hash FROM audit_entries WHERE tenant_id = $1${size !== undefined ? ' AND seq <= $2' : ''} ORDER BY seq`,
      size !== undefined ? [tenantId, size] : [tenantId],
    );
    return rows.map((r) => r.entry_hash);
  }

  async head(tenantId: string): Promise<{ seq: number; entryHash: string; ts: string } | null> {
    const { rows } = await this.pool.query<{ seq: string; entry_hash: string; ts: Date }>(`SELECT seq, entry_hash, ts FROM audit_entries WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1`, [tenantId]);
    return rows[0] ? { seq: Number(rows[0].seq), entryHash: rows[0].entry_hash, ts: rows[0].ts.toISOString() } : null;
  }

  /** Tenants whose chain has grown past their newest anchor — what the anchoring job visits. */
  async tenantsNeedingAnchor(): Promise<string[]> {
    const { rows } = await this.pool.query<{ tenant_id: string }>(
      `SELECT h.tenant_id FROM (SELECT tenant_id, max(seq) AS seq FROM audit_entries GROUP BY tenant_id) h
       LEFT JOIN (SELECT tenant_id, max(tree_size) AS size FROM anchors GROUP BY tenant_id) a USING (tenant_id)
       WHERE a.size IS NULL OR a.size < h.seq`,
    );
    return rows.map((r) => r.tenant_id);
  }

  async tenants(): Promise<string[]> {
    const { rows } = await this.pool.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM audit_entries`);
    return rows.map((r) => r.tenant_id);
  }

  /** Newest first unless `order: 'asc'`. */
  async anchors(tenantId: string, opts: { limit?: number; minSize?: number; maxSize?: number; order?: 'asc' | 'desc' } = {}): Promise<AnchorRow[]> {
    const params: unknown[] = [tenantId];
    let sql = `SELECT * FROM anchors WHERE tenant_id = $1`;
    if (opts.minSize !== undefined) sql += ` AND tree_size >= $${params.push(opts.minSize)}`;
    if (opts.maxSize !== undefined) sql += ` AND tree_size <= $${params.push(opts.maxSize)}`;
    sql += ` ORDER BY tree_size ${opts.order === 'asc' ? 'ASC' : 'DESC'} LIMIT $${params.push(opts.limit ?? 1000)}`;
    const { rows } = await this.pool.query(sql, params);
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      chainHeadSeq: Number(r.chain_head_seq),
      chainHeadHash: r.chain_head_hash,
      treeSize: Number(r.tree_size),
      rootHash: r.root_hash,
      method: r.method,
      externalRef: r.external_ref,
      timestampToken: r.timestamp_token,
      keyId: r.key_id,
      signature: r.signature,
      anchoredAt: (r.anchored_at as Date).toISOString(),
    }));
  }

  async keys(): Promise<Array<{ keyId: string; alg: string; publicKey: string; notBefore: string; custody: string }>> {
    const { rows } = await this.pool.query(`SELECT key_id, alg, public_key, not_before, custody FROM signing_keys ORDER BY not_before`);
    return rows.map((r) => ({ keyId: r.key_id, alg: r.alg, publicKey: r.public_key, notBefore: (r.not_before as Date).toISOString(), custody: r.custody }));
  }

  async content(tenantId: string, digest: string): Promise<ContentRow | null> {
    const { rows } = await this.pool.query(`SELECT * FROM content_objects WHERE tenant_id = $1 AND digest = $2`, [tenantId, digest]);
    const r = rows[0];
    return r
      ? { tenantId: r.tenant_id, digest: r.digest, sizeBytes: r.size_bytes, mediaType: r.media_type, sensitivity: r.sensitivity, storageKey: r.storage_key, storedAt: (r.stored_at as Date).toISOString(), retainUntil: (r.retain_until as Date).toISOString() }
      : null;
  }

  async redactions(tenantId: string, digests?: string[]): Promise<RedactionRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM redactions WHERE tenant_id = $1${digests ? ' AND digest = ANY($2)' : ''} ORDER BY entry_seq`,
      digests ? [tenantId, digests] : [tenantId],
    );
    return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, digest: r.digest, requestId: r.request_id, reason: r.reason, requestedBy: r.requested_by, entrySeq: Number(r.entry_seq), redactedAt: (r.redacted_at as Date).toISOString() }));
  }

  async packs(tenantId: string, opts: { limit: number; before?: string | undefined }): Promise<PackRow[]> {
    const params: unknown[] = [tenantId];
    let sql = `SELECT p.*, b.status, b.entry_count, b.artifact_ref, b.digest, b.signature, b.size_bytes, b.duration_ms, b.error, b.entry_seq, b.built_at
               FROM evidence_packs p LEFT JOIN evidence_pack_builds b ON b.pack_id = p.id WHERE p.tenant_id = $1`;
    if (opts.before) sql += ` AND p.requested_at < $${params.push(opts.before)}`;
    sql += ` ORDER BY p.requested_at DESC LIMIT $${params.push(opts.limit)}`;
    const { rows } = await this.pool.query(sql, params);
    return rows.map(toPack);
  }

  async pack(tenantId: string, id: string): Promise<PackRow | null> {
    const { rows } = await this.pool.query(
      `SELECT p.*, b.status, b.entry_count, b.artifact_ref, b.digest, b.signature, b.size_bytes, b.duration_ms, b.error, b.entry_seq, b.built_at
       FROM evidence_packs p LEFT JOIN evidence_pack_builds b ON b.pack_id = p.id WHERE p.tenant_id = $1 AND p.id = $2`,
      [tenantId, id],
    );
    return rows[0] ? toPack(rows[0]) : null;
  }

  async replay(tenantId: string, id: string): Promise<ReplayRow | null> {
    const { rows } = await this.pool.query(`SELECT * FROM replay_runs WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    return rows[0] ? toReplay(rows[0]) : null;
  }

  async replays(tenantId: string, actionId: string): Promise<ReplayRow[]> {
    const { rows } = await this.pool.query(`SELECT * FROM replay_runs WHERE tenant_id = $1 AND action_id = $2 ORDER BY created_at DESC LIMIT 50`, [tenantId, actionId]);
    return rows.map(toReplay);
  }

  async lastVerification(tenantId: string): Promise<{ ok: boolean; entries: number; headSeq: number | null; detail: Record<string, unknown>; checkedAt: string } | null> {
    const { rows } = await this.pool.query(`SELECT * FROM chain_verifications WHERE tenant_id = $1 ORDER BY checked_at DESC LIMIT 1`, [tenantId]);
    const r = rows[0];
    return r ? { ok: r.ok, entries: Number(r.entries), headSeq: r.head_seq === null ? null : Number(r.head_seq), detail: r.detail_json, checkedAt: (r.checked_at as Date).toISOString() } : null;
  }
}

function toPack(r: Record<string, unknown>): PackRow {
  return {
    id: r['id'] as string,
    tenantId: r['tenant_id'] as string,
    query: r['query_json'] as Record<string, unknown>,
    requestedBy: r['requested_by'] as string,
    includeBodies: r['include_bodies'] as boolean,
    requestedAt: (r['requested_at'] as Date).toISOString(),
    expiresAt: r['expires_at'] ? (r['expires_at'] as Date).toISOString() : null,
    build: r['status']
      ? {
          packId: r['id'] as string,
          tenantId: r['tenant_id'] as string,
          status: r['status'] as 'built' | 'failed',
          entryCount: r['entry_count'] as number | null,
          artifactRef: r['artifact_ref'] as string | null,
          digest: r['digest'] as string | null,
          signature: r['signature'] as string | null,
          sizeBytes: r['size_bytes'] as number | null,
          durationMs: r['duration_ms'] as number,
          error: r['error'] as string | null,
          entrySeq: r['entry_seq'] === null ? null : Number(r['entry_seq']),
          builtAt: (r['built_at'] as Date).toISOString(),
        }
      : null,
  };
}

function toReplay(r: Record<string, unknown>): ReplayRow {
  return {
    id: r['id'] as string,
    tenantId: r['tenant_id'] as string,
    actionId: r['action_id'] as string,
    entrySeq: Number(r['entry_seq']),
    originalDigest: r['original_digest'] as string,
    replayDigest: r['replay_digest'] as string,
    matched: r['matched'] as boolean,
    layers: r['layers_json'],
    divergence: r['divergence_json'],
    requestedBy: r['requested_by'] as string,
    createdAt: (r['created_at'] as Date).toISOString(),
  };
}
