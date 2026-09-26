/**
 * Shared helpers for the architectural rules.
 *
 * Paths are normalised to forward slashes and made repo-relative, so a rule configured with
 * `services/execution/` behaves identically on Windows (TECHSTACK §20) and in CI.
 */
import path from 'node:path';

export function relativePath(context) {
  const cwd = (context.cwd ?? process.cwd()).split(path.sep).join('/');
  const file = (context.filename ?? context.getFilename()).split(path.sep).join('/');
  return file.startsWith(cwd + '/') ? file.slice(cwd.length + 1) : file;
}

export function inAny(rel, prefixes) {
  return prefixes.some((p) => rel.startsWith(p) || rel.includes('/' + p));
}

/** Every module specifier a file pulls in: static imports, re-exports, dynamic import(). */
export function onModuleSource(callback) {
  return {
    ImportDeclaration(node) {
      callback(node.source.value, node.source);
    },
    ExportNamedDeclaration(node) {
      if (node.source) callback(node.source.value, node.source);
    },
    ExportAllDeclaration(node) {
      if (node.source) callback(node.source.value, node.source);
    },
    ImportExpression(node) {
      if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
        callback(node.source.value, node.source);
      }
    },
    CallExpression(node) {
      if (
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require' &&
        node.arguments[0]?.type === 'Literal' &&
        typeof node.arguments[0].value === 'string'
      ) {
        callback(node.arguments[0].value, node.arguments[0]);
      }
    },
  };
}

export function merge(...visitors) {
  const out = {};
  for (const v of visitors) {
    for (const [key, fn] of Object.entries(v)) {
      const prev = out[key];
      out[key] = prev ? (node) => (prev(node), fn(node)) : fn;
    }
  }
  return out;
}

export const docs = (description, ref) => ({ description, url: `docs/${ref}` });
