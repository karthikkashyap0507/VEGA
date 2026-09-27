import { jcs, sha256 } from './canonical.js';
import { messages, type KeyCustody, type PublicKey } from './keys.js';

/**
 * Assembles an evidence pack (module7.md §5.6) from material the builder has already gathered.
 * Pure: no database, no storage — so the tamper suite builds real, signed packs with it.
 */

export interface StoredEntry {
  seq: number;
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
  payloadDigest: string;
  prevHash: string;
  entryHash: string;
  signature: string;
  keyId: string;
}

export interface SignedTreeHead {
  tenantId: string;
  treeSize: number;
  rootHash: string;
  chainHeadSeq: number;
  chainHeadHash: string;
  anchoredAt: string;
  method: string;
  externalRef?: string | null;
  keyId: string;
  signature: string;
}

export interface PackRedaction {
  digest: string;
  requestId: string;
  redactedAt: string;
  entrySeq: number;
}

export interface PackInput {
  packId: string;
  tenantId: string;
  tenantSlug: string;
  query: Record<string, unknown>;
  builtAt: string;
  entries: StoredEntry[];
  /** Ascending by tree size; the last is the one every inclusion proof is against. */
  anchors: SignedTreeHead[];
  inclusion: Record<string, string[]>;
  consistency: Array<{ fromSize: number; toSize: number; proof: string[] }>;
  keys: PublicKey[];
  redactions: PackRedaction[];
  /** digest → plaintext, for content the requester may see and that is not redacted. */
  content: Map<string, Buffer>;
  policies: Record<string, unknown>;
  approvals: unknown[];
  models: unknown;
  controlMap: string;
  readme: string;
  /** path under verifier/ → bytes (the bundled standalone verifier). */
  verifier: Map<string, Buffer>;
}

export function seqRanges(seqs: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const s of seqs) {
    const last = out.at(-1);
    if (last && s === last[1] + 1) last[1] = s;
    else out.push([s, s]);
  }
  return out;
}

const pretty = (v: unknown) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`);

export async function assemblePack(input: PackInput, custody: KeyCustody): Promise<{ files: Map<string, Buffer>; manifest: Record<string, unknown>; digest: string }> {
  const head = input.anchors.at(-1);
  if (!head) throw new Error('a pack needs a signed tree head');
  const files = new Map<string, Buffer>();
  files.set('entries.jsonl', Buffer.from(input.entries.map((e) => JSON.stringify(e)).join('\n') + (input.entries.length ? '\n' : '')));
  files.set('anchors.json', pretty({ anchors: input.anchors }));
  files.set('keys.json', pretty({ keys: input.keys }));
  files.set('proofs/inclusion.json', pretty({ treeSize: head.treeSize, rootHash: head.rootHash, proofs: input.inclusion }));
  files.set('proofs/consistency.json', pretty({ proofs: input.consistency }));
  files.set('redactions.json', pretty({ redactions: input.redactions }));
  for (const [name, doc] of Object.entries(input.policies)) files.set(`policies/${name}.json`, pretty(doc));
  input.approvals.forEach((a, i) => files.set(`approvals/${String(i + 1).padStart(5, '0')}.json`, pretty(a)));
  files.set('models.json', pretty(input.models));
  files.set('control-map.md', Buffer.from(input.controlMap));
  files.set('README.md', Buffer.from(input.readme));
  for (const [digest, bytes] of input.content) files.set(`content/${digest.replace(/^sha256:/, '')}`, bytes);
  for (const [path, bytes] of input.verifier) files.set(`verifier/${path}`, bytes);

  const listing: Record<string, string> = {};
  for (const [path, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) listing[path] = sha256(bytes);
  const unsigned = {
    format: 'vega-evidence-pack/1',
    packId: input.packId,
    tenantId: input.tenantId,
    tenantSlug: input.tenantSlug,
    query: input.query,
    builtAt: input.builtAt,
    entryCount: input.entries.length,
    seqRanges: seqRanges(input.entries.map((e) => e.seq)),
    anchor: { treeSize: head.treeSize, rootHash: head.rootHash },
    files: listing,
    keyId: custody.keyId,
  };
  const manifest = { ...unsigned, signature: await custody.sign(messages.manifest(unsigned)) };
  files.set('manifest.json', pretty(manifest));
  return { files, manifest, digest: sha256(jcs(manifest)) };
}
