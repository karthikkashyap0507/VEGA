import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * The standalone verifier every pack carries (module7.md §5.6 `verifier/`): @vega/verifier's CLI
 * bundled into one ES module with its dependencies, runnable with Node ≥ 20 and nothing else —
 * plus its license and the specification it checks. Built once per process.
 */
let cached: Promise<Map<string, Buffer>> | undefined;

export function verifierBundle(): Promise<Map<string, Buffer>> {
  cached ??= (async () => {
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve('@vega/verifier/package.json'));
    const { build } = await import('esbuild');
    const out = await build({
      entryPoints: [join(root, 'src/cli.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      write: false,
      legalComments: 'inline',
      banner: { js: '// vega-verify — Apache-2.0 (see LICENSE and README.md). Offline: this file makes no network calls.' },
    });
    return new Map([
      ['vega-verify.mjs', Buffer.from(out.outputFiles[0]!.contents)],
      ['LICENSE', readFileSync(join(root, 'LICENSE'))],
      ['README.md', readFileSync(join(root, 'README.md'))],
    ]);
  })();
  return cached;
}
