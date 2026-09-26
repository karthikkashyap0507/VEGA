import { readdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * EVIDENCE PLANE database access — `@vega/db/evidence`.
 *
 * A separate entry point on purpose. The evidence instance is physically separate
 * (module1.md §3.2) and the execution plane holds NO credential for it; the execution plane
 * reaches evidence only through the evidence service's HTTP /append. This module is imported
 * by services/evidence and by nothing else — `no-evidence-write-from-execution` and PLANE-001
 * fail the build if services/execution imports it.
 *
 * Invariant 1 has four layers. This code relies on, and never substitutes for, the other
 * three: network policy, the INSERT-only grant, and the append-only trigger.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'evidence-migrations');
const LOCK_KEY = 0x65766964; // 'evid'

/** Applies evidence-plane migrations as the evidence OWNER. Same ledger shape as the primary. */
export async function migrateEvidence(ownerUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), checksum text NOT NULL)`,
    );
    const { rows } = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM _migrations');
    const seen = new Map(rows.map((r) => [r.name, r.checksum]));
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      const text = readFileSync(join(MIGRATIONS, file), 'utf8');
      const checksum = createHash('sha256').update(text).digest('hex');
      const prev = seen.get(file);
      if (prev) {
        if (prev !== checksum) throw new Error(`evidence migration ${file} was modified after being applied`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(text);
        await client.query('INSERT INTO _migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`evidence migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

export interface InboxEntry {
  tenantId: string;
  source: string;
  kind: string;
  payload: Record<string, unknown>;
}

/**
 * INSERT-only writer, connected as vega_evi_writer. It exposes append() and nothing else:
 * there is no read, update or delete method to call, and the role could not execute one.
 */
export class EvidenceWriter {
  private readonly pool: pg.Pool;

  constructor(writerUrl: string) {
    this.pool = new pg.Pool({ connectionString: writerUrl, max: 5, application_name: 'evidence-writer' });
  }

  async append(entry: InboxEntry): Promise<{ id: string; receivedAt: Date }> {
    const id = randomUUID();
    const receivedAt = new Date();
    await this.pool.query(
      `INSERT INTO evidence_inbox (id, received_at, tenant_id, source, kind, payload) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, receivedAt, entry.tenantId, entry.source, entry.kind, JSON.stringify(entry.payload)],
    );
    return { id, receivedAt };
  }

  /** Readiness: the connection works. Deliberately reads no table — the role cannot. */
  async ping(): Promise<boolean> {
    await this.pool.query('SELECT 1');
    return true;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
