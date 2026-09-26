/**
 * The execution plane's ONLY route to the evidence plane: an HTTP POST to /append.
 *
 * Invariant 1: "The execution plane can append to the evidence plane but never read, modify,
 * or delete it." This client has one method. The execution plane has no evidence database
 * credential, no evidence DB import (PLANE-001, no-evidence-write-from-execution), and — in a
 * cluster — no network path to anything but this endpoint.
 */

export interface AppendInput {
  tenantId: string;
  kind: string;
  payload: Record<string, unknown>;
}

export class EvidenceAppendClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async append(input: AppendInput): Promise<{ id: string; receivedAt: string }> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ ...input, source: 'execution' }),
    });
    if (res.status !== 201) {
      throw new Error(`evidence append failed: HTTP ${res.status}`);
    }
    return (await res.json()) as { id: string; receivedAt: string };
  }
}
