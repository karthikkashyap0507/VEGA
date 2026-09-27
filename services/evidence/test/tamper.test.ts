import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyPack, writeZip, type CheckId, type Report } from '@vega/verifier';
import { chainHash, GENESIS_HASH, jcs, sha256 } from '../src/chain/canonical.js';
import { LocalKeyCustody, messages, type KeyCustody, type PublicKey } from '../src/chain/keys.js';
import { MerkleTree } from '../src/chain/merkle.js';
import { verifierBundle } from '../src/chain/bundle.js';
import { assemblePack, type SignedTreeHead, type StoredEntry } from '../src/chain/pack.js';

/**
 * THE VERIFIER MUST REJECT A TAMPERED PACK (module7.md §11.1 — blocking). A verifier that passes
 * a tampered pack is a total product failure; each variant below is a real, signed pack that an
 * attacker then edits, and each must fail on the check that exists to catch it — not merely on
 * some unrelated one.
 */

const TENANT = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const custody = new LocalKeyCustody('vega-evidence-test-2026-Q3', '11'.repeat(32));
const attacker = new LocalKeyCustody('vega-evidence-test-2026-Q3', '99'.repeat(32)); // same id, different key
const KEY: PublicKey = { keyId: custody.keyId, alg: 'ML-DSA-65', publicKey: custody.publicKey, notBefore: '2026-01-01T00:00:00.000Z', notAfter: null };
const secret = Buffer.from('Dear Peter, the numbers are final.');
const kept = Buffer.from('{"subject":"Q3"}');

async function signEntry(c: KeyCustody, seq: number, kind: string, payload: Record<string, unknown>, prevHash: string, ts: string): Promise<StoredEntry> {
  const entryHash = chainHash(kind, ts, payload, prevHash, TENANT, seq);
  return { seq, ts, kind, payload, payloadDigest: sha256(jcs(payload)), prevHash, entryHash, signature: await c.sign(messages.entry(entryHash)), keyId: c.keyId };
}

async function treeHead(c: KeyCustody, tree: MerkleTree, size: number, head: StoredEntry, at: string): Promise<SignedTreeHead> {
  const sth = { tenantId: TENANT, treeSize: size, rootHash: tree.root(size), chainHeadSeq: head.seq, chainHeadHash: head.entryHash, anchoredAt: at, method: 'published', externalRef: null, keyId: c.keyId };
  return { ...sth, signature: await c.sign(messages.treeHead(sth)) };
}

/** A real chain of 12 entries (one redacted body, one redaction record), anchored twice, packed. */
async function build(c: KeyCustody = custody, mutateEntries?: (es: StoredEntry[]) => Promise<StoredEntry[]> | StoredEntry[]) {
  let entries: StoredEntry[] = [];
  let prev = GENESIS_HASH;
  for (let seq = 1; seq <= 12; seq++) {
    const ts = `2026-09-27T10:00:${String(seq).padStart(2, '0')}.000Z`;
    const payload: Record<string, unknown> =
      seq === 3
        ? { action_id: 'act-3', tool: { id: 'gmail.send', reversibility: 'R2' }, arguments_digest: sha256(secret), outcome: 'COMMITTED' }
        : seq === 4
          ? { action_id: 'act-4', tool: { id: 'gcal.create', reversibility: 'R1' }, arguments_digest: sha256(kept) }
          : seq === 11
            ? { digest: sha256(secret), requestId: 'GDPR-2026-0042', reason: 'erasure request' }
            : { action_id: `act-${seq}`, n: seq };
    const e = await signEntry(c, seq, seq === 11 ? 'redaction' : 'action.post', payload, prev, ts);
    entries.push(e);
    prev = e.entryHash;
  }
  if (mutateEntries) entries = await mutateEntries(entries);
  const tree = new MerkleTree(entries.map((e) => e.entryHash));
  const anchors = [await treeHead(c, tree, 5, entries[4]!, '2026-09-27T10:00:05.500Z'), await treeHead(c, tree, entries.length, entries.at(-1)!, '2026-09-27T11:00:00.000Z')];
  const { files } = await assemblePack(
    {
      packId: 'pack-1',
      tenantId: TENANT,
      tenantSlug: 'acme',
      query: { from: '2026-09-01', to: '2026-09-30' },
      builtAt: '2026-09-27T11:00:01.000Z',
      entries,
      anchors,
      inclusion: Object.fromEntries(entries.map((e) => [String(e.seq), tree.inclusion(e.seq - 1)])),
      consistency: [{ fromSize: 5, toSize: entries.length, proof: tree.consistency(5) }],
      keys: [{ ...KEY, publicKey: c.publicKey }],
      redactions: [{ digest: sha256(secret), requestId: 'GDPR-2026-0042', redactedAt: entries[10]!.ts, entrySeq: 11 }],
      content: new Map([[sha256(kept), kept]]),
      policies: { 'external-comms@7': { key: 'external-comms', version: 7 } },
      approvals: [],
      models: { planner: 'dev' },
      controlMap: '# control map\n',
      readme: '# how to verify\n',
      verifier: new Map(),
    },
    c,
  );
  return new Map([...files].map(([k, v]) => [k, new Uint8Array(v)]));
}

const verify = (files: Map<string, Uint8Array>, opts = { trustedKeys: [KEY] }) => verifyPack(files, opts);
const failed = (r: Report) => r.checks.filter((c) => c.status === 'fail').map((c) => c.id);
const lines = (files: Map<string, Uint8Array>) => new TextDecoder().decode(files.get('entries.jsonl')).trim().split('\n').map((l) => JSON.parse(l) as StoredEntry);
const setLines = (files: Map<string, Uint8Array>, es: StoredEntry[]) => files.set('entries.jsonl', new TextEncoder().encode(es.map((e) => JSON.stringify(e)).join('\n') + '\n'));
const setJson = (files: Map<string, Uint8Array>, path: string, v: unknown) => files.set(path, new TextEncoder().encode(JSON.stringify(v)));
const getJson = <T>(files: Map<string, Uint8Array>, path: string) => JSON.parse(new TextDecoder().decode(files.get(path))) as T;

function expectRejected(r: Report, by: CheckId[]) {
  expect(r.verified).toBe(false);
  for (const id of by) expect(failed(r), `expected the ${id} check to fail; failed: ${failed(r).join(', ')}`).toContain(id);
}

describe('an untouched pack verifies offline', () => {
  it('VERIFIED, with the redacted entry reported and its digest still verifying', async () => {
    const r = verify(await build());
    expect(failed(r)).toEqual([]);
    expect(r.verified).toBe(true);
    expect(r.entries).toBe(12);
    expect(r.checks.find((c) => c.id === 'redactions')).toMatchObject({ status: 'warn', label: '1 entry has redacted content' });
    expect(r.checks.find((c) => c.id === 'sequence')!.label).toBe('12 entries, sequence complete');
    expect(r.checks.find((c) => c.id === 'consistency')!.status).toBe('ok');
  });
  it('without independently obtained keys it says so rather than claiming more', async () => {
    const r = verifyPack(await build());
    expect(r.verified).toBe(true);
    expect(r.checks.find((c) => c.id === 'keys')!.status).toBe('warn');
  });
});

describe('§11.1 tamper variants — every one is rejected', () => {
  it('1 · a payload byte modified', async () => {
    const f = await build();
    const es = lines(f);
    es[3]!.payload['arguments_digest'] = sha256('something else');
    setLines(f, es);
    expectRejected(verify(f), ['hashes', 'files']);
  });

  it('2 · entries reordered', async () => {
    const f = await build();
    const es = lines(f);
    [es[4], es[5]] = [es[5]!, es[4]!];
    setLines(f, es);
    expectRejected(verify(f), ['sequence']);
  });

  it('3 · an entry deleted', async () => {
    const f = await build();
    setLines(f, lines(f).filter((e) => e.seq !== 6));
    expectRejected(verify(f), ['sequence', 'files']);
  });

  it('4 · a forged entry inserted (well-formed, chained, signed with a key that is not ours)', async () => {
    const f = await build();
    const es = lines(f);
    const forged = await signEntry(attacker, 13, 'action.post', { action_id: 'never-happened' }, es.at(-1)!.entryHash, '2026-09-27T10:59:00.000Z');
    setLines(f, [...es, forged]);
    expectRejected(verify(f), ['sequence', 'signatures']);
  });

  it('5 · an old signature replayed onto new content (hashes recomputed to match)', async () => {
    const f = await build();
    const es = lines(f);
    const e = es[6]!;
    e.payload = { action_id: 'act-7', n: 7000 };
    e.payloadDigest = sha256(jcs(e.payload));
    e.entryHash = chainHash(e.kind, e.ts, e.payload, e.prevHash, TENANT, e.seq);
    setLines(f, es);
    expectRejected(verify(f), ['signatures']);
  });

  it('6 · a prev_hash altered', async () => {
    const f = await build();
    const es = lines(f);
    es[8]!.prevHash = es[6]!.entryHash;
    setLines(f, es);
    expectRejected(verify(f), ['hashes', 'chain']);
  });

  it('7 · the key substituted (the whole pack re-signed with an attacker key under our key id)', async () => {
    const f = await build(attacker);
    expectRejected(verify(f), ['keys', 'manifest', 'signatures', 'anchors']);
  });

  it('8 · the chain truncated', async () => {
    const f = await build();
    setLines(f, lines(f).slice(0, 9));
    expectRejected(verify(f), ['sequence', 'files']);
  });

  it('8b · a rewritten history re-anchored: the new head is not consistent with the old anchor', async () => {
    // The attacker holds the key (the worst case): rewrites entry 3 and re-signs everything
    // after it. Only the EARLIER published anchor can expose this — and it does.
    const honest = await build();
    const oldAnchor = getJson<{ anchors: Array<Record<string, unknown>> }>(honest, 'anchors.json').anchors[0]!;
    const f = await build(custody, async (es) => {
      const out: StoredEntry[] = es.slice(0, 2);
      for (const e of es.slice(2)) {
        const payload = e.seq === 3 ? { ...e.payload, outcome: 'NEVER_SENT' } : e.payload;
        out.push(await signEntry(custody, e.seq, e.kind, payload, out.at(-1)!.entryHash, e.ts));
      }
      return out;
    });
    const anchors = getJson<{ anchors: Array<Record<string, unknown>> }>(f, 'anchors.json');
    anchors.anchors[0] = oldAnchor; // the anchor the world already saw
    setJson(f, 'anchors.json', anchors);
    expectRejected(verify(f), ['consistency']);
    // and against the published list, independently:
    const published = getJson<{ anchors: Array<Record<string, unknown>> }>(honest, 'anchors.json').anchors;
    const r = verifyPack(await build(custody, async (es) => {
      const out: StoredEntry[] = es.slice(0, 2);
      for (const e of es.slice(2)) out.push(await signEntry(custody, e.seq, e.kind, e.seq === 3 ? { ...e.payload, outcome: 'NEVER_SENT' } : e.payload, out.at(-1)!.entryHash, e.ts));
      return out;
    }), { trustedKeys: [KEY], publishedAnchors: published as never });
    expectRejected(r, ['published']);
  });

  it('9 · an anchor forged', async () => {
    const f = await build();
    const a = getJson<{ anchors: Array<{ rootHash: string }> }>(f, 'anchors.json');
    a.anchors[1]!.rootHash = sha256('a tree that never existed');
    setJson(f, 'anchors.json', a);
    expectRejected(verify(f), ['anchors', 'inclusion']);
  });

  it('10 · a redaction record altered', async () => {
    const f = await build();
    const red = getJson<{ redactions: Array<{ requestId: string }> }>(f, 'redactions.json');
    red.redactions[0]!.requestId = 'GDPR-2026-9999';
    setJson(f, 'redactions.json', red);
    expectRejected(verify(f), ['redactions']);
  });

  it('11 · content swapped for different bytes under the same digest', async () => {
    const f = await build();
    const [path] = [...f.keys()].filter((p) => p.startsWith('content/'));
    f.set(path!, new TextEncoder().encode('{"subject":"Q4"}'));
    expectRejected(verify(f), ['content']);
  });

  it('12 · an inclusion proof altered', async () => {
    const f = await build();
    const inc = getJson<{ proofs: Record<string, string[]> }>(f, 'proofs/inclusion.json');
    inc.proofs['4'] = inc.proofs['5']!;
    setJson(f, 'proofs/inclusion.json', inc);
    expectRejected(verify(f), ['inclusion']);
  });

  it('13 · the consistency proof removed', async () => {
    const f = await build();
    setJson(f, 'proofs/consistency.json', { proofs: [] });
    expectRejected(verify(f), ['consistency']);
  });

  it('14 · a file added that the manifest never listed', async () => {
    const f = await build();
    f.set('approvals/00099.json', new TextEncoder().encode('{"by":"someone"}'));
    expectRejected(verify(f), ['files']);
  });
});

describe('vega-verify, the command an auditor runs', () => {
  const cli = join(process.cwd(), 'packages/verifier/src/cli.ts');
  const run = (args: string[]) => {
    try {
      return { code: 0, out: execFileSync('npx', ['tsx', cli, ...args], { encoding: 'utf8' }) };
    } catch (e) {
      const err = e as { status: number; stdout: string };
      return { code: err.status, out: err.stdout };
    }
  };

  it('verifies a zipped pack offline and exits 0; a tampered one exits 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vega-pack-'));
    writeFileSync(join(dir, 'keys.json'), JSON.stringify({ keys: [KEY] }));
    const good = await build();
    writeFileSync(join(dir, 'pack.zip'), writeZip(good));
    const ok = run([join(dir, 'pack.zip'), '--keys', join(dir, 'keys.json')]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('✓ Manifest signature valid');
    expect(ok.out).toContain('⚠ 1 entry has redacted content');
    expect(ok.out).toMatch(/\n {2}VERIFIED\n/);
    const bad = new Map(good);
    setLines(bad, lines(bad).slice(0, 7));
    writeFileSync(join(dir, 'bad.zip'), writeZip(bad));
    const no = run([join(dir, 'bad.zip'), '--keys', join(dir, 'keys.json')]);
    expect(no.code).toBe(1);
    expect(no.out).toContain('NOT VERIFIED');
  }, 60_000);

  it('the copy bundled in every pack runs with plain Node, outside this repository, and opens no socket', async () => {
    const bundle = await verifierBundle();
    const js = bundle.get('vega-verify.mjs')!.toString('utf8');
    expect(js).not.toMatch(/from ["']node:(?:http|https|net|tls|dgram|dns)["']|require\(["'](?:node:)?(?:http|https|net|tls|dgram|dns)["']\)|\bfetch\(/);
    const dir = mkdtempSync(join(tmpdir(), 'vega-standalone-'));
    writeFileSync(join(dir, 'vega-verify.mjs'), bundle.get('vega-verify.mjs')!);
    writeFileSync(join(dir, 'pack.zip'), writeZip(await build()));
    const out = execFileSync(process.execPath, [join(dir, 'vega-verify.mjs'), join(dir, 'pack.zip')], { encoding: 'utf8', cwd: dir });
    expect(out).toMatch(/\n {2}VERIFIED\n/);
    expect(bundle.get('LICENSE')!.toString()).toContain('Apache License');
  }, 60_000);
});
