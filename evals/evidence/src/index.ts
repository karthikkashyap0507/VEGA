import { createHash, randomUUID } from 'node:crypto';
import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';
import pg from 'pg';
import { EvidenceReader, EvidenceWriter, migrateEvidence } from '@vega/db/evidence';
import { MemoryObjectStore } from '@vega/objectstore';
import { readZip, verifyPack } from '@vega/verifier';
import { Anchorer, chainHash, ChainService, ContentStore, facetsOf, GENESIS_HASH, jcs, LocalKeyCustody, MerkleTree, messages, PackBuilder, sha256 } from '@vega/service-evidence';

/**
 * THE EVIDENCE LOAD EVAL (docs/module7.md §11 "pack build performance", §12 "< 60 s for a
 * 12-month single-client query", §13 "measure p99" for signing in the hot path).
 *
 *   1  a tenant's chain spanning 12 months — real entries: JCS, chained hashes, ML-DSA-65
 *      signatures (in worker threads: generation is not what is measured), monthly anchors
 *   2  pack build for one client over the 12 months: entries, a fresh anchor over the whole
 *      log, an inclusion proof per entry, consistency to the bracketing anchors, the bundled
 *      verifier, signed manifest, zip → measured end to end
 *   3  the pack verified offline by the published verifier → measured
 *   4  the append hot path (lock → head → hash → sign → insert → commit), p50 / p99
 */

export const DEV_SEED = createHash('sha256').update('vega-evidence-dev-signing-key').digest('hex');
export const DEV_KEY_ID = 'vega-evidence-dev';
const CLIENT = 'client-8812@acme-client.example';

export interface LoadOptions {
  ownerUrl: string;
  writerUrl: string;
  readerUrl: string;
  /** Entries in the chain (pre + post receipts and other kinds). */
  entries: number;
  /** Fraction of actions that concern the one client the pack is about. */
  clientShare: number;
  months?: number;
  appendSamples?: number;
  log?: (msg: string) => void;
}

export interface LoadReport {
  entries: number;
  clientEntries: number;
  months: number;
  generateMs: number;
  pack: { buildMs: number; entries: number; bytes: number; verified: boolean; verifyMs: number; failures: string[] };
  append: { samples: number; p50Ms: number; p99Ms: number; maxMs: number };
  targetMs: number;
  passed: boolean;
}

class Signers {
  private readonly workers: Worker[];
  private next = 0;
  private seq = 0;
  private readonly waiting = new Map<number, (sigs: string[]) => void>();
  constructor(n: number, seedHex: string) {
    this.workers = Array.from({ length: n }, () => {
      const w = new Worker(new URL('./sign-worker.mjs', import.meta.url), { workerData: { seedHex } });
      w.on('message', (m: { id: number; sigs: string[] }) => {
        this.waiting.get(m.id)?.(m.sigs);
        this.waiting.delete(m.id);
      });
      return w;
    });
  }
  sign(hashes: string[]): Promise<string[]> {
    const id = ++this.seq;
    const w = this.workers[this.next++ % this.workers.length]!;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      w.postMessage({ id, hashes });
    });
  }
  async close() {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

function payloadFor(i: number, client: boolean, runNo: number): { kind: string; payload: Record<string, unknown> } {
  const pre = i % 2 === 0;
  const action = `act-${runNo}-${Math.floor(i / 2)}`;
  const tools = ['gmail.send', 'gmail.draft', 'gcal.create', 'gdrive.share', 'slack.post'];
  const tool = tools[i % tools.length]!;
  const subjects = client ? [CLIENT, '@acme-client.example'] : [`person-${i % 997}@other-${i % 89}.example`];
  const base = {
    receipt_version: 1,
    phase: pre ? 'pre' : 'post',
    action_id: action,
    run_id: `run-${runNo}`,
    actor: { principal: `user-${i % 23}`, on_behalf_of: `user-${i % 23}`, agent: `agent-${i % 7}`, agent_version: 3, agent_identity: null },
    tool: { id: tool, connector: tool.split('.')[0], egress: tool === 'gmail.send' ? 'EXTERNAL' : 'INTERNAL', reversibility: tool === 'gmail.send' ? 'R2' : 'R1', idempotency: 'KEYED', decl_version: 1 },
    arguments_digest: sha256(`args-${i}`),
    arg_taint: i % 5 === 0 ? 'UNTRUSTED' : 'TRUSTED',
    inputs_read: [{ source: `gmail:msg_${i % 5000}`, taint: 'UNTRUSTED' }],
    program: { version: 1, digest: sha256(`program-${runNo}`), call_seq: (i % 6) + 1, node_id: `n${i % 6}` },
    model: { id: 'claude-opus-5-5', prompt_version: 'v7' },
    policies_evaluated: [{ id: 'external-send-hold', version: 2, decision: 'ALLOW_WITH_HOLD', citation: null }],
    policy: { decision: tool === 'gmail.send' ? 'ALLOW_WITH_HOLD' : 'ALLOW', evaluation_id: randomUUID(), decided_by: 'external-send-hold', reason: 'held', fail_closed: false, preset: 'balanced', preset_version: 1, bundle_version: 4, bundle_revision: 't@v4', input_digest: sha256(`pi-${i}`) },
    risk: { score: 30 + (i % 60), tier: i % 97 === 0 ? 'CRITICAL' : i % 3 === 0 ? 'HIGH' : 'MEDIUM', weights_version: 2, input_digest: sha256(`ri-${i}`) },
    approval: null,
    hold: tool === 'gmail.send' ? { window_ms: 120000, released: true, revoked: false } : null,
    subjects,
  };
  return { kind: pre ? 'action.pre' : 'action.post', payload: pre ? { ...base, replay_tape_digest: sha256(`tape-${i}`) } : { ...base, outcome: 'COMMITTED', effect_digest: sha256(`effect-${i}`), effect_summary: `${tool} done`, error: null } };
}

/** A tenant's chain over `months`, signed, with one anchor per month. Returns the tenant id. */
export async function generateChain(o: LoadOptions): Promise<{ tenantId: string; clientEntries: number; ms: number }> {
  const t0 = performance.now();
  const tenantId = randomUUID();
  const months = o.months ?? 12;
  const end = Date.now() - 60_000;
  const start = end - months * 30 * 86_400_000;
  const span = end - start;
  const pool = new pg.Pool({ connectionString: o.writerUrl, max: 4 });
  const signers = new Signers(Math.max(2, Math.min(cpus().length - 2, 14)), DEV_SEED);
  const custody = new LocalKeyCustody(DEV_KEY_ID, DEV_SEED);
  const hashes: string[] = [];
  let prev = GENESIS_HASH;
  let clientEntries = 0;
  const BATCH = 1_000;
  try {
    for (let from = 0; from < o.entries; from += BATCH) {
      const rows: Array<{ seq: number; ts: string; kind: string; payload: Record<string, unknown>; entryHash: string; prevHash: string }> = [];
      for (let i = from; i < Math.min(o.entries, from + BATCH); i++) {
        const seq = i + 1;
        const runNo = Math.floor(i / 12);
        const client = (runNo * 2654435761) % 1000 < o.clientShare * 1000; // whole runs concern the client
        const { kind, payload } = payloadFor(i, client, runNo);
        if (client) clientEntries++;
        const ts = new Date(start + Math.floor((span * i) / o.entries)).toISOString();
        const entryHash = chainHash(kind, ts, payload, prev, tenantId, seq);
        rows.push({ seq, ts, kind, payload, entryHash, prevHash: prev });
        prev = entryHash;
        hashes.push(entryHash);
      }
      // Sign this batch across the workers, then one multi-row INSERT.
      const chunks: string[][] = [];
      for (let c = 0; c < rows.length; c += 50) chunks.push(rows.slice(c, c + 50).map((r) => r.entryHash));
      const sigs = (await Promise.all(chunks.map((c) => signers.sign(c)))).flat();
      const values: unknown[] = [];
      const tuples = rows.map((r, j) => {
        const f = facetsOf(r.kind, r.payload);
        const b = values.length;
        values.push(tenantId, r.seq, randomUUID(), r.ts, r.kind, 'execution', JSON.stringify(r.payload), sha256(jcs(r.payload)), r.prevHash, r.entryHash, sigs[j], DEV_KEY_ID, r.seq - 1, f.runId, f.actionId, f.actor, f.agentId, f.toolId, f.riskTier, f.decision, f.outcome, f.subjects ?? []);
        return `(${Array.from({ length: 22 }, (_, k) => `$${b + k + 1}`).join(',')})`;
      });
      await pool.query(
        `INSERT INTO audit_entries (tenant_id, seq, id, ts, kind, source, payload_json, payload_digest, prev_hash, entry_hash, signature, key_id, leaf_index, run_id, action_id, actor, agent_id, tool_id, risk_tier, decision, outcome, subjects) VALUES ${tuples.join(',')}`,
        values,
      );
      if ((from / BATCH) % 10 === 0) o.log?.(`  ${Math.min(o.entries, from + BATCH).toLocaleString('en-US')} / ${o.entries.toLocaleString('en-US')} entries`);
    }
    // Monthly anchors, as the hourly job would have left them (one per month is enough to bracket).
    const tree = new MerkleTree(hashes);
    const writer = new EvidenceWriter(o.writerUrl);
    for (let m = 1; m <= months; m++) {
      const size = Math.floor((o.entries * m) / months);
      const sth = { tenantId, treeSize: size, rootHash: tree.root(size), chainHeadSeq: size, chainHeadHash: hashes[size - 1]!, anchoredAt: new Date(start + (span * m) / months).toISOString(), method: 'published', externalRef: null, keyId: DEV_KEY_ID };
      await writer.insertAnchor({ ...sth, id: randomUUID(), timestampToken: null, signature: await custody.sign(messages.treeHead(sth)) });
    }
    await writer.close();
  } finally {
    await signers.close();
    await pool.end();
  }
  return { tenantId, clientEntries, ms: performance.now() - t0 };
}

const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

export async function runLoad(o: LoadOptions): Promise<LoadReport> {
  await migrateEvidence(o.ownerUrl);
  const writer = new EvidenceWriter(o.writerUrl);
  const reader = new EvidenceReader(o.readerUrl);
  const custody = new LocalKeyCustody(DEV_KEY_ID, DEV_SEED);
  const content = new ContentStore({ store: new MemoryObjectStore(), writer, reader });
  const chain = new ChainService({ writer, reader, custody, content });
  await chain.register();
  try {
    o.log?.(`generating a ${o.months ?? 12}-month chain of ${o.entries.toLocaleString('en-US')} signed entries…`);
    const gen = await generateChain(o);
    o.log?.(`  done in ${(gen.ms / 1000).toFixed(1)} s (${gen.clientEntries.toLocaleString('en-US')} about the client)`);

    // The pack, end to end — with a cold tree cache, as a fresh evidence process would have.
    const anchorer = new Anchorer({ reader, writer, custody });
    const packs = new PackBuilder({ reader, writer, chain, anchorer, content, packs: new MemoryObjectStore() });
    const from = new Date(Date.now() - (o.months ?? 12) * 30 * 86_400_000 - 86_400_000).toISOString();
    o.log?.('building the pack: everything about the client, 12 months…');
    const t0 = performance.now();
    const id = await packs.request({ tenantId: gen.tenantId, tenantSlug: 'load-test', query: { subject: CLIENT, from }, requestedBy: 'eval', includeBodies: false });
    await packs.wait(id);
    const buildMs = performance.now() - t0;
    const row = (await reader.pack(gen.tenantId, id))!;
    if (row.build?.status !== 'built') throw new Error(`pack build failed: ${row.build?.error}`);
    const zip = (await packs.download(row))!;
    o.log?.(`  built in ${(buildMs / 1000).toFixed(1)} s — ${row.build.entryCount!.toLocaleString('en-US')} entries, ${(zip.length / 1e6).toFixed(1)} MB`);

    const t1 = performance.now();
    const report = verifyPack(readZip(new Uint8Array(zip)), { trustedKeys: await chain.publicKeys() });
    const verifyMs = performance.now() - t1;
    o.log?.(`  verified offline in ${(verifyMs / 1000).toFixed(1)} s: ${report.verified ? 'VERIFIED' : 'NOT VERIFIED'}`);

    // The hot path: one tenant, sequential appends with a receipt-sized payload.
    const hot = randomUUID();
    const lat: number[] = [];
    for (let i = 0; i < (o.appendSamples ?? 300); i++) {
      const { kind, payload } = payloadFor(i, i % 2 === 0, i);
      const a = performance.now();
      await chain.append({ tenantId: hot, source: 'execution', kind, payload });
      lat.push(performance.now() - a);
    }
    const out: LoadReport = {
      entries: o.entries,
      clientEntries: gen.clientEntries,
      months: o.months ?? 12,
      generateMs: Math.round(gen.ms),
      pack: { buildMs: Math.round(buildMs), entries: row.build.entryCount!, bytes: zip.length, verified: report.verified, verifyMs: Math.round(verifyMs), failures: report.checks.filter((c) => c.status === 'fail').map((c) => `${c.label} ${c.detail ?? ''}`) },
      append: { samples: lat.length, p50Ms: +pct(lat, 50).toFixed(1), p99Ms: +pct(lat, 99).toFixed(1), maxMs: +Math.max(...lat).toFixed(1) },
      targetMs: 60_000,
      passed: false,
    };
    out.passed = out.pack.verified && out.pack.buildMs < out.targetMs;
    return out;
  } finally {
    await writer.close();
    await reader.close();
  }
}

export function markdown(r: LoadReport): string {
  return `# Evidence load eval

| | |
|---|---|
| Chain | ${r.entries.toLocaleString('en-US')} signed entries over ${r.months} months (generation ${(r.generateMs / 1000).toFixed(1)} s, not measured) |
| Query | everything about one client, ${r.months} months (${r.clientEntries.toLocaleString('en-US')} entries concern the client) |
| **Pack build** | **${(r.pack.buildMs / 1000).toFixed(1)} s** — target < ${r.targetMs / 1000} s · ${r.pack.entries.toLocaleString('en-US')} entries · ${(r.pack.bytes / 1e6).toFixed(1)} MB |
| Offline verification | ${(r.pack.verifyMs / 1000).toFixed(1)} s — ${r.pack.verified ? 'VERIFIED' : `NOT VERIFIED: ${r.pack.failures.join('; ')}`} |
| Append (lock → sign → commit) | p50 ${r.append.p50Ms} ms · p99 ${r.append.p99Ms} ms · max ${r.append.maxMs} ms (${r.append.samples} sequential appends, one tenant) |
| Result | ${r.passed ? '✅ PASS' : '❌ FAIL'} |
`;
}
