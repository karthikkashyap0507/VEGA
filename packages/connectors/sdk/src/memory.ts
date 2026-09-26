import type { ConnectorStatus, Effect } from '@vega/contracts';
import type { ConnectorTokens } from './oauth.js';
import type { ConnectorRecord, ConnectorStore, InvocationClaim, InvocationStore, TokenVault } from './runtime.js';

/** In-memory stores with the same semantics as the Postgres ones. Tests and local sandboxes. */

export class MemoryConnectorStore implements ConnectorStore {
  readonly rows = new Map<string, ConnectorRecord & { health?: Record<string, unknown>; lastOkAt?: Date }>();
  readonly events: Array<{ connectorId: string; kind: string; detail: Record<string, unknown> }> = [];
  domains: string[] = ['acme.example'];

  add(record: ConnectorRecord) {
    this.rows.set(record.id, { ...record });
    return this;
  }
  async get(tenantId: string, id: string) {
    const r = this.rows.get(id);
    return r && r.tenantId === tenantId ? { ...r } : undefined;
  }
  async setStatus(_t: string, id: string, status: ConnectorStatus, health?: Record<string, unknown>) {
    const r = this.rows.get(id);
    if (r) Object.assign(r, { status, ...(health ? { health } : {}) });
  }
  async markOk(_t: string, id: string) {
    const r = this.rows.get(id);
    if (r) r.lastOkAt = new Date();
  }
  async event(_t: string, connectorId: string, kind: string, detail: Record<string, unknown> = {}) {
    this.events.push({ connectorId, kind, detail });
  }
  async internalDomains() {
    return this.domains;
  }
}

export class MemoryTokenVault implements TokenVault {
  readonly secrets = new Map<string, ConnectorTokens>();
  private seq = 0;
  async load(_t: string, id: string) {
    const s = this.secrets.get(id);
    if (!s) throw new Error('connector secret not found');
    return { ...s };
  }
  async save(_t: string, tokens: ConnectorTokens, id?: string) {
    const key = id ?? `secret-${++this.seq}`;
    this.secrets.set(key, { ...tokens });
    return key;
  }
  async delete(_t: string, id: string) {
    this.secrets.delete(id);
  }
}

export class MemoryInvocationStore implements InvocationStore {
  readonly rows = new Map<string, { digest: string; state: 'in_flight' | 'succeeded' | 'failed'; effect?: Effect<unknown>; providerRef?: string }>();
  async claim(input: { tenantId: string; toolId: string; key: string; argsDigest: string }): Promise<InvocationClaim> {
    const k = `${input.tenantId}|${input.toolId}|${input.key}`;
    const prior = this.rows.get(k);
    if (!prior || prior.state === 'failed') {
      this.rows.set(k, { digest: input.argsDigest, state: 'in_flight' });
      return { kind: 'fresh' };
    }
    if (prior.digest !== input.argsDigest) return { kind: 'mismatch' };
    if (prior.state === 'succeeded' && prior.effect) {
      return { kind: 'replay', effect: prior.effect, ...(prior.providerRef ? { providerRef: prior.providerRef } : {}) };
    }
    return { kind: 'in_flight' };
  }
  async succeed(tenantId: string, toolId: string, key: string, effect: Effect<unknown>, providerRef?: string) {
    const r = this.rows.get(`${tenantId}|${toolId}|${key}`);
    if (r) Object.assign(r, { state: 'succeeded', effect, ...(providerRef ? { providerRef } : {}) });
  }
  async fail(tenantId: string, toolId: string, key: string, _code: string, release: boolean) {
    const r = this.rows.get(`${tenantId}|${toolId}|${key}`);
    if (r && release) r.state = 'failed';
  }
}
