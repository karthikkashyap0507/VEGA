import { z } from 'zod';

/**
 * The restricted DSL — docs/module3.md §6. A program is a small JSON AST: diffable, hashable,
 * replayable (M7), and the ONLY thing the planner can produce. There are ~20 operations, each
 * with its own taint rule in the interpreter. Deliberately absent: user functions, recursion,
 * unbounded loops, string indexing, dynamic tool ids, reflection, arithmetic, try/catch.
 *
 * Every call carries a stable `id`: it is the node id M4 derives idempotency keys from and the
 * `node_id` a taint violation names.
 */

export type Json = string | number | boolean | null;

export type CompareOp = '==' | '!=' | '<' | '<=' | '>' | '>=';
export type PathSeg = string | number;

export type Expr =
  | { k: 'lit'; value: Json }
  | { k: 'ref'; name: string }
  | { k: 'select'; of: Expr; path: PathSeg[] }
  | { k: 'object'; fields: Array<[string, Expr]> }
  | { k: 'array'; items: Expr[] }
  | { k: 'map'; of: Expr; as: string; body: Expr; limit?: number | undefined }
  | { k: 'filter'; of: Expr; as: string; body: Expr; limit?: number | undefined }
  | { k: 'extract'; of: Expr; schema: string }
  | { k: 'resolve'; of: Expr; registry: 'directory' | 'contacts' }
  | { k: 'concat'; parts: Expr[] }
  | { k: 'compare'; op: CompareOp; left: Expr; right: Expr }
  | { k: 'logic'; op: 'and' | 'or'; left: Expr; right: Expr }
  | { k: 'not'; of: Expr }
  | { k: 'count'; of: Expr }
  | { k: 'coalesce'; parts: Expr[] }
  | { k: 'render'; template: string; context: Expr }
  | CallExpr;

export interface CallExpr {
  k: 'call';
  id: string;
  tool: string;
  args: Array<[string, Expr]>;
}

export type Stmt =
  | { k: 'let'; name: string; value: Expr }
  | { k: 'do'; call: CallExpr; as?: string | undefined }
  | { k: 'when'; id: string; cond: Expr; then: Stmt[]; otherwise?: Stmt[] | undefined }
  | { k: 'emit'; value: Expr };

export interface Program {
  version: 1;
  body: Stmt[];
}

const Ident = z.string().regex(/^[a-z_][a-zA-Z0-9_]*$/, 'identifier');
const ToolId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'tool id');
const NodeId = z.string().regex(/^n[0-9]+$/, 'node id');

export const ExprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.object({ k: z.literal('lit'), value: z.union([z.string().max(100_000), z.number(), z.boolean(), z.null()]) }).strict(),
    z.object({ k: z.literal('ref'), name: Ident }).strict(),
    z.object({ k: z.literal('select'), of: ExprSchema, path: z.array(z.union([z.string().min(1).max(100), z.number().int().min(0).max(10_000)])).min(1).max(20) }).strict(),
    z.object({ k: z.literal('object'), fields: z.array(z.tuple([z.string().min(1).max(100), ExprSchema])).max(100) }).strict(),
    z.object({ k: z.literal('array'), items: z.array(ExprSchema).max(200) }).strict(),
    z.object({ k: z.literal('map'), of: ExprSchema, as: Ident, body: ExprSchema, limit: z.number().int().min(1).optional() }).strict(),
    z.object({ k: z.literal('filter'), of: ExprSchema, as: Ident, body: ExprSchema, limit: z.number().int().min(1).optional() }).strict(),
    z.object({ k: z.literal('extract'), of: ExprSchema, schema: z.string().regex(/^[A-Z][A-Za-z0-9]*$/) }).strict(),
    z.object({ k: z.literal('resolve'), of: ExprSchema, registry: z.enum(['directory', 'contacts']) }).strict(),
    z.object({ k: z.literal('concat'), parts: z.array(ExprSchema).min(1).max(50) }).strict(),
    z.object({ k: z.literal('compare'), op: z.enum(['==', '!=', '<', '<=', '>', '>=']), left: ExprSchema, right: ExprSchema }).strict(),
    z.object({ k: z.literal('logic'), op: z.enum(['and', 'or']), left: ExprSchema, right: ExprSchema }).strict(),
    z.object({ k: z.literal('not'), of: ExprSchema }).strict(),
    z.object({ k: z.literal('count'), of: ExprSchema }).strict(),
    z.object({ k: z.literal('coalesce'), parts: z.array(ExprSchema).min(1).max(20) }).strict(),
    z.object({ k: z.literal('render'), template: z.string().regex(/^[a-z][a-z0-9-]*$/), context: ExprSchema }).strict(),
    CallSchema,
  ]),
);

export const CallSchema: z.ZodType<CallExpr> = z.lazy(() =>
  z.object({ k: z.literal('call'), id: NodeId, tool: ToolId, args: z.array(z.tuple([z.string().min(1).max(100), ExprSchema])).max(50) }).strict(),
);

export const StmtSchema: z.ZodType<Stmt> = z.lazy(() =>
  z.union([
    z.object({ k: z.literal('let'), name: Ident, value: ExprSchema }).strict(),
    z.object({ k: z.literal('do'), call: CallSchema, as: Ident.optional() }).strict(),
    z.object({ k: z.literal('when'), id: NodeId, cond: ExprSchema, then: z.array(StmtSchema).max(200), otherwise: z.array(StmtSchema).max(200).optional() }).strict(),
    z.object({ k: z.literal('emit'), value: ExprSchema }).strict(),
  ]),
);

export const ProgramSchema = z.object({ version: z.literal(1), body: z.array(StmtSchema).max(500) }).strict();

/** Walks every expression in a program, in source order. */
export function* walkExprs(e: Expr): Generator<Expr> {
  yield e;
  switch (e.k) {
    case 'select':
    case 'not':
    case 'count':
    case 'extract':
    case 'resolve':
      yield* walkExprs(e.of);
      break;
    case 'map':
    case 'filter':
      yield* walkExprs(e.of);
      yield* walkExprs(e.body);
      break;
    case 'object':
      for (const [, v] of e.fields) yield* walkExprs(v);
      break;
    case 'array':
      for (const v of e.items) yield* walkExprs(v);
      break;
    case 'concat':
    case 'coalesce':
      for (const v of e.parts) yield* walkExprs(v);
      break;
    case 'compare':
    case 'logic':
      yield* walkExprs(e.left);
      yield* walkExprs(e.right);
      break;
    case 'render':
      yield* walkExprs(e.context);
      break;
    case 'call':
      for (const [, v] of e.args) yield* walkExprs(v);
      break;
    default:
      break;
  }
}

export function* walkStmts(body: Stmt[]): Generator<Stmt> {
  for (const s of body) {
    yield s;
    if (s.k === 'when') {
      yield* walkStmts(s.then);
      if (s.otherwise) yield* walkStmts(s.otherwise);
    }
  }
}

export function callsOf(program: Program): CallExpr[] {
  const out: CallExpr[] = [];
  for (const s of walkStmts(program.body)) {
    const roots = s.k === 'let' ? [s.value] : s.k === 'do' ? [s.call] : s.k === 'when' ? [s.cond] : [s.value];
    for (const r of roots) for (const e of walkExprs(r)) if (e.k === 'call') out.push(e);
  }
  return out;
}
