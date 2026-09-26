import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { gzipSync } from 'node:zlib';

/**
 * SIGNED OPA BUNDLES (docs/module5.md §4, §10). A bundle is a gzipped tar of Rego modules, data
 * and a `.manifest`, plus `.signatures.json`: a JWT (ES256) over the SHA-256 of every file. OPA
 * is configured with the public key and refuses a bundle whose signature or file hashes do not
 * verify — policy tampering between the control plane and the evaluator is detected there.
 *
 * Distribution is object storage (the bundle's `bundle_ref`): the control plane writes, OPA in
 * the execution plane reads. Neither plane calls the other.
 */

export interface BundleFile {
  path: string;
  content: string;
}

/** OPA hashes JSON files over their canonical form (sorted keys, no whitespace). */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

function fileHash(f: BundleFile): string {
  const bytes = f.path.endsWith('.json') || f.path === '.manifest' ? canonicalJson(JSON.parse(f.content)) : f.content;
  return createHash('sha256').update(bytes).digest('hex');
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** An ES256 JWS in compact form (raw r||s signature, as JOSE requires). */
function jwtES256(payload: unknown, key: KeyObject, kid: string): string {
  const head = b64url(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = cryptoSign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64url(sig)}`;
}

// ---------------------------------------------------------------- a minimal ustar writer
function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(512, 0);
  const put = (s: string, off: number, len: number) => h.write(s, off, len, 'utf8');
  if (Buffer.byteLength(name) > 100) throw new Error(`bundle path too long: ${name}`);
  put(name, 0, 100);
  put('0000644\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  put('00000000000\0', 136, 12); // mtime 0: deterministic bundles
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

export function tarGz(files: BundleFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const data = Buffer.from(f.content, 'utf8');
    parts.push(tarHeader(f.path, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

export interface SigningKey {
  keyId: string;
  privateKey: KeyObject;
}

export function signingKeyFromPem(pem: string, keyId: string): SigningKey {
  return { keyId, privateKey: createPrivateKey(pem) };
}

export function publicPem(key: SigningKey): string {
  return createPublicKey(key.privateKey).export({ type: 'spki', format: 'pem' }).toString();
}

export interface BuiltBundle {
  tarGz: Buffer;
  digest: string;
  signature: string;
  revision: string;
  files: string[];
}

/**
 * Builds a signed bundle: `modules` (path → Rego), optional JSON `data` files, and a manifest
 * with the bundle's roots and revision. Deterministic for the same inputs.
 */
export function buildBundle(input: { roots: string[]; revision: string; modules: BundleFile[]; data?: BundleFile[] }, key: SigningKey): BuiltBundle {
  const manifest: BundleFile = { path: '.manifest', content: JSON.stringify({ revision: input.revision, roots: input.roots }) };
  const content = [...input.modules, ...(input.data ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  const signed = [manifest, ...content];
  const jwt = jwtES256({ files: signed.map((f) => ({ name: f.path, hash: fileHash(f), algorithm: 'SHA-256' })), keyid: key.keyId }, key.privateKey, key.keyId);
  const files = [{ path: '.signatures.json', content: JSON.stringify({ signatures: [jwt] }) }, ...signed];
  const tar = tarGz(files);
  return { tarGz: tar, digest: `sha256:${createHash('sha256').update(tar).digest('hex')}`, signature: jwt, revision: input.revision, files: files.map((f) => f.path) };
}
