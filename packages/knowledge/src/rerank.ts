import { contentWords } from './embed.js';

/**
 * RERANKING — docs/module9.md §7.2. A cross-encoder scores (query, passage) pairs after fusion.
 * Deployed: bge-reranker via vLLM's `/v1/rerank` (self-hosted, like the embeddings).
 * `LexicalReranker` is the development stand-in: BM25-style term overlap.
 */

export interface Reranker {
  readonly model: string;
  /** One score per passage, higher is better. */
  rerank(query: string, passages: string[]): Promise<number[]>;
}

export class LexicalReranker implements Reranker {
  readonly model = 'dev-lexical';
  async rerank(query: string, passages: string[]): Promise<number[]> {
    const q = [...new Set(contentWords(query))];
    const docs = passages.map((p) => contentWords(p));
    const avg = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, docs.length) || 1;
    const df = new Map(q.map((t) => [t, docs.filter((d) => d.includes(t)).length]));
    return docs.map((d) => {
      let score = 0;
      for (const t of q) {
        const tf = d.filter((w) => w === t).length;
        if (!tf) continue;
        const idf = Math.log(1 + (docs.length - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
        score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.length / avg)));
      }
      return score;
    });
  }
}

export class VllmReranker implements Reranker {
  constructor(private readonly opts: { url: string; model: string; apiKey?: string | undefined; fetchImpl?: typeof fetch }) {}
  get model() {
    return this.opts.model;
  }
  async rerank(query: string, passages: string[]): Promise<number[]> {
    if (!passages.length) return [];
    const res = await (this.opts.fetchImpl ?? fetch)(`${this.opts.url.replace(/\/$/, '')}/v1/rerank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.opts.model, query, documents: passages }),
    });
    if (!res.ok) throw new Error(`reranker answered ${res.status}`);
    const data = (await res.json()) as { results: Array<{ index: number; relevance_score: number }> };
    const out = new Array<number>(passages.length).fill(-Infinity);
    for (const r of data.results) out[r.index] = r.relevance_score;
    return out;
  }
}

export function rerankerFromEnv(env: NodeJS.ProcessEnv): Reranker {
  // `||`, not `??`: .env.example ships `VLLM_RERANKER_URL=` blank, and blank means "the embeddings server".
  const url = env['VLLM_RERANKER_URL'] || env['VLLM_EMBEDDINGS_URL'];
  if (url && env['EMBEDDINGS_DEV'] !== 'true') return new VllmReranker({ url, model: env['RERANKER_MODEL'] ?? 'BAAI/bge-reranker-v2-m3', apiKey: env['VLLM_API_KEY'] });
  return new LexicalReranker();
}

/** Reciprocal Rank Fusion (Cormack et al.): Σ 1 / (k + rank) over the lists an item appears in. */
export function rrf<T extends string>(lists: T[][], k = 60): Array<{ id: T; score: number }> {
  const s = new Map<T, number>();
  for (const list of lists) list.forEach((id, i) => s.set(id, (s.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...s].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
