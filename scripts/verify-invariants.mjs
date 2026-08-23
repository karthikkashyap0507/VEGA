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
    title: 'No eval / new Function outside packages/interpreter',
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

    if (/\bVEGA\b/.test(code) && rel !== 'packages/shared/src/brand.ts') {
      byId['BRAND-001'].violations.push(at);
    }
    if (rel.startsWith('services/execution/') && /evidence\/(write|client)|EvidenceWriter/.test(code)) {
      byId['PLANE-001'].violations.push(at);
    }
    if (/(tenant|t)\.plan\s*===|plan\s*===\s*['"](free|pro|business|teams|enterprise)['"]/.test(code)) {
      byId['TIER-001'].violations.push(at);
    }
    if (/\beval\s*\(|new\s+Function\s*\(/.test(code) && !rel.startsWith('packages/interpreter/')) {
      byId['EVAL-001'].violations.push(at);
    }
    if (/new\s+Pool\s*\(/.test(code) && !rel.startsWith('packages/db/')) {
      byId['DB-001'].violations.push(at);
    }
  });
}

walk(ROOT);

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
