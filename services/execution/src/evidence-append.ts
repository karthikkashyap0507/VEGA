/**
 * The execution plane's ONLY route to the evidence plane: an HTTP POST to /append.
 *
 * Invariant 1: "The execution plane can append to the evidence plane but never read, modify,
 * or delete it." This client has one method. The execution plane has no evidence database
 * credential, no evidence DB import (PLANE-001, no-evidence-write-from-execution), and — in a
 * cluster — no network path to anything but this endpoint.
 *
 * Content (module7.md §4.2) travels with the entry that names it, as base64 bytes the evidence
 * plane digests itself. Content already accepted is not sent again — the client remembers the
 * digests the plane has acknowledged (it never asks: it cannot read).
 */

export interface ContentObject {
  digest: string;
  /** base64 of the exact bytes. */
  data: string;
  mediaType: string;
  sensitivity: 'body' | 'metadata';
}

export interface AppendInput {
  tenantId: string;
  kind: string;
  payload: Record<string, unknown>;
  content?: ContentObject[] | undefined;
}

export interface AppendReceipt {
  id: string;
  receivedAt: string;
  seq?: number;
  entryHash?: string;
}

export class EvidenceAppendClient {
  /** Digests the evidence plane has acknowledged, per tenant (bounded). */
  private readonly stored = new Map<string, true>();

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly maxRemembered = 20_000,
  ) {}

  async append(input: AppendInput): Promise<AppendReceipt> {
    const fresh = (input.content ?? []).filter((c) => !this.stored.has(`${input.tenantId}|${c.digest}`));
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify({
        tenantId: input.tenantId,
        kind: input.kind,
        payload: input.payload,
        source: 'execution',
        ...(fresh.length ? { content: fresh.map((c) => ({ data: c.data, mediaType: c.mediaType, sensitivity: c.sensitivity })) } : {}),
      }),
    });
    if (res.status !== 201) {
      throw new Error(`evidence append failed: HTTP ${res.status}`);
    }
    for (const c of fresh) this.remember(`${input.tenantId}|${c.digest}`);
    return (await res.json()) as AppendReceipt;
  }

  private remember(key: string) {
    this.stored.set(key, true);
    if (this.stored.size > this.maxRemembered) this.stored.delete(this.stored.keys().next().value as string);
  }
}
