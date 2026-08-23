import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Migration runner.
 *
 * Plain numbered SQL applied in order, tracked in `_migrations`. Deliberately not
 * drizzle-kit: RLS policies, roles, and grants are the substance of this module and they
 * are not expressible in a schema DSL. The database DDL is reviewed as SQL, because that
 * is what a security reviewer will actually read.
 *
 * Runs as the OWNER (DATABASE_URL). The application never has DDL rights.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(connectionString?: string): Promise<string[]> {
  const url = connectionString ?? process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const applied: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum   text NOT NULL
      )
    `);

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM _migrations',
    );
    const seen = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const sqlText = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = await sha256(sqlText);
      const previous = seen.get(file);

      if (previous) {
        // An applied migration that changed on disk means the database and the repository
        // disagree about history. Failing loudly is the only safe response.
        if (previous !== checksum) {
          throw new Error(
            `migration ${file} was modified after being applied ` +
              `(recorded ${previous.slice(0, 12)}, now ${checksum.slice(0, 12)}). ` +
              `Migrations are immutable — add a new one.`,
          );
        }
        continue;
      }

      // Each migration is one transaction: it applies completely or not at all.
      await client.query('BEGIN');
      try {
        await client.query(sqlText);
        await client.query('INSERT INTO _migrations (name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
    }
  } finally {
    await client.end();
  }

  return applied;
}

async function sha256(input: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// CLI entry: pnpm db:migrate
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '')) {
  migrate()
    .then((applied) => {
      if (applied.length === 0) console.log('migrations: up to date');
      else for (const f of applied) console.log('applied ' + f);
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error(String(error));
      process.exit(1);
    });
}
