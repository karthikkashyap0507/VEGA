#!/usr/bin/env node
/**
 * Architectural invariant checks that are cheap enough to run on every build.
 *
 * These are NOT style rules. Each maps to an invariant in docs/PROJECT.md 10.2 or a
 * decision in 25. A failure here means the architecture has drifted, not that
 * someone forgot a semicolon.
 *
 *   node scripts/verify-invariants.mjs
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', '.turbo', 'coverage', 'docs', 'evals',
]);

// Never scan local-only files. `.env` holds real credentials by design.
const SKIP_FILES = /^\.env(\..*)?$/;

/** Source files. Code-shaped invariants apply only to these. */
const SOURCE = /\.(ts|tsx|mts|js|mjs)$/;

/** @type {{id:string,title:string,ref:string,violations:string[]}[]} */
const checks = [
  {
    id: 'BRAND-001',
    title: 'Product name appears only in packages/shared/src/brand.ts',
    ref: 'PROJECT.md 3.1 — rename must be a one-file change',
    violations: [],
  },
  {
    id: 'PLANE-001',
    title: 'Execution plane does not import the evidence write client directly',
    ref: 'PROJECT.md 10.2 invariant 1',
    violations: [],
  },
  {
    id: 'TIER-001',
    title: 'No business-logic branch keys off tenants.plan',
    ref: 'PROJECT.md 22.1 decision D-09',
    violations: [],
  },
  {
    id: 'EVAL-001',
    title: 'No eval / new Function outside packages/taint',
    ref: 'PROJECT.md 10.2 invariant 5, TECHSTACK 9',
    violations: [],
  },
  {
    id: 'SEC-001',
    title: 'No private key or credential material in tracked files',
    ref: 'module1.md 10 - plaintext credentials never reach the repository',
    violations: [],
  },
  {
    id: 'DB-001',
    title: 'No raw pg Pool outside packages/db',
    ref: 'module1.md 4.1 — RLS tenant context helper is the only sanctioned path',
    violations: [],
  },
];

const byId = Object.fromEntries(checks.map((c) => [c.id, c]));

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
    } else if (!SKIP_FILES.test(entry) && /\.(ts|tsx|mts|js|mjs|json|ya?ml|pem|key|sql)$/.test(entry)) {
      inspect(full);
    }
  }
}

function inspect(file) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');

  const isSource = SOURCE.test(rel);

  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`;

    // Credential material is a problem in ANY file type.
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) {
      byId['SEC-001'].violations.push(at);
    }
    if (!isSource) return;

    const code = line.replace(/\/\/.*$/, '');
    // The lint-rule package names every forbidden pattern (in messages and in fixtures that
    // must fail). It is exempt from the code-shaped checks — never from BRAND or SEC.
    const ruleFixtures = rel.startsWith('packages/eslint-rules/');

    if (/\bVEGA\b/.test(code) && rel !== 'packages/shared/src/brand.ts') {
      byId['BRAND-001'].violations.push(at);
    }
    if (rel.startsWith('services/execution/') && /evidence\/(write|client)|EvidenceWriter/.test(code)) {
      byId['PLANE-001'].violations.push(at);
    }
    if (!ruleFixtures && /(tenant|t)\.plan\s*===|plan\s*===\s*['"](free|pro|business|teams|enterprise)['"]/.test(code)) {
      byId['TIER-001'].violations.push(at);
    }
    if (!ruleFixtures && /\beval\s*\(|new\s+Function\s*\(/.test(code) && !rel.startsWith('packages/taint/')) {
      byId['EVAL-001'].violations.push(at);
    }
    if (!ruleFixtures && /new\s+Pool\s*\(/.test(code) && !rel.startsWith('packages/db/')) {
      byId['DB-001'].violations.push(at);
    }
  });
}

/**
 * The files that could reach the repository: tracked, plus untracked-but-not-ignored.
 * Gitignored local material (`.env`, downloaded IdP keys under infra/docker/secrets/) exists
 * on a developer's disk by design and is not what SEC-001 guards against. Falls back to a
 * filesystem walk outside a git checkout (e.g. a source tarball).
 */
function candidateFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return out
      .split('\0')
      .filter(Boolean)
      .filter((rel) => !rel.split('/').some((part) => SKIP_DIRS.has(part)))
      .filter((rel) => {
        const name = rel.split('/').pop() ?? '';
        return !SKIP_FILES.test(name) && /\.(ts|tsx|mts|js|mjs|json|ya?ml|pem|key|sql)$/.test(name);
      })
      .map((rel) => join(ROOT, rel));
  } catch {
    return null;
  }
}

const files = candidateFiles();
if (files) {
  for (const file of files) {
    try {
      inspect(file);
    } catch (error) {
      // A file listed by git but deleted in the working tree is not a violation.
      if (error?.code !== 'ENOENT') throw error;
    }
  }
} else {
  walk(ROOT);
}

let failed = 0;
console.log('\nArchitectural invariants\n' + '='.repeat(60));
for (const c of checks) {
  const ok = c.violations.length === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`);
  if (!ok) {
    failed++;
    console.log(`      ref: ${c.ref}`);
    for (const v of c.violations.slice(0, 10)) console.log(`      - ${v}`);
    if (c.violations.length > 10) {
      console.log(`      ... and ${c.violations.length - 10} more`);
    }
  }
}
console.log('='.repeat(60));

if (failed > 0) {
  console.error(`\n${failed} invariant check(s) failed. This is an architecture defect.\n`);
  process.exit(1);
}
console.log('All invariants hold.\n');
