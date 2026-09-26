import { and, eq, sql } from 'drizzle-orm';
import { schema, withTenant } from '@vega/db';
import type { DerivationRecord, Entity, EntityPort, Pager, ProgramRecord, Recorder, SourceRecord, ViolationRecord } from './ports.js';

/**
 * Postgres implementations, all under withTenant(). Derivations are buffered per run and
 * flushed in batches: a program is ~50 steps, not a hot loop, but one INSERT per step would
 * still dominate a run's latency.
 */
export class PgRecorder implements Recorder {
  private buffer: DerivationRecord[] = [];

  async program(p: ProgramRecord) {
    await withTenant(p.tenantId, (db) =>
      db.insert(schema.programs).values({
        tenantId: p.tenantId,
        runId: p.runId,
        astJson: p.ast,
        astDigest: p.digest,
        modelId: p.modelId,
        valid: p.valid,
        validationErrors: p.validationErrors ?? null,
      }),
    );
  }

  async source(s: SourceRecord) {
    await withTenant(s.tenantId, (db) =>
      db.insert(schema.sources).values({ tenantId: s.tenantId, runId: s.runId, uri: s.uri, taint: s.taint, digest: s.digest, connectorId: s.connectorId ?? null, meta: s.meta }),
    );
  }

  async derivation(d: DerivationRecord) {
    this.buffer.push(d);
    if (this.buffer.length >= 100) await this.flush();
  }

  async flush() {
    const batch = this.buffer;
    this.buffer = [];
    if (!batch.length) return;
    const tenantId = batch[0]!.tenantId;
    await withTenant(tenantId, (db) =>
      db.insert(schema.derivations).values(
        batch.map((d) => ({
          tenantId: d.tenantId,
          runId: d.runId,
          valueRef: d.valueRef,
          op: d.op,
          sourceIds: [...d.sourceIds],
          inputRefs: [...d.inputRefs],
          taint: d.taint,
          dataTaint: d.dataTaint,
          contextTaint: d.contextTaint,
          nodeId: d.nodeId ?? null,
          stepIndex: d.stepIndex,
        })),
      ),
    );
  }

  async violation(v: ViolationRecord) {
    await this.flush();
    await withTenant(v.tenantId, async (db) => {
      await db.insert(schema.taintViolations).values({
        tenantId: v.tenantId,
        runId: v.runId,
        nodeId: v.nodeId,
        toolId: v.toolId,
        kind: v.kind,
        attemptedTaint: v.attemptedTaint,
        declaredMax: v.declaredMax,
        argPath: v.argPath,
        sourceIds: [...v.sourceIds],
        programRef: v.programRef,
        severity: v.severity,
        detail: v.detail,
      });
      await db.insert(schema.platformEvents).values({
        tenantId: v.tenantId,
        actorId: null,
        kind: 'security.taint_violation',
        payload: { runId: v.runId, toolId: v.toolId, kind: v.kind, severity: v.severity, argPath: v.argPath },
      });
    });
  }
}

/** directory = the tenant's active users; contacts = the admin-managed trusted_contacts. */
export class PgEntities implements EntityPort {
  async lookup(tenantId: string, registry: 'directory' | 'contacts', key: string): Promise<Entity | null> {
    const email = key.trim().toLowerCase();
    if (!email.includes('@') || email.length > 320) return null;
    return withTenant(tenantId, async (db) => {
      if (registry === 'directory') {
        const [u] = await db
          .select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName })
          .from(schema.users)
          .where(and(sql`lower(${schema.users.email}) = ${email}`, eq(schema.users.status, 'active')));
        return u ? { kind: 'user' as const, id: u.id, email: u.email.toLowerCase(), displayName: u.displayName } : null;
      }
      const [c] = await db.select().from(schema.trustedContacts).where(eq(schema.trustedContacts.email, email));
      return c ? { kind: 'contact' as const, id: c.id, email: c.email, displayName: c.displayName } : null;
    });
  }
}

/**
 * Pages through ntfy (the self-hosted option; module8 wires other channels). The page carries
 * ids and classification only — never content, which may be the attacker's payload.
 */
export class NtfyPager implements Pager {
  constructor(
    private readonly url: string,
    private readonly topic = 'security',
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}
  async page(v: ViolationRecord) {
    await this.fetchImpl(`${this.url.replace(/\/$/, '')}/${this.topic}`, {
      method: 'POST',
      headers: { title: `Taint violation (${v.severity})`, priority: v.severity === 'CRITICAL' ? '5' : '4', tags: 'rotating_light' },
      body: `${v.kind} on ${v.toolId} ${v.argPath} — tenant ${v.tenantId}, run ${v.runId}. Review in the Security Center.`,
    });
  }
}
