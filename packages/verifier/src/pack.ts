import { digestBytes, digestOf, entryHash, GENESIS, payloadDigest, unhex } from './hash.js';
import { leafHash, verifyConsistency, verifyInclusion } from './merkle.js';
import { entryMessage, keyCovers, manifestMessage, treeHeadMessage, verifySignature, type PublicKeyRecord } from './sign.js';

/** The evidence pack format, version 1 (docs/module7.md §5.6). */
export const PACK_FORMAT = 'vega-evidence-pack/1';

export interface ChainEntry {
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

/** A signed tree head: the anchor that proves the log as it stood at `treeSize`. */
export interface TreeHead {
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

export interface Redaction {
  digest: string;
  requestId: string;
  redactedAt: string;
  /** The chain entry (kind `redaction`) that recorded it — redactions are themselves evidence. */
  entrySeq: number;
}

export interface Manifest {
  format: typeof PACK_FORMAT;
  packId: string;
  tenantId: string;
  tenantSlug: string;
  query: Record<string, unknown>;
  builtAt: string;
  entryCount: number;
  /** Inclusive seq ranges of the entries in entries.jsonl, ascending. */
  seqRanges: Array<[number, number]>;
  /** The tree head every inclusion proof is against (the newest in anchors.json). */
  anchor: { treeSize: number; rootHash: string };
  /** Every other file of the pack → its digest. */
  files: Record<string, string>;
  keyId: string;
  signature: string;
}

export type CheckId = 'manifest' | 'files' | 'keys' | 'sequence' | 'hashes' | 'signatures' | 'chain' | 'anchors' | 'inclusion' | 'consistency' | 'redactions' | 'content' | 'published';
export interface Check {
  id: CheckId;
  status: 'ok' | 'warn' | 'fail';
  label: string;
  detail?: string;
}
export interface Report {
  verified: boolean;
  checks: Check[];
  entries: number;
  firstSeq: number | null;
  lastSeq: number | null;
}

export interface VerifyOptions {
  /** Keys obtained independently (from /.well-known/vega/keys). Without them, the pack's own keys are used — and said so. */
  trustedKeys?: PublicKeyRecord[];
  /** Tree heads obtained independently (from /.well-known/vega/anchors/<tenant>). */
  publishedAnchors?: TreeHead[];
}

const decoder = new TextDecoder();
const text = (b: Uint8Array | undefined) => (b ? decoder.decode(b) : undefined);
const json = <T>(files: Map<string, Uint8Array>, path: string): T | undefined => {
  const t = text(files.get(path));
  return t === undefined ? undefined : (JSON.parse(t) as T);
};
const fmt = (n: number) => n.toLocaleString('en-US');
const expand = (ranges: Array<[number, number]>) => ranges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));

/** Every sha256 digest an entry's payload references (the content it commits to). */
export function referencedDigests(payload: unknown, out = new Set<string>()): Set<string> {
  if (typeof payload === 'string') {
    if (/^sha256:[0-9a-f]{64}$/.test(payload)) out.add(payload);
  } else if (Array.isArray(payload)) payload.forEach((v) => referencedDigests(v, out));
  else if (payload && typeof payload === 'object') Object.values(payload).forEach((v) => referencedDigests(v, out));
  return out;
}

/**
 * Verifies a pack completely offline. Nothing here makes a network call: a verifier that phones
 * home is not independent verification (docs/module7.md §5.8).
 */
export function verifyPack(files: Map<string, Uint8Array>, opts: VerifyOptions = {}): Report {
  const checks: Check[] = [];
  const add = (id: CheckId, status: Check['status'], label: string, detail?: string) => checks.push({ id, status, label, ...(detail ? { detail } : {}) });
  const done = (entries: ChainEntry[] = []): Report => ({
    verified: checks.every((c) => c.status !== 'fail'),
    checks,
    entries: entries.length,
    firstSeq: entries[0]?.seq ?? null,
    lastSeq: entries.at(-1)?.seq ?? null,
  });

  // ------------------------------------------------------------------ keys
  let manifest: Manifest | undefined;
  let packKeys: PublicKeyRecord[];
  try {
    manifest = json<Manifest>(files, 'manifest.json');
    packKeys = json<{ keys: PublicKeyRecord[] }>(files, 'keys.json')?.keys ?? [];
  } catch (e) {
    add('manifest', 'fail', 'Manifest unreadable', (e as Error).message);
    return done();
  }
  if (!manifest || manifest.format !== PACK_FORMAT) {
    add('manifest', 'fail', 'Not a VEGA evidence pack', `expected format ${PACK_FORMAT}`);
    return done();
  }
  let keys = packKeys;
  if (opts.trustedKeys) {
    const trusted = new Map(opts.trustedKeys.map((k) => [k.keyId, k]));
    const substituted = packKeys.filter((k) => trusted.get(k.keyId)?.publicKey !== k.publicKey);
    if (substituted.length) add('keys', 'fail', 'Pack keys do not match the published keys', `not published: ${substituted.map((k) => k.keyId).join(', ')}`);
    else add('keys', 'ok', 'Signing keys match the published keys', `${packKeys.length} key(s)`);
    keys = opts.trustedKeys;
  } else {
    add('keys', 'warn', 'Signing keys taken from the pack itself', 'pass --keys (from /.well-known/vega/keys) to pin them independently');
  }
  const keyById = new Map(keys.map((k) => [k.keyId, k]));

  // ------------------------------------------------------------------ manifest and files
  const mk = keyById.get(manifest.keyId);
  if (mk && verifySignature(manifest.signature, manifestMessage(manifest as unknown as Record<string, unknown>), mk)) add('manifest', 'ok', 'Manifest signature valid', `key ${manifest.keyId}`);
  else add('manifest', 'fail', 'Manifest signature INVALID', mk ? `key ${manifest.keyId}` : `unknown key ${manifest.keyId}`);

  const badFiles: string[] = [];
  for (const [path, d] of Object.entries(manifest.files)) {
    const bytes = files.get(path);
    if (!bytes || digestOf(bytes) !== d) badFiles.push(path);
  }
  const unlisted = [...files.keys()].filter((p) => p !== 'manifest.json' && !(p in manifest!.files) && !p.endsWith('/'));
  if (badFiles.length || unlisted.length) add('files', 'fail', 'Pack files do not match the manifest', [badFiles.length ? `changed or missing: ${badFiles.join(', ')}` : '', unlisted.length ? `not in the manifest: ${unlisted.join(', ')}` : ''].filter(Boolean).join('; '));
  else add('files', 'ok', 'Every file matches its manifest digest', `${Object.keys(manifest.files).length} files`);

  // ------------------------------------------------------------------ entries
  let entries: ChainEntry[];
  try {
    entries = (text(files.get('entries.jsonl')) ?? '')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as ChainEntry);
  } catch (e) {
    add('sequence', 'fail', 'entries.jsonl unreadable', (e as Error).message);
    return done();
  }

  const expected = expand(manifest.seqRanges);
  const got = entries.map((e) => e.seq);
  const ascending = got.every((s, i) => i === 0 || s > got[i - 1]!);
  if (!ascending) add('sequence', 'fail', 'Entries are out of order or duplicated');
  else if (got.length !== expected.length || got.some((s, i) => s !== expected[i]) || manifest.entryCount !== got.length) {
    const missing = expected.filter((s) => !got.includes(s));
    const extra = got.filter((s) => !expected.includes(s));
    add('sequence', 'fail', 'Entries differ from the signed manifest', [missing.length ? `missing seq ${missing.slice(0, 10).join(', ')}` : '', extra.length ? `unexpected seq ${extra.slice(0, 10).join(', ')}` : ''].filter(Boolean).join('; ') || 'count differs');
  } else {
    const contiguous = manifest.seqRanges.length === 1;
    add('sequence', 'ok', `${fmt(got.length)} entries, ${contiguous ? 'sequence complete' : `${manifest.seqRanges.length} ranges as signed`}`, got.length ? `seq ${fmt(got[0]!)} → ${fmt(got.at(-1)!)}${contiguous ? ', no gaps' : ''}` : undefined);
  }

  const badHash: number[] = [];
  const badSig: number[] = [];
  for (const e of entries) {
    try {
      if (payloadDigest(e.payload) !== e.payloadDigest || entryHash(e, e.prevHash, manifest.tenantId, e.seq) !== e.entryHash) badHash.push(e.seq);
    } catch {
      badHash.push(e.seq);
    }
    const k = keyById.get(e.keyId);
    if (!k || !keyCovers(k, e.ts) || !verifySignature(e.signature, entryMessage(e.entryHash), k)) badSig.push(e.seq);
  }
  add('hashes', badHash.length ? 'fail' : 'ok', badHash.length ? `${badHash.length} entries do not hash to their entry_hash` : 'Every entry hashes to its entry_hash', badHash.length ? `seq ${badHash.slice(0, 10).join(', ')}` : undefined);
  add('signatures', badSig.length ? 'fail' : 'ok', badSig.length ? `${badSig.length} signatures INVALID` : `${fmt(entries.length)} signatures valid`, badSig.length ? `seq ${badSig.slice(0, 10).join(', ')}` : undefined);

  const broken: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.seq === 1 && e.prevHash !== GENESIS) broken.push(e.seq);
    const prev = entries[i - 1];
    if (prev && prev.seq === e.seq - 1 && e.prevHash !== prev.entryHash) broken.push(e.seq);
  }
  add('chain', broken.length ? 'fail' : 'ok', broken.length ? 'Hash chain BROKEN' : 'Hash chain intact', broken.length ? `at seq ${broken.slice(0, 10).join(', ')}` : undefined);

  // ------------------------------------------------------------------ anchors and proofs
  const anchors = (json<{ anchors: TreeHead[] }>(files, 'anchors.json')?.anchors ?? []).slice().sort((a, b) => a.treeSize - b.treeSize);
  const badAnchors = anchors.filter((a) => {
    const k = keyById.get(a.keyId);
    return a.tenantId !== manifest!.tenantId || a.chainHeadSeq !== a.treeSize || !k || !verifySignature(a.signature, treeHeadMessage(a as unknown as Record<string, unknown>), k);
  });
  const head = anchors.at(-1);
  const headMatches = head && head.treeSize === manifest.anchor.treeSize && head.rootHash === manifest.anchor.rootHash;
  const headEntry = head ? entries.find((e) => e.seq === head.chainHeadSeq) : undefined;
  if (!head) add('anchors', 'fail', 'No signed tree head in the pack');
  else if (badAnchors.length) add('anchors', 'fail', `${badAnchors.length} tree heads INVALID`, `tree sizes ${badAnchors.map((a) => a.treeSize).join(', ')}`);
  else if (!headMatches) add('anchors', 'fail', 'The manifest names a different tree head');
  else if (headEntry && headEntry.entryHash !== head.chainHeadHash) add('anchors', 'fail', 'Tree head does not match the chain head entry', `seq ${head.chainHeadSeq}`);
  else add('anchors', 'ok', `${anchors.length} signed tree head${anchors.length === 1 ? '' : 's'} valid`, `latest: ${fmt(head.treeSize)} entries at ${head.anchoredAt}`);

  if (head) {
    const inc = json<{ treeSize: number; rootHash: string; proofs: Record<string, string[]> }>(files, 'proofs/inclusion.json');
    const root = digestBytes(head.rootHash);
    const failed: number[] = [];
    for (const e of entries) {
      const proof = inc?.proofs[String(e.seq)];
      let ok = false;
      try {
        ok = !!proof && inc!.treeSize === head.treeSize && verifyInclusion(leafHash(digestBytes(e.entryHash)), e.seq - 1, head.treeSize, proof.map(unhex), root);
      } catch {
        ok = false;
      }
      if (!ok) failed.push(e.seq);
    }
    add('inclusion', failed.length ? 'fail' : 'ok', failed.length ? `${failed.length} inclusion proofs INVALID` : 'Inclusion proofs valid', failed.length ? `seq ${failed.slice(0, 10).join(', ')}` : `every entry is in the log of ${fmt(head.treeSize)}`);

    const cons = json<{ proofs: Array<{ fromSize: number; toSize: number; proof: string[] }> }>(files, 'proofs/consistency.json')?.proofs ?? [];
    const pairs = anchors.slice(1).map((to, i) => [anchors[i]!, to] as const);
    const badPairs = pairs.filter(([from, to]) => {
      const p = cons.find((c) => c.fromSize === from.treeSize && c.toSize === to.treeSize);
      try {
        return !p || !verifyConsistency(from.treeSize, to.treeSize, p.proof.map(unhex), digestBytes(from.rootHash), digestBytes(to.rootHash));
      } catch {
        return true;
      }
    });
    if (!pairs.length) add('consistency', 'ok', 'One tree head: no consistency proof needed');
    else add('consistency', badPairs.length ? 'fail' : 'ok', badPairs.length ? 'Consistency between anchors NOT proven' : `Consistency with ${pairs.length} earlier anchor${pairs.length === 1 ? '' : 's'} confirmed`, badPairs.length ? badPairs.map(([a, b]) => `${a.treeSize}→${b.treeSize}`).join(', ') : `back to ${anchors[0]!.anchoredAt}`);

    if (opts.publishedAnchors) {
      const same = opts.publishedAnchors.find((a) => a.tenantId === head.tenantId && a.treeSize === head.treeSize);
      if (!same) add('published', 'warn', 'The pack’s tree head is not in the published list you supplied', `tree size ${head.treeSize}`);
      else add('published', same.rootHash === head.rootHash ? 'ok' : 'fail', same.rootHash === head.rootHash ? 'Tree head matches the published anchor' : 'Tree head DIFFERS from the published anchor');
    }
  }

  // ------------------------------------------------------------------ redactions and content
  const redactions = json<{ redactions: Redaction[] }>(files, 'redactions.json')?.redactions ?? [];
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  const forged = redactions.filter((r) => {
    const e = bySeq.get(r.entrySeq);
    return !e || e.kind !== 'redaction' || e.payload['digest'] !== r.digest || e.payload['requestId'] !== r.requestId || e.ts !== r.redactedAt;
  });
  const redacted = new Set(redactions.map((r) => r.digest));
  if (forged.length) add('redactions', 'fail', `${forged.length} redaction records do not match their chain entries`, forged.map((r) => r.digest.slice(0, 20)).join(', '));

  const redactedEntries = new Set<number>();
  for (const e of entries) {
    if (e.kind === 'redaction') continue;
    for (const d of referencedDigests(e.payload)) {
      if (redacted.has(d)) redactedEntries.add(e.seq);
    }
  }
  const badContent: string[] = [];
  let included = 0;
  for (const [path, bytes] of files) {
    if (!path.startsWith('content/') || path.endsWith('/')) continue;
    included++;
    const d = `sha256:${path.slice('content/'.length)}`;
    if (digestOf(bytes) !== d) badContent.push(path);
    if (redacted.has(d)) badContent.push(`${path} (redacted, yet present)`);
  }
  add('content', badContent.length ? 'fail' : 'ok', badContent.length ? 'Content does not match its digest' : `${included} content object${included === 1 ? '' : 's'} match their digests`, badContent.length ? badContent.join(', ') : undefined);
  if (!forged.length) {
    if (redactedEntries.size) add('redactions', 'warn', `${redactedEntries.size} entr${redactedEntries.size === 1 ? 'y has' : 'ies have'} redacted content`, 'digests still verify');
    else add('redactions', 'ok', redactions.length ? 'Redaction records match their chain entries' : 'No redactions');
  }
  return done(entries);
}

/** The report as the CLI prints it. */
export function formatReport(r: Report): string {
  const icon = { ok: '✓', warn: '⚠', fail: '✗' } as const;
  const width = Math.max(...r.checks.map((c) => c.label.length)) + 3;
  const lines = r.checks.map((c) => `  ${icon[c.status]} ${c.detail ? c.label.padEnd(width) + `(${c.detail})` : c.label}`);
  return `\n${lines.join('\n')}\n\n  ${r.verified ? 'VERIFIED' : 'NOT VERIFIED'}\n`;
}
