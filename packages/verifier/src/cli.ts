#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readZip } from './archive.js';
import { formatReport, verifyPack, type TreeHead, type VerifyOptions } from './pack.js';
import type { PublicKeyRecord } from './sign.js';

/**
 * vega-verify — checks a VEGA evidence pack OFFLINE. It opens no socket: the published keys and
 * anchors, when you want them pinned, are files you fetched yourself.
 *
 *   vega-verify <pack.zip | unpacked-dir> [--keys keys.json] [--anchors anchors.json] [--json]
 *
 * Exit status: 0 verified, 1 not verified, 2 usage or I/O error.
 */
function walk(dir: string, root = dir, out = new Map<string, Uint8Array>()): Map<string, Uint8Array> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, root, out);
    else out.set(relative(root, p).split('\\').join('/'), new Uint8Array(readFileSync(p)));
  }
  return out;
}

function main(argv: string[]): number {
  const args = [...argv];
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const asJson = args.includes('--json');
  if (asJson) args.splice(args.indexOf('--json'), 1);
  const keysFile = flag('--keys');
  const anchorsFile = flag('--anchors');
  const target = args[0];
  if (!target || args.length > 1) {
    process.stderr.write('usage: vega-verify <pack.zip | dir> [--keys keys.json] [--anchors anchors.json] [--json]\n');
    return 2;
  }
  try {
    const files = statSync(target).isDirectory() ? walk(target) : readZip(new Uint8Array(readFileSync(target)));
    const opts: VerifyOptions = {};
    if (keysFile) opts.trustedKeys = (JSON.parse(readFileSync(keysFile, 'utf8')) as { keys: PublicKeyRecord[] }).keys;
    if (anchorsFile) opts.publishedAnchors = (JSON.parse(readFileSync(anchorsFile, 'utf8')) as { anchors: TreeHead[] }).anchors;
    const report = verifyPack(files, opts);
    process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `\n  vega-verify ${target}\n${formatReport(report)}\n`);
    return report.verified ? 0 : 1;
  } catch (e) {
    process.stderr.write(`vega-verify: ${(e as Error).message}\n`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
