import { createHash, randomUUID } from 'node:crypto';
import type { EvidenceReader, EvidenceWriter, RedactionRow } from '@vega/db/evidence';
import type { ObjectStore } from '@vega/objectstore';

/**
 * THE CONTENT-ADDRESSED STORE (module7.md §4.2, §5.5). Every prompt, program, tool argument,
 * tool result and policy input a receipt commits to is kept here by digest — the bytes replay
 * needs, and the bytes a pack may include. Key = `cas/<tenant>/<sha256 hex>`: deduplicated
 * within a tenant, never across tenants (a cross-tenant hit would leak that another tenant holds
 * the same document).
 *
 * The chain holds digests, never plaintext, which is what lets "immutable audit" and "right to
 * erasure" coexist: a redaction is a chain entry (who, when, under which request), then the
 * plaintext is deleted. The digest stays in every entry that referenced it, and still verifies.
 */

export interface ContentInput {
  /** base64 of the exact bytes the digest is over. */
  data: string;
  mediaType?: string | undefined;
  /** `metadata`: an AUDITOR without `audit.read_bodies` may see it (§10 content access). */
  sensitivity?: 'body' | 'metadata' | undefined;
}

export const digestOfBytes = (b: Uint8Array): string => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const keyOf = (tenantId: string, digest: string) => `cas/${tenantId}/${digest.replace(/^sha256:/, '')}`;

export class ContentRedacted extends Error {
  constructor(readonly redaction: RedactionRow) {
    super(`content ${redaction.digest} was redacted at ${redaction.redactedAt} under ${redaction.requestId}`);
  }
}

export class ContentStore {
  constructor(
    private readonly deps: {
      store: ObjectStore;
      writer: EvidenceWriter;
      reader: EvidenceReader;
      /** Retention floor is 180 days (§4.2); the default keeps a 7-year books-and-records span. */
      retentionDays?: number;
      now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async put(tenantId: string, c: ContentInput): Promise<string> {
    const bytes = Buffer.from(c.data, 'base64');
    const digest = digestOfBytes(bytes);
    const key = keyOf(tenantId, digest);
    // Content-addressed: writing the same key twice writes the same bytes, so a retry is harmless.
    await this.deps.store.put(key, bytes, c.mediaType ?? 'application/octet-stream');
    const days = Math.max(180, this.deps.retentionDays ?? 2_555);
    await this.deps.writer.insertContent({
      tenantId,
      digest,
      sizeBytes: bytes.length,
      mediaType: c.mediaType ?? 'application/octet-stream',
      sensitivity: c.sensitivity ?? 'body',
      storageKey: key,
      retainUntil: new Date(this.now().getTime() + days * 86_400_000),
    });
    return digest;
  }

  /**
   * The bytes for a digest, checked against it on the way out (storage is not trusted to return
   * what was put). Null when the store never had it; ContentRedacted when it was erased.
   */
  async get(tenantId: string, digest: string): Promise<Buffer | null> {
    const [redacted] = await this.deps.reader.redactions(tenantId, [digest]);
    if (redacted) throw new ContentRedacted(redacted);
    const bytes = await this.deps.store.get(keyOf(tenantId, digest));
    if (!bytes) return null;
    if (digestOfBytes(bytes) !== digest) throw new Error(`content store returned bytes that do not match ${digest}`);
    return bytes;
  }

  async getJson<T>(tenantId: string, digest: string): Promise<T | null> {
    const b = await this.get(tenantId, digest);
    return b ? (JSON.parse(b.toString('utf8')) as T) : null;
  }

  async meta(tenantId: string, digest: string) {
    return this.deps.reader.content(tenantId, digest);
  }

  /**
   * GDPR erasure (§5.5). Order matters: the chain entry first — the record that the erasure
   * happened, under which request — then the row, then the bytes. A crash after the entry leaves
   * plaintext that the next attempt removes; never an erasure with no record of it.
   */
  async redact(
    tenantId: string,
    r: { digest: string; requestId: string; reason: string; requestedBy: string },
    appendEntry: (payload: Record<string, unknown>) => Promise<{ seq: number; ts: string }>,
  ): Promise<RedactionRow> {
    const [already] = await this.deps.reader.redactions(tenantId, [r.digest]);
    if (already) return already;
    const entry = await appendEntry({ digest: r.digest, requestId: r.requestId, reason: r.reason, requestedBy: r.requestedBy });
    const row: RedactionRow = { id: randomUUID(), tenantId, digest: r.digest, requestId: r.requestId, reason: r.reason, requestedBy: r.requestedBy, entrySeq: entry.seq, redactedAt: entry.ts };
    await this.deps.writer.insertRedaction(row);
    if (!this.deps.store.delete) throw new Error('this content store cannot delete objects (WORM?) — the redaction is recorded but the plaintext remains');
    await this.deps.store.delete(keyOf(tenantId, r.digest));
    return row;
  }
}
