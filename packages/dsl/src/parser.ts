import type { CallExpr, CompareOp, Expr, PathSeg, Program, Stmt } from './ast.js';

/**
 * Text form of the DSL (docs/module3.md §6.2) → AST. Hand-written recursive descent: the
 * grammar is small on purpose, and a generated parser would be the larger attack surface.
 *
 *   program   := statement*
 *   statement := 'let' ident '=' expr
 *              | 'call' toolId '(' [object] ')' ['as' ident]
 *              | 'when' expr '{' statement* '}' ['otherwise' '{' statement* '}']
 *              | 'emit' expr
 *   expr      := or ;  or := and ('or' and)* ;  and := not ('and' not)* ;  not := 'not' not | cmp
 *   cmp       := add [('=='|'!='|'<'|'<='|'>'|'>=') add]
 *   add       := postfix ('+' postfix)*                          -- concat
 *   postfix   := primary ('.' (ident|int) | '[' (int|string) ']')*
 *   primary   := string | number | true | false | null | ident | '(' expr ')'
 *              | '{' [key ':' expr (',' key ':' expr)*] '}' | '[' [expr (',' expr)*] ']'
 *              | 'call' toolId '(' [object] ')'
 *              | ('map'|'filter') postfix 'as' ident ['limit' int] '{' expr '}'
 *              | 'extract' postfix 'into' SchemaName
 *              | 'resolve' postfix 'in' ('directory'|'contacts')
 *              | 'count' '(' expr ')' | 'coalesce' '(' expr (',' expr)* ')'
 *              | 'render' '(' string ',' expr ')'
 *
 * Comments: `--` or `//` to end of line. Node ids (n1, n2, …) are assigned in source order.
 */

type Tok =
  | { t: 'ident'; v: string; line: number; col: number }
  | { t: 'num'; v: number; line: number; col: number }
  | { t: 'str'; v: string; line: number; col: number }
  | { t: 'punct'; v: string; line: number; col: number }
  | { t: 'eof'; v: ''; line: number; col: number };

export class ParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly col: number,
  ) {
    super(`${message} at ${line}:${col}`);
    this.name = 'ParseError';
  }
}

const KEYWORDS = new Set([
  'let', 'call', 'as', 'when', 'otherwise', 'emit', 'map', 'filter', 'extract', 'into', 'resolve', 'in',
  'count', 'coalesce', 'render', 'true', 'false', 'null', 'and', 'or', 'not', 'limit',
]);
const PUNCT = ['==', '!=', '<=', '>=', '{', '}', '(', ')', '[', ']', ',', ':', '.', '+', '<', '>', '='];
const MAX_SOURCE = 200_000;

function lex(src: string): Tok[] {
  if (src.length > MAX_SOURCE) throw new ParseError('program too large', 1, 1);
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const adv = (n: number) => {
    for (let j = 0; j < n; j++) {
      if (src[i] === '\n') {
        line++;
        col = 1;
      } else col++;
      i++;
    }
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      adv(1);
      continue;
    }
    if ((c === '-' && src[i + 1] === '-') || (c === '/' && src[i + 1] === '/')) {
      while (i < src.length && src[i] !== '\n') adv(1);
      continue;
    }
    const at = { line, col };
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      out.push({ t: 'ident', v: src.slice(i, j), ...at });
      adv(j - i);
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^-?[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]), ...at });
      adv(m[0].length);
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = '';
      for (;;) {
        const ch = src[j];
        if (ch === undefined || ch === '\n') throw new ParseError('unterminated string', at.line, at.col);
        if (ch === '"') break;
        if (ch === '\\') {
          const e = src[j + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          if (e === 'u') {
            const hex = src.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ParseError('bad \\u escape', line, col);
            v += String.fromCharCode(parseInt(hex, 16));
            j += 6;
            continue;
          }
          if (e === undefined || !(e in map)) throw new ParseError('bad escape', line, col);
          v += map[e];
          j += 2;
          continue;
        }
        v += ch;
        j++;
      }
      out.push({ t: 'str', v, ...at });
      adv(j + 1 - i);
      continue;
    }
    const p = PUNCT.find((x) => src.startsWith(x, i));
    if (!p) throw new ParseError(`unexpected character ${JSON.stringify(c)}`, line, col);
    out.push({ t: 'punct', v: p, ...at });
    adv(p.length);
  }
  out.push({ t: 'eof', v: '', line, col });
  return out;
}

class Parser {
  private i = 0;
  private seq = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(o = 0): Tok {
    return this.toks[Math.min(this.i + o, this.toks.length - 1)]!;
  }
  private next(): Tok {
    return this.toks[this.i++]!;
  }
  private fail(msg: string, tok = this.peek()): never {
    throw new ParseError(msg, tok.line, tok.col);
  }
  private isKw(v: string, o = 0) {
    const t = this.peek(o);
    return t.t === 'ident' && t.v === v;
  }
  private isP(v: string) {
    const t = this.peek();
    return t.t === 'punct' && t.v === v;
  }
  private kw(v: string) {
    if (!this.isKw(v)) this.fail(`expected "${v}"`);
    this.next();
  }
  private p(v: string) {
    if (!this.isP(v)) this.fail(`expected "${v}"`);
    this.next();
  }
  private ident(): string {
    const t = this.next();
    if (t.t !== 'ident' || KEYWORDS.has(t.v)) this.fail('expected an identifier', t);
    return t.v;
  }
  private nodeId() {
    return `n${++this.seq}`;
  }

  program(): Program {
    const body: Stmt[] = [];
    while (this.peek().t !== 'eof') body.push(this.stmt());
    return { version: 1, body };
  }

  private block(): Stmt[] {
    this.p('{');
    const out: Stmt[] = [];
    while (!this.isP('}')) {
      if (this.peek().t === 'eof') this.fail('unterminated block');
      out.push(this.stmt());
    }
    this.p('}');
    return out;
  }

  private stmt(): Stmt {
    if (this.isKw('let')) {
      this.next();
      const name = this.ident();
      this.p('=');
      return { k: 'let', name, value: this.expr() };
    }
    if (this.isKw('call')) {
      const call = this.call();
      if (this.isKw('as')) {
        this.next();
        return { k: 'do', call, as: this.ident() };
      }
      return { k: 'do', call };
    }
    if (this.isKw('when')) {
      this.next();
      const id = this.nodeId();
      const cond = this.expr();
      const then = this.block();
      if (this.isKw('otherwise')) {
        this.next();
        return { k: 'when', id, cond, then, otherwise: this.block() };
      }
      return { k: 'when', id, cond, then };
    }
    if (this.isKw('emit')) {
      this.next();
      return { k: 'emit', value: this.expr() };
    }
    return this.fail('expected let, call, when or emit');
  }

  private call(): CallExpr {
    this.kw('call');
    const id = this.nodeId();
    let tool = this.ident();
    if (!this.isP('.')) this.fail('tool ids are connector.tool');
    while (this.isP('.')) {
      this.next();
      tool += '.' + this.ident();
    }
    this.p('(');
    let args: Array<[string, Expr]> = [];
    if (!this.isP(')')) {
      const obj = this.primary();
      if (obj.k !== 'object') this.fail('call arguments are an object literal');
      args = obj.fields;
    }
    this.p(')');
    return { k: 'call', id, tool, args };
  }

  expr(): Expr {
    return this.or();
  }
  private or(): Expr {
    let l = this.and();
    while (this.isKw('or')) {
      this.next();
      l = { k: 'logic', op: 'or', left: l, right: this.and() };
    }
    return l;
  }
  private and(): Expr {
    let l = this.not();
    while (this.isKw('and')) {
      this.next();
      l = { k: 'logic', op: 'and', left: l, right: this.not() };
    }
    return l;
  }
  private not(): Expr {
    if (this.isKw('not')) {
      this.next();
      return { k: 'not', of: this.not() };
    }
    return this.cmp();
  }
  private cmp(): Expr {
    const l = this.add();
    const t = this.peek();
    if (t.t === 'punct' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) {
      this.next();
      return { k: 'compare', op: t.v as CompareOp, left: l, right: this.add() };
    }
    return l;
  }
  private add(): Expr {
    const first = this.postfix();
    if (!this.isP('+')) return first;
    const parts = [first];
    while (this.isP('+')) {
      this.next();
      parts.push(this.postfix());
    }
    return { k: 'concat', parts };
  }
  private postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.isP('.')) {
        this.next();
        const t = this.next();
        let seg: PathSeg;
        if (t.t === 'ident') seg = t.v;
        else if (t.t === 'num' && Number.isInteger(t.v) && t.v >= 0) seg = t.v;
        else this.fail('expected a field name', t);
        e = e.k === 'select' ? { k: 'select', of: e.of, path: [...e.path, seg] } : { k: 'select', of: e, path: [seg] };
        continue;
      }
      if (this.isP('[')) {
        this.next();
        const t = this.next();
        let seg: PathSeg;
        if (t.t === 'num' && Number.isInteger(t.v) && t.v >= 0) seg = t.v;
        else if (t.t === 'str') seg = t.v;
        else this.fail('index must be a non-negative integer or a string', t);
        this.p(']');
        e = e.k === 'select' ? { k: 'select', of: e.of, path: [...e.path, seg] } : { k: 'select', of: e, path: [seg] };
        continue;
      }
      return e;
    }
  }
  private primary(): Expr {
    const t = this.peek();
    if (t.t === 'str') {
      this.next();
      return { k: 'lit', value: t.v };
    }
    if (t.t === 'num') {
      this.next();
      return { k: 'lit', value: t.v };
    }
    if (t.t === 'punct') {
      if (t.v === '(') {
        this.next();
        const e = this.expr();
        this.p(')');
        return e;
      }
      if (t.v === '{') {
        this.next();
        const fields: Array<[string, Expr]> = [];
        while (!this.isP('}')) {
          const k = this.next();
          if (k.t !== 'ident' && k.t !== 'str') this.fail('expected a key', k);
          if (fields.some(([n]) => n === k.v)) this.fail(`duplicate key "${k.v}"`, k);
          this.p(':');
          fields.push([k.v, this.expr()]);
          if (!this.isP(',')) break;
          this.next();
        }
        this.p('}');
        return { k: 'object', fields };
      }
      if (t.v === '[') {
        this.next();
        const items: Expr[] = [];
        while (!this.isP(']')) {
          items.push(this.expr());
          if (!this.isP(',')) break;
          this.next();
        }
        this.p(']');
        return { k: 'array', items };
      }
      return this.fail(`unexpected "${t.v}"`);
    }
    if (t.t === 'ident') {
      switch (t.v) {
        case 'true':
        case 'false':
          this.next();
          return { k: 'lit', value: t.v === 'true' };
        case 'null':
          this.next();
          return { k: 'lit', value: null };
        case 'call':
          return this.call();
        case 'map':
        case 'filter': {
          this.next();
          const of = this.postfix();
          this.kw('as');
          const as = this.ident();
          let limit: number | undefined;
          if (this.isKw('limit')) {
            this.next();
            const n = this.next();
            if (n.t !== 'num' || !Number.isInteger(n.v) || n.v < 1) this.fail('limit is a positive integer', n);
            limit = n.v;
          }
          this.p('{');
          const body = this.expr();
          this.p('}');
          return limit === undefined ? { k: t.v, of, as, body } : { k: t.v, of, as, body, limit };
        }
        case 'extract': {
          this.next();
          const of = this.postfix();
          this.kw('into');
          const s = this.next();
          if (s.t !== 'ident' || !/^[A-Z][A-Za-z0-9]*$/.test(s.v)) this.fail('expected a schema name', s);
          return { k: 'extract', of, schema: s.v };
        }
        case 'resolve': {
          this.next();
          const of = this.postfix();
          this.kw('in');
          const r = this.next();
          if (r.t !== 'ident' || (r.v !== 'directory' && r.v !== 'contacts')) this.fail('registry is directory or contacts', r);
          return { k: 'resolve', of, registry: r.v };
        }
        case 'count': {
          this.next();
          this.p('(');
          const of = this.expr();
          this.p(')');
          return { k: 'count', of };
        }
        case 'coalesce': {
          this.next();
          this.p('(');
          const parts = [this.expr()];
          while (this.isP(',')) {
            this.next();
            parts.push(this.expr());
          }
          this.p(')');
          return { k: 'coalesce', parts };
        }
        case 'render': {
          this.next();
          this.p('(');
          const name = this.next();
          if (name.t !== 'str') this.fail('render takes a template name string', name);
          this.p(',');
          const context = this.expr();
          this.p(')');
          return { k: 'render', template: name.v, context };
        }
        default:
          if (KEYWORDS.has(t.v)) return this.fail(`unexpected keyword "${t.v}"`);
          this.next();
          return { k: 'ref', name: t.v };
      }
    }
    return this.fail('unexpected end of program');
  }
}

export function parse(source: string): Program {
  return new Parser(lex(source)).program();
}
