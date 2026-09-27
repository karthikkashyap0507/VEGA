import type { Match, PolicyInput } from './evaluate.js';

/**
 * The OPA client (docs/module5.md §3, §10). Every failure is an exception — a timeout, a
 * non-200, a missing bundle — and the caller turns every exception into DENY. There is no code
 * path in which "OPA did not answer" becomes "allowed".
 */

export class OpaUnavailable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OpaUnavailable';
  }
}

export interface OpaOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** The policy decision is on the critical path of every step (p99 budget 50 ms). */
  timeoutMs?: number;
}

export class OpaClient {
  constructor(private readonly opts: OpaOptions) {}

  private url(path: string) {
    return `${this.opts.baseUrl.replace(/\/$/, '')}${path}`;
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    try {
      return await (this.opts.fetchImpl ?? fetch)(this.url(path), { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 500) });
    } catch (cause) {
      throw new OpaUnavailable(`OPA unreachable at ${this.opts.baseUrl}`, { cause });
    }
  }

  /**
   * `data.<pkg>.matches` for this input. `require` = the package must exist (its bundle is
   * loaded): an activated tenant bundle that OPA has not loaded is an outage, not "no policies".
   */
  async matches(pkg: string, input: PolicyInput, opts: { require?: boolean } = {}): Promise<Match[]> {
    return (await this.query(pkg, input, opts)).matches;
  }

  /**
   * As `matches`, plus OPA's provenance: the revision of every loaded bundle AT THE MOMENT it
   * answered. An evaluation records the bundle that actually decided, not the one the database
   * says should be active (they differ for the seconds OPA takes to poll a new activation).
   */
  async query(pkg: string, input: PolicyInput, opts: { require?: boolean } = {}): Promise<{ matches: Match[]; bundles: Record<string, string> }> {
    const res = await this.call(`/v1/data/${pkg.replace(/\./g, '/')}/matches?provenance=true`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input }) });
    if (res.status !== 200) throw new OpaUnavailable(`OPA answered ${res.status} for ${pkg}`);
    const body = (await res.json()) as { result?: unknown; provenance?: { bundles?: Record<string, { revision?: string }> } };
    const bundles = Object.fromEntries(Object.entries(body.provenance?.bundles ?? {}).map(([k, v]) => [k, v.revision ?? '']));
    if (body.result === undefined) {
      if (opts.require) throw new OpaUnavailable(`policy package ${pkg} is not loaded`);
      return { matches: [], bundles };
    }
    if (!Array.isArray(body.result)) throw new OpaUnavailable(`unexpected result for ${pkg}`);
    return { matches: (body.result as Match[]).sort((a, b) => a.id.localeCompare(b.id)), bundles };
  }

  /**
   * Liveness: OPA answers. Deliberately NOT `?bundles=true`: that would make one tenant's
   * missing bundle take the whole evaluator out of service. Per-tenant correctness is the
   * `require` check on every query (an activated bundle OPA has not loaded fails closed).
   */
  async healthy(): Promise<boolean> {
    try {
      const res = await this.call('/health', { method: 'GET' });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /** Readiness for decisions: OPA answers AND the presets bundle (every tenant's baseline) is loaded. */
  async ready(presetsBundle = 'presets'): Promise<boolean> {
    return Boolean((await this.bundleRevisions().catch(() => ({}) as Record<string, string>))[presetsBundle]);
  }

  /** Revision of each loaded bundle (the `.manifest` revision we set: `<scope>@v<version>`). */
  async bundleRevisions(): Promise<Record<string, string>> {
    const res = await this.call('/v1/data/system/bundles', { method: 'GET' }).catch(() => undefined);
    if (res && res.status === 200) {
      const body = (await res.json()) as { result?: Record<string, { manifest?: { revision?: string } }> };
      return Object.fromEntries(Object.entries(body.result ?? {}).map(([k, v]) => [k, v.manifest?.revision ?? '']));
    }
    return {};
  }

  // ---------------------------------------------------------------- tests and simulation tooling
  async putPolicy(id: string, rego: string): Promise<void> {
    const res = await this.call(`/v1/policies/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: rego });
    if (res.status !== 200) throw new Error(`OPA refused policy ${id}: ${res.status} ${await res.text()}`);
  }

  async deletePolicy(id: string): Promise<void> {
    await this.call(`/v1/policies/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}
