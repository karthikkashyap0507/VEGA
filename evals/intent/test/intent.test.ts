import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { heuristicMentions, understand } from '../../../services/control/src/agent/intent.js';
import { CASES, CONTACTS, DIRECTORY } from '../src/corpus.js';

/**
 * C1 ENTITY RESOLUTION — the ≥95% gate (docs/module4.md §11, §12). Scored per entity: each
 * expected address must be resolved (TRUSTED), each expected ambiguity must be reported as one
 * (never silently resolved), and every entity nobody asked for counts against the score.
 *
 * Runs the deterministic mention heuristic plus the registry scan; with a model configured
 * (MODEL_ROUTINE) the same corpus measures the model-assisted path.
 */

process.env['DATABASE_URL'] ??= 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
process.env['DATABASE_APP_URL'] ??= 'postgresql://vega_app:vega_app_local_dev_only@localhost:5432/vega';
const here = dirname(fileURLToPath(import.meta.url));
let tenantId: string;
let userId: string;

beforeAll(async () => {
  const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'], max: 1 });
  try {
    const slug = `intent-${randomBytes(4).toString('hex')}`;
    tenantId = (await pool.query<{ id: string }>(`INSERT INTO tenants (name, slug, plan, retention_days) VALUES ($1, $2, 'business', 400) RETURNING id`, [slug, slug])).rows[0]!.id;
    for (const [i, u] of DIRECTORY.entries()) {
      const r = await pool.query<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`, [tenantId, u.email, u.name, i === 0 ? 'OWNER' : 'MEMBER']);
      if (i === 0) userId = r.rows[0]!.id;
    }
    for (const c of CONTACTS) await pool.query(`INSERT INTO trusted_contacts (tenant_id, email, display_name, added_by) VALUES ($1, $2, $3, $4)`, [tenantId, c.email, c.name, userId]);
  } finally {
    await pool.end();
  }
});

afterAll(async () => {
  const { closePools } = await import('@vega/db');
  await closePools();
});

describe('C1 entity resolution (eval)', () => {
  it('resolves ≥ 95% of the corpus correctly, and never resolves an ambiguity silently', async () => {
    let correct = 0;
    let total = 0;
    const misses: string[] = [];
    for (const c of CASES) {
      const o = await understand({ tenantId, principalUserId: userId, text: c.text, origin: 'principal' }, heuristicMentions);
      const got = new Set(o.entities.filter((e) => !o.ambiguities.some((a) => a.binding === e.binding)).map((e) => e.email));
      for (const want of c.resolved) {
        total++;
        if (got.has(want)) correct++;
        else misses.push(`${c.text} → missing ${want}`);
      }
      for (const raw of c.ambiguous ?? []) {
        total++;
        if (o.ambiguities.some((a) => a.raw.toLowerCase() === raw.toLowerCase() && a.candidates.length >= 2)) correct++;
        else misses.push(`${c.text} → "${raw}" not reported ambiguous`);
      }
      for (const extra of [...got].filter((e) => e && !c.resolved.includes(e))) {
        total++;
        misses.push(`${c.text} → unexpected ${extra}`);
      }
      // Zero tolerance: an expected ambiguity must never also appear as a clean resolution.
      for (const raw of c.ambiguous ?? []) expect(o.entities.filter((e) => e.raw.toLowerCase() === raw.toLowerCase() && !o.ambiguities.some((a) => a.binding === e.binding))).toEqual([]);
    }
    const accuracy = correct / total;
    writeFileSync(join(here, '..', 'report.json'), JSON.stringify({ cases: CASES.length, scored: total, correct, accuracy, misses }, null, 2));
    expect(accuracy, `accuracy ${(accuracy * 100).toFixed(1)}%; misses: ${misses.join(' | ')}`).toBeGreaterThanOrEqual(0.95);
  });
});
