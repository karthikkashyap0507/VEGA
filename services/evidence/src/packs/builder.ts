import { randomUUID } from 'node:crypto';
import { referencedDigests, writeZip } from '@vega/verifier';
import type { ActionReceipt, PolicyActivatedRecord } from '@vega/contracts';
import type { EntryQuery, EvidenceReader, EvidenceWriter, PackRow, StoredChainEntry } from '@vega/db/evidence';
import type { ObjectStore } from '@vega/objectstore';
import type { Anchorer } from '../anchor.js';
import { toTreeHead } from '../anchor.js';
import { verifierBundle } from '../chain/bundle.js';
import { sha256 } from '../chain/canonical.js';
import { assemblePack, type PackRedaction, type SignedTreeHead, type StoredEntry } from '../chain/pack.js';
import type { ChainService } from '../chain/service.js';
import type { ContentStore } from '../content.js';
import { ContentRedacted } from '../content.js';
import { controlMap, packReadme } from './control-map.js';

/**
 * THE EVIDENCE PACK BUILDER (module7.md §5.6, §8.2). A query becomes a signed archive an auditor
 * verifies offline:
 *
 *   entries matching the query (in sequence)
 *   + the `redaction` entries for any digest they reference that was erased (the verifier
 *     checks each redaction record against its entry)
 *   + the `policy.activated` entries for every bundle in force during the window, whose policy
 *     documents fill `policies/`
 *   → a fresh tree head (anchored now), inclusion proofs for every entry against it, and
 *     consistency proofs back to the anchors that bracket the window
 *   → manifest signed → zip → WORM storage → a `evidence.pack_built` chain entry
 *
 * Target (§12): < 60 s for a 12-month single-client query. The work is linear in the entries
 * plus one Merkle tree over the tenant's log, which the anchorer caches.
 */

export type PackQuery = Omit<EntryQuery, 'tenantId' | 'seqFrom' | 'seqTo'>;

/** Templates (§6.3): the common questions, as queries. */
export const PACK_TEMPLATES = {
  client: { label: 'Everything about this client', needs: 'subject' },
  external_comms: { label: 'All external communications this quarter', query: { kinds: ['action.pre', 'action.post'] } },
  agent: { label: 'All actions by this agent', needs: 'agentId' },
  critical: { label: 'All Critical-tier actions', query: { riskTier: 'CRITICAL' } },
} as const;

const MAX_ENTRIES = 2_000_000;
const MAX_CONTENT_BYTES = 256 * 1024 * 1024;

export interface PackStatus {
  id: string;
  status: 'building' | 'built' | 'failed' | 'interrupted';
  query: Record<string, unknown>;
  requestedBy: string;
  requestedAt: string;
  includeBodies: boolean;
  entryCount: number | null;
  sizeBytes: number | null;
  digest: string | null;
  durationMs: number | null;
  error: string | null;
  builtAt: string | null;
  expiresAt: string | null;
  progress: { stage: string; entries: number } | null;
}

export class PackBuilder {
  private readonly jobs = new Map<string, { stage: string; entries: number; done: Promise<void> }>();

  constructor(
    private readonly deps: {
      reader: EvidenceReader;
      writer: EvidenceWriter;
      chain: ChainService;
      anchorer: Anchorer;
      content: ContentStore;
      /** WORM storage for built packs (S3 Object Lock deployed). */
      packs: ObjectStore;
      publicBase?: string | null;
      log?: { info(o: object, m: string): void; error(o: object, m: string): void };
      now?: () => Date;
      /** Pack downloads expire (§8.2); the artifact itself is retained in WORM. */
      linkTtlMs?: number;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** Starts a build; returns at once with the pack id (`POST /v1/evidence-packs` → a job). */
  async request(input: { tenantId: string; tenantSlug: string; query: PackQuery; requestedBy: string; includeBodies: boolean }): Promise<string> {
    const id = randomUUID();
    const expiresAt = new Date(this.now().getTime() + (this.deps.linkTtlMs ?? 7 * 86_400_000));
    await this.deps.writer.insertPack({ id, tenantId: input.tenantId, query: input.query as Record<string, unknown>, requestedBy: input.requestedBy, includeBodies: input.includeBodies, expiresAt });
    const job = { stage: 'queued', entries: 0, done: Promise.resolve() };
    job.done = this.build(id, input, job).catch((e) => this.deps.log?.error({ err: e, pack_id: id }, 'evidence pack build failed'));
    this.jobs.set(id, job);
    void job.done.finally(() => this.jobs.delete(id));
    return id;
  }

  /** Waits for a build (tests, and the synchronous API used by the load test). */
  async wait(id: string): Promise<void> {
    await this.jobs.get(id)?.done;
  }

  status(row: PackRow): PackStatus {
    const job = this.jobs.get(row.id);
    const b = row.build;
    const stale = !b && !job && this.now().getTime() - Date.parse(row.requestedAt) > 10 * 60_000;
    return {
      id: row.id,
      status: b ? b.status : job ? 'building' : stale ? 'interrupted' : 'building',
      query: row.query,
      requestedBy: row.requestedBy,
      requestedAt: row.requestedAt,
      includeBodies: row.includeBodies,
      entryCount: b?.entryCount ?? null,
      sizeBytes: b?.sizeBytes ?? null,
      digest: b?.digest ?? null,
      durationMs: b?.durationMs ?? null,
      error: b?.error ?? (stale ? 'the build was interrupted (the evidence service restarted); request it again' : null),
      builtAt: b?.builtAt ?? null,
      expiresAt: row.expiresAt,
      progress: job ? { stage: job.stage, entries: job.entries } : null,
    };
  }

  /** The archive's bytes, while its link has not expired. */
  async download(row: PackRow): Promise<Buffer | null> {
    if (!row.build || row.build.status !== 'built' || !row.build.artifactRef) return null;
    if (row.expiresAt && Date.parse(row.expiresAt) < this.now().getTime()) return null;
    return this.deps.packs.get(row.build.artifactRef);
  }

  private async build(id: string, input: { tenantId: string; tenantSlug: string; query: PackQuery; requestedBy: string; includeBodies: boolean }, job: { stage: string; entries: number }): Promise<void> {
    const t0 = performance.now();
    const { reader } = this.deps;
    const tenantId = input.tenantId;
    try {
      // 1 — the entries the query names, in sequence.
      job.stage = 'entries';
      const picked = new Map<number, StoredChainEntry>();
      for await (const batch of reader.scan({ ...input.query, tenantId })) {
        for (const e of batch) picked.set(e.seq, e);
        job.entries = picked.size;
        if (picked.size > MAX_ENTRIES) throw new Error(`the query matches more than ${MAX_ENTRIES} entries; narrow it`);
      }

      // 2 — redactions touching them, with their own entries.
      job.stage = 'redactions';
      const digests = new Set<string>();
      for (const e of picked.values()) referencedDigests(e.payload, digests);
      const redactions = digests.size ? await reader.redactions(tenantId, [...digests]) : [];
      for (const r of redactions) {
        if (!picked.has(r.entrySeq)) {
          const e = await reader.entryBySeq(tenantId, r.entrySeq);
          if (e) picked.set(e.seq, e);
        }
      }

      // 3 — the policy bundles in force during the window: the last activation before it, and every one inside it.
      job.stage = 'policies';
      const activations = await reader.entries({ tenantId, kinds: ['policy.activated'], ...(input.query.to ? { to: input.query.to } : {}) }, { limit: 500, order: 'desc' });
      const fromTs = input.query.from ? new Date(input.query.from).toISOString() : '';
      const before = activations.find((a) => a.ts < fromTs); // newest first: the one in force when the window opened
      const inForce = [...activations.filter((a) => a.ts >= fromTs), ...(before ? [before] : [])];
      for (const a of inForce) picked.set(a.seq, a);
      const policies: Record<string, unknown> = {};
      for (const a of inForce) {
        const rec = a.payload as unknown as PolicyActivatedRecord;
        for (const p of rec.policies ?? []) {
          const doc = await this.deps.content.getJson<unknown>(tenantId, p.document_digest).catch(() => null);
          policies[`${p.key}@${p.version}`] = { key: p.key, version: p.version, bundle: rec.version, activatedAt: a.ts, citation: p.citation, document_digest: p.document_digest, document: doc };
        }
      }

      const entries = [...picked.values()].sort((a, b) => a.seq - b.seq);
      job.entries = entries.length;

      // 4 — a fresh head over the whole log, and the anchors that bracket the window.
      job.stage = 'anchoring';
      const head = await this.deps.anchorer.anchor(tenantId);
      if (!head) throw new Error('this tenant has no chain yet');
      const anchors = await this.bracket(tenantId, entries, head);
      const tree = await this.deps.anchorer.tree(tenantId, head.treeSize);

      job.stage = 'proofs';
      const inclusion: Record<string, string[]> = {};
      for (const e of entries) inclusion[String(e.seq)] = tree.inclusion(e.seq - 1, head.treeSize);
      const consistency = anchors.slice(1).map((to, i) => ({ fromSize: anchors[i]!.treeSize, toSize: to.treeSize, proof: tree.consistency(anchors[i]!.treeSize, to.treeSize) }));

      // 5 — approvals, models, content the requester may see.
      job.stage = 'content';
      const approvals: unknown[] = [];
      const models = new Map<string, { model: string; promptVersion: string | null; actions: number }>();
      for (const e of entries) {
        if (e.kind === 'approval') approvals.push({ seq: e.seq, ts: e.ts, ...e.payload });
        if (e.kind !== 'action.pre') continue;
        const r = e.payload as unknown as ActionReceipt;
        if (r.approval?.required) approvals.push({ seq: e.seq, ts: e.ts, action_id: r.action_id, run_id: r.run_id, tool: r.tool?.id, policy: r.policy?.decision ?? null, ...r.approval });
        if (r.model?.id) {
          const k = `${r.model.id}|${r.model.prompt_version ?? ''}`;
          const m = models.get(k) ?? { model: r.model.id, promptVersion: r.model.prompt_version ?? null, actions: 0 };
          m.actions++;
          models.set(k, m);
        }
      }
      const redacted = new Set(redactions.map((r) => r.digest));
      const content = new Map<string, Buffer>();
      let contentBytes = 0;
      for (const d of digests) {
        if (redacted.has(d) || contentBytes > MAX_CONTENT_BYTES) continue;
        const meta = await this.deps.content.meta(tenantId, d);
        if (!meta || (meta.sensitivity === 'body' && !input.includeBodies)) continue;
        try {
          const bytes = await this.deps.content.get(tenantId, d);
          if (bytes) {
            content.set(d, bytes);
            contentBytes += bytes.length;
          }
        } catch (e) {
          if (!(e instanceof ContentRedacted)) throw e;
        }
      }

      // 6 — assemble, sign, store.
      job.stage = 'assembling';
      const counts: Record<string, number> = {};
      for (const e of entries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
      const builtAt = this.now().toISOString();
      const packRedactions: PackRedaction[] = redactions.map((r) => ({ digest: r.digest, requestId: r.requestId, redactedAt: r.redactedAt, entrySeq: r.entrySeq }));
      const { files, manifest, digest } = await assemblePack(
        {
          packId: id,
          tenantId,
          tenantSlug: input.tenantSlug,
          query: input.query as Record<string, unknown>,
          builtAt,
          entries: entries.map(toPackEntry),
          anchors,
          inclusion,
          consistency,
          keys: await this.deps.chain.publicKeys(),
          redactions: packRedactions,
          content,
          policies,
          approvals,
          models: { models: [...models.values()], note: 'Model and prompt versions pinned per run (PROJECT.md invariant 7).' },
          controlMap: controlMap({ tenantSlug: input.tenantSlug, query: input.query as Record<string, unknown>, counts, builtAt }),
          readme: packReadme({ tenantSlug: input.tenantSlug, packId: id, entryCount: entries.length, builtAt, publicBase: this.deps.publicBase ?? null }),
          verifier: await verifierBundle(),
        },
        this.deps.chain.custody,
      );
      job.stage = 'storing';
      const zip = Buffer.from(writeZip(new Map([...files].map(([k, v]) => [k, new Uint8Array(v)]))));
      const ref = `packs/${tenantId}/${id}.zip`;
      await this.deps.packs.put(ref, zip, 'application/zip');
      const durationMs = Math.round(performance.now() - t0);
      // Every build is itself an audit entry (§10 "pack access").
      const built = await this.deps.chain.append({
        tenantId,
        source: 'evidence',
        kind: 'evidence.pack_built',
        payload: { packId: id, requestedBy: input.requestedBy, query: input.query as Record<string, unknown>, entryCount: entries.length, manifestDigest: digest, archiveDigest: sha256(zip), includeBodies: input.includeBodies, durationMs },
      });
      await this.deps.writer.insertPackBuild({ packId: id, tenantId, status: 'built', entryCount: entries.length, artifactRef: ref, digest, signature: manifest['signature'] as string, sizeBytes: zip.length, durationMs, error: null, entrySeq: built.seq });
      this.deps.log?.info({ pack_id: id, entries: entries.length, bytes: zip.length, ms: durationMs }, 'evidence pack built');
    } catch (e) {
      const durationMs = Math.round(performance.now() - t0);
      await this.deps.writer
        .insertPackBuild({ packId: id, tenantId, status: 'failed', entryCount: null, artifactRef: null, digest: null, signature: null, sizeBytes: null, durationMs, error: e instanceof Error ? e.message.slice(0, 1000) : String(e), entrySeq: null })
        .catch(() => undefined);
      throw e;
    }
  }

  /**
   * The tree heads a pack carries, oldest first: the first anchor that covered the window's
   * first entry, the first that covered its last, and the head just made. Consistency between
   * them proves the window was not rewritten after it was first anchored.
   */
  private async bracket(tenantId: string, entries: StoredChainEntry[], head: SignedTreeHead): Promise<SignedTreeHead[]> {
    const out = new Map<number, SignedTreeHead>();
    for (const s of [entries[0]?.seq, entries.at(-1)?.seq]) {
      if (s === undefined) continue;
      const [a] = await this.deps.reader.anchors(tenantId, { minSize: s, limit: 1, order: 'asc' });
      if (a && a.treeSize < head.treeSize) out.set(a.treeSize, toTreeHead(a));
    }
    out.set(head.treeSize, head);
    return [...out.values()].sort((a, b) => a.treeSize - b.treeSize);
  }
}

const toPackEntry = (e: StoredChainEntry): StoredEntry => ({
  seq: e.seq,
  ts: e.ts,
  kind: e.kind,
  payload: e.payload,
  payloadDigest: e.payloadDigest,
  prevHash: e.prevHash,
  entryHash: e.entryHash,
  signature: e.signature,
  keyId: e.keyId,
});
