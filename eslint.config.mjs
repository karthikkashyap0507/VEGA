import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import vega from './packages/eslint-rules/src/index.js';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // Invariant 5 support: no dynamic code execution outside the interpreter.
      // scripts/verify-invariants.mjs (EVAL-001) is the repo-wide backstop.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // Silent failure is how an ungoverned deployment reaches a customer.
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
  {
    // Architectural invariants (module1.md §5.6). Errors, never warnings: a failure means
    // the architecture drifted. Scoped to production source — tests legitimately open raw
    // connections to assert what a database ROLE can and cannot do.
    files: [
      'packages/*/src/**/*.{ts,tsx}',
      'packages/connectors/*/src/**/*.ts',
      'services/*/src/**/*.ts',
      'apps/*/src/**/*.{ts,tsx}',
    ],
    plugins: { vega },
    rules: {
      'vega/no-evidence-write-from-execution': 'error',
      'vega/no-raw-db-pool': 'error',
      'vega/no-eval': ['error', { allow: ['packages/taint/'] }],
      'vega/require-tenant-context': 'error',
      'vega/no-plan-branching': 'error',
      // Module 2 enables this for packages/connectors when the first tool is declared.
      'vega/require-tool-declaration': ['error', { paths: ['packages/connectors/'] }],
      // Module 3 enables this by naming the privileged planner paths and untrusted types.
      'vega/no-untrusted-in-privileged': ['error', { privilegedPaths: [] }],
    },
  },
  {
    // The web app runs in the browser: DOM globals, not Node's.
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
