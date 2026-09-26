/**
 * OpenFGA client — a thin, typed wrapper over the HTTP API.
 *
 * Deliberately not @openfga/sdk: the surface we need is six endpoints, and the SDK brings an
 * HTTP stack of its own into every plane that checks permissions. This is small enough to
 * read in one sitting, which is the property that matters for the code deciding who may do
 * what.
 *
 * Every call is pinned to an authorization model id. Checking against "whatever model is
 * latest" means a model deploy silently changes the answer to in-flight checks.
 */

export interface TupleKey {
  user: string;
  relation: string;
  object: string;
}

export interface FgaConfig {
  apiUrl: string;
  storeId: string;
  modelId: string;
  apiToken?: string;
  fetchImpl?: typeof fetch;
}

export class AuthzError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'AuthzError';
  }
}

export interface CheckResult {
  allowed: boolean;
}

async function request<T>(
  cfg: Pick<FgaConfig, 'apiUrl' | 'apiToken' | 'fetchImpl'>,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cfg.apiToken) headers['authorization'] = `Bearer ${cfg.apiToken}`;

  const res = await fetchImpl(new URL(path, cfg.apiUrl), {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  if (!res.ok) {
    const message = (parsed as { message?: string }).message ?? `HTTP ${res.status}`;
    throw new AuthzError(`OpenFGA ${method} ${path}: ${message}`, res.status, parsed);
  }
  return parsed as T;
}

/** Store and model administration. Used by provisioning (OpenTofu, bootstrap, tests). */
export const fgaAdmin = {
  async createStore(cfg: Pick<FgaConfig, 'apiUrl' | 'apiToken' | 'fetchImpl'>, name: string) {
    const r = await request<{ id: string }>(cfg, 'POST', '/stores', { name });
    return r.id;
  },

  async writeModel(
    cfg: Pick<FgaConfig, 'apiUrl' | 'apiToken' | 'fetchImpl'>,
    storeId: string,
    model: unknown,
  ) {
    const r = await request<{ authorization_model_id: string }>(
      cfg,
      'POST',
      `/stores/${storeId}/authorization-models`,
      model,
    );
    return r.authorization_model_id;
  },
};

export class FgaClient {
  constructor(private readonly cfg: FgaConfig) {}

  get modelId(): string {
    return this.cfg.modelId;
  }

  private path(suffix: string): string {
    return `/stores/${this.cfg.storeId}/${suffix}`;
  }

  async check(tuple: TupleKey, contextualTuples: TupleKey[] = []): Promise<boolean> {
    const r = await request<{ allowed?: boolean }>(this.cfg, 'POST', this.path('check'), {
      tuple_key: tuple,
      authorization_model_id: this.cfg.modelId,
      ...(contextualTuples.length ? { contextual_tuples: { tuple_keys: contextualTuples } } : {}),
    });
    return r.allowed === true;
  }

  /**
   * Many checks in one round-trip. An individual check that errors is reported as DENIED —
   * an authorization error is never an implicit allow.
   */
  async batchCheck(tuples: TupleKey[]): Promise<boolean[]> {
    if (tuples.length === 0) return [];
    const r = await request<{ result?: Record<string, { allowed?: boolean; error?: unknown }> }>(
      this.cfg,
      'POST',
      this.path('batch-check'),
      {
        authorization_model_id: this.cfg.modelId,
        checks: tuples.map((t, i) => ({ tuple_key: t, correlation_id: `c${i}` })),
      },
    );
    return tuples.map((_, i) => {
      const entry = r.result?.[`c${i}`];
      return entry?.allowed === true && entry.error === undefined;
    });
  }

  /**
   * Idempotent write: duplicates and missing deletes are ignored, so a retry after a partial
   * failure converges rather than erroring. Chunked to OpenFGA's per-request limit.
   */
  async write(writes: TupleKey[], deletes: TupleKey[] = []): Promise<void> {
    const CHUNK = 100;
    for (let i = 0; i < Math.max(writes.length, deletes.length); i += CHUNK) {
      const w = writes.slice(i, i + CHUNK);
      const d = deletes.slice(i, i + CHUNK);
      if (w.length === 0 && d.length === 0) continue;
      await request(this.cfg, 'POST', this.path('write'), {
        authorization_model_id: this.cfg.modelId,
        ...(w.length ? { writes: { tuple_keys: w, on_duplicate: 'ignore' } } : {}),
        ...(d.length ? { deletes: { tuple_keys: d, on_missing: 'ignore' } } : {}),
      });
    }
  }

  async read(filter: Partial<TupleKey>): Promise<TupleKey[]> {
    const out: TupleKey[] = [];
    let continuation: string | undefined;
    do {
      const r = await request<{
        tuples?: Array<{ key: TupleKey }>;
        continuation_token?: string;
      }>(this.cfg, 'POST', this.path('read'), {
        ...(Object.keys(filter).length ? { tuple_key: filter } : {}),
        page_size: 100,
        ...(continuation ? { continuation_token: continuation } : {}),
      });
      for (const t of r.tuples ?? []) out.push(t.key);
      continuation = r.continuation_token || undefined;
    } while (continuation);
    return out;
  }

  async listObjects(user: string, relation: string, type: string): Promise<string[]> {
    const r = await request<{ objects?: string[] }>(this.cfg, 'POST', this.path('list-objects'), {
      authorization_model_id: this.cfg.modelId,
      user,
      relation,
      type,
    });
    return r.objects ?? [];
  }
}
