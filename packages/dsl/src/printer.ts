import type { Expr, Program, Stmt } from './ast.js';

/** AST → canonical text. parse(print(p)) equals p (node ids reassigned in source order). */

const IDENT = /^[a-z_][a-zA-Z0-9_]*$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KW = new Set(['let', 'call', 'as', 'when', 'otherwise', 'emit', 'map', 'filter', 'extract', 'into', 'resolve', 'in', 'count', 'coalesce', 'render', 'true', 'false', 'null', 'and', 'or', 'not', 'limit']);

const str = (s: string) => JSON.stringify(s);
const key = (k: string) => (KEY.test(k) && !KW.has(k) ? k : str(k));
const binary = (e: Expr) => e.k === 'compare' || e.k === 'logic' || e.k === 'concat' || e.k === 'not';

function operand(e: Expr): string {
  return binary(e) ? `(${expr(e)})` : expr(e);
}

export function expr(e: Expr): string {
  switch (e.k) {
    case 'lit':
      return typeof e.value === 'string' ? str(e.value) : String(e.value);
    case 'ref':
      return e.name;
    case 'select': {
      const base = e.of.k === 'ref' || e.of.k === 'call' || e.of.k === 'object' || e.of.k === 'array' || e.of.k === 'lit' ? expr(e.of) : `(${expr(e.of)})`;
      return base + e.path.map((s) => (typeof s === 'number' ? `[${s}]` : IDENT.test(s) && !KW.has(s) ? `.${s}` : `[${str(s)}]`)).join('');
    }
    case 'object':
      return e.fields.length ? `{ ${e.fields.map(([k, v]) => `${key(k)}: ${expr(v)}`).join(', ')} }` : '{}';
    case 'array':
      return `[${e.items.map(expr).join(', ')}]`;
    case 'map':
    case 'filter':
      return `${e.k} ${operand(e.of)} as ${e.as}${e.limit !== undefined ? ` limit ${e.limit}` : ''} { ${expr(e.body)} }`;
    case 'extract':
      return `extract ${operand(e.of)} into ${e.schema}`;
    case 'resolve':
      return `resolve ${operand(e.of)} in ${e.registry}`;
    case 'concat':
      return e.parts.map(operand).join(' + ');
    case 'compare':
      return `${operand(e.left)} ${e.op} ${operand(e.right)}`;
    case 'logic':
      return `${operand(e.left)} ${e.op} ${operand(e.right)}`;
    case 'not':
      return `not ${operand(e.of)}`;
    case 'count':
      return `count(${expr(e.of)})`;
    case 'coalesce':
      return `coalesce(${e.parts.map(expr).join(', ')})`;
    case 'render':
      return `render(${str(e.template)}, ${expr(e.context)})`;
    case 'call':
      return `call ${e.tool}(${e.args.length ? `{ ${e.args.map(([k, v]) => `${key(k)}: ${expr(v)}`).join(', ')} }` : ''})`;
  }
}

function stmt(s: Stmt, indent: string): string {
  switch (s.k) {
    case 'let':
      return `${indent}let ${s.name} = ${expr(s.value)}`;
    case 'do':
      return `${indent}${expr(s.call)}${s.as ? ` as ${s.as}` : ''}`;
    case 'emit':
      return `${indent}emit ${expr(s.value)}`;
    case 'when': {
      const inner = indent + '  ';
      const then = s.then.map((x) => stmt(x, inner)).join('\n');
      const head = `${indent}when ${expr(s.cond)} {\n${then}${then ? '\n' : ''}${indent}}`;
      if (!s.otherwise) return head;
      const other = s.otherwise.map((x) => stmt(x, inner)).join('\n');
      return `${head} otherwise {\n${other}${other ? '\n' : ''}${indent}}`;
    }
  }
}

export function print(p: Program): string {
  return p.body.map((s) => stmt(s, '')).join('\n') + '\n';
}
