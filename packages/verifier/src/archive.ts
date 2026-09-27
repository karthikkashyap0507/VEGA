import { unzipSync, zipSync } from 'fflate';

/** Reads a pack from its zip bytes: path → bytes (directories dropped). */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(unzipSync(bytes))) if (!path.endsWith('/')) out.set(path, data);
  return out;
}

/** Writes a pack. Timestamps are fixed so the same pack always has the same bytes. */
export function writeZip(files: Map<string, Uint8Array>): Uint8Array {
  const tree: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const [path, data] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) tree[path] = [data, { mtime: new Date('2000-01-01T00:00:00Z') }];
  return zipSync(tree, { level: 6 });
}
