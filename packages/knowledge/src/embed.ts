import { createHash } from 'node:crypto';

/**
 * EMBEDDINGS — docs/module9.md §7.3, TECHSTACK §14. Self-hosted: document content never leaves
 * the perimeter to be embedded. Deployed, `VllmEmbedder` calls the vLLM OpenAI-compatible
 * `/v1/embeddings` endpoint serving bge-m3 (1024 dims). `HashingEmbedder` is the deterministic
 * stand-in for development and tests: feature hashing of words and word pairs into the same 1024
 * dimensions — lexical, not semantic, and said so wherever it is used.
 *
 * Both are cached by content digest (the same chunk is never embedded twice).
 */

export const EMBEDDING_DIM = 1024;

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  /** Similarity above which two memories of one class are about the same thing (§6.2). */
  readonly sameTopic: number;
  embed(texts: string[]): Promise<number[][]>;
}

const STOP = new Set('a an and are as at be by for from has have i in is it its of on or that the this to was were will with you your we our they their he she his her my me us do does did not no but if then so than too very can just'.split(' '));

export function words(text: string): string[] {
  return (text.toLowerCase().normalize('NFKD').match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}
export const contentWords = (text: string) => words(text).filter((w) => !STOP.has(w));

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n ? v.map((x) => x / n) : v;
}

export const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

export class HashingEmbedder implements Embedder {
  readonly model = 'dev-hashing-1024';
  readonly dimensions = EMBEDDING_DIM;
  readonly sameTopic = 0.35;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(EMBEDDING_DIM).fill(0);
      const ws = contentWords(t);
      const feats = [...ws, ...ws.slice(1).map((w, i) => `${ws[i]}_${w}`)];
      for (const f of feats) {
        const h = fnv(f);
        v[h % EMBEDDING_DIM]! += h & 0x80000000 ? -1 : 1;
      }
      return normalize(v);
    });
  }
}

export class VllmEmbedder implements Embedder {
  readonly dimensions = EMBEDDING_DIM;
  readonly sameTopic = 0.8;
  constructor(
    private readonly opts: { url: string; model: string; apiKey?: string | undefined; fetchImpl?: typeof fetch; batch?: number },
  ) {}
  get model() {
    return this.opts.model;
  }
  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    const size = this.opts.batch ?? 32;
    for (let i = 0; i < texts.length; i += size) {
      const res = await (this.opts.fetchImpl ?? fetch)(`${this.opts.url.replace(/\/$/, '')}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.opts.model, input: texts.slice(i, i + size) }),
      });
      if (!res.ok) throw new Error(`embedding service answered ${res.status}`);
      const data = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
      for (const d of data.data.sort((a, b) => a.index - b.index)) {
        if (d.embedding.length !== EMBEDDING_DIM) throw new Error(`embedding has ${d.embedding.length} dimensions, expected ${EMBEDDING_DIM}`);
        out.push(normalize(d.embedding));
      }
    }
    return out;
  }
}

/** Caches by content digest; never re-embeds the same text. */
export class CachedEmbedder implements Embedder {
  private readonly cache = new Map<string, number[]>();
  constructor(
    private readonly inner: Embedder,
    private readonly max = 20_000,
  ) {}
  get model() {
    return this.inner.model;
  }
  get dimensions() {
    return this.inner.dimensions;
  }
  get sameTopic() {
    return this.inner.sameTopic;
  }
  async embed(texts: string[]): Promise<number[][]> {
    const key = (t: string) => createHash('sha256').update(`${this.inner.model}\n${t}`).digest('hex');
    const missing = [...new Set(texts.filter((t) => !this.cache.has(key(t))))];
    if (missing.length) {
      const vs = await this.inner.embed(missing);
      missing.forEach((t, i) => this.cache.set(key(t), vs[i]!));
      while (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value as string);
    }
    return texts.map((t) => this.cache.get(key(t))!);
  }
}

/** From the environment: vLLM when VLLM_EMBEDDINGS_URL answers; otherwise the dev stand-in (loudly). */
export function embedderFromEnv(env: NodeJS.ProcessEnv, warn: (m: string) => void = () => undefined): Embedder {
  if (env['VLLM_EMBEDDINGS_URL'] && env['EMBEDDINGS_DEV'] !== 'true') return new CachedEmbedder(new VllmEmbedder({ url: env['VLLM_EMBEDDINGS_URL'], model: env['EMBEDDING_MODEL'] ?? 'BAAI/bge-m3', apiKey: env['VLLM_API_KEY'] }));
  warn('DEV: no VLLM_EMBEDDINGS_URL — the knowledge base and memory use a lexical hashing embedder, not a semantic model');
  return new CachedEmbedder(new HashingEmbedder());
}
