#!/usr/bin/env node
/**
 * `pnpm env:init` — a working local `.env` without openssl (so it runs the same on Windows).
 *
 *   1. no `.env` yet → copied from `.env.example`
 *   2. every local secret that is blank or still a placeholder is generated (Node's crypto)
 *   3. keys `.env.example` has gained since your `.env` was made are appended with its defaults
 *
 * A value you set is never overwritten, and no secret is ever printed — only key names.
 * Pass `--file <path>` to write somewhere other than the repository's `.env`.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = join(ROOT, '.env.example');
const argAt = process.argv.indexOf('--file');
const TARGET = argAt > 0 && process.argv[argAt + 1] ? resolve(process.argv[argAt + 1]) : join(ROOT, '.env');

const b64 = (n) => () => randomBytes(n).toString('base64');
const hex = (n) => () => randomBytes(n).toString('hex');

/** Each secret, how to make it, and what the services need from it. */
const SECRETS = {
  SESSION_SECRET: b64(48), // cookie signing
  LOCAL_KEK_BASE64: b64(32), // exactly 32 bytes: the envelope-encryption key
  CONNECTOR_STATE_SECRET: b64(36), // seals OAuth state across the provider redirect
  EXECUTION_INTERNAL_TOKEN: hex(24), // control → execution
  EXTRACTOR_TOKEN: hex(24), // execution → quarantined extractor
  PUSH_TOPIC_SECRET: hex(24), // per-person push topics (both planes)
  EVIDENCE_APPEND_TOKEN: hex(24), // execution → evidence append
  EVIDENCE_CONTROL_APPEND_TOKEN: hex(24), // control → evidence append
  EVIDENCE_QUERY_TOKEN: hex(24), // control → evidence query
};

/** Blank, or one of the template's placeholders (`CHANGE_ME_…`, `dev-…-change-me`). */
const isPlaceholder = (v) => v.trim() === '' || /change[_-]?me/i.test(v);

const keyOf = (line) => line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)?.[1];
const valueOf = (line) => line.slice(line.indexOf('=') + 1).replace(/\r$/, '');

const example = readFileSync(EXAMPLE, 'utf8');
const created = !existsSync(TARGET);
const before = created ? '' : readFileSync(TARGET, 'utf8');
const lines = (created ? example : before).split('\n');

const generated = [];
for (let i = 0; i < lines.length; i++) {
  const key = keyOf(lines[i]);
  if (key && SECRETS[key] && isPlaceholder(valueOf(lines[i]))) {
    lines[i] = `${key}=${SECRETS[key]()}`;
    generated.push(key);
  }
}

const present = new Set(lines.map(keyOf).filter(Boolean));
const added = [];
for (const line of example.split('\n')) {
  const key = keyOf(line);
  if (!key || present.has(key)) continue;
  if (!added.length) lines.push('', '# ---- added by `pnpm env:init`: new in .env.example since this file was made ----');
  const value = SECRETS[key] ? SECRETS[key]() : valueOf(line);
  lines.push(`${key}=${value}`);
  added.push(key);
  if (SECRETS[key]) generated.push(key);
}

const after = lines.join('\n');
if (after !== before) writeFileSync(TARGET, after);

const rel = TARGET.startsWith(ROOT) ? TARGET.slice(ROOT.length + 1) : TARGET;
console.log(created ? `created ${rel} from .env.example` : after === before ? `${rel}: no changes needed` : `updated ${rel}`);
console.log(generated.length ? `generated: ${generated.join(', ')}` : 'generated: nothing (every secret is already set)');
if (added.length) console.log(`added from .env.example: ${added.join(', ')}`);
const kek = lines.map((l) => (keyOf(l) === 'LOCAL_KEK_BASE64' ? valueOf(l) : null)).find(Boolean);
if (kek && Buffer.from(kek, 'base64').length !== 32) {
  console.error('LOCAL_KEK_BASE64 does not decode to 32 bytes: blank it and run `pnpm env:init` again');
  process.exitCode = 1;
}
