import { createHash, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createLogger } from '@vega/shared';
import { EvidenceReader, EvidenceWriter, migrateEvidence } from '@vega/db/evidence';
import { MemoryObjectStore } from '@vega/objectstore';
import type { FastifyInstance } from 'fastify';
import { Anchorer } from '../src/anchor.js';
import { buildEvidenceApp } from '../src/app.js';
import { LocalKeyCustody } from '../src/chain/keys.js';
import { ChainService } from '../src/chain/service.js';
import { ContentStore } from '../src/content.js';
import { PackBuilder } from '../src/packs/builder.js';
import { ReplayEngine } from '../src/replay.js';
import { TraceBuilder } from '../src/trace.js';
import { ChainVerifier } from '../src/verify.js';

/** The evidence plane, wired as main.ts wires it, against the local evidence instance. */
export const OWNER = process.env['EVIDENCE_DATABASE_URL'] ?? 'postgresql://vega_evi:vega_evi_local_dev_only@localhost:5433/vega_evidence';
export const WRITER = process.env['EVIDENCE_WRITER_URL'] ?? 'postgresql://vega_evi_writer:vega_evi_writer_local@localhost:5433/vega_evidence';
export const READER = process.env['EVIDENCE_READER_URL'] ?? 'postgresql://vega_evi_reader:vega_evi_reader_local@localhost:5433/vega_evidence';
export const TOKENS = { append: 'test-append-token', control: 'test-control-append-token', query: 'test-query-token' };
/**
 * The well-known DEVELOPMENT key main.ts uses without EVIDENCE_SIGNING_SEED. Entries persist
 * across runs (append-only) and a local dev server shares this database, so suites sign with the
 * same key — a second key would be a rotation, ending the first one's term.
 */
export const KEY_ID = 'vega-evidence-dev';
export const SEED = createHash('sha256').update('vega-evidence-dev-signing-key').digest('hex');

const silent = () => createLogger('t', { level: 'silent' }, new Writable({ write: (_c, _e, cb) => cb() }));

export type Plane = Awaited<ReturnType<typeof evidencePlane>>;

export async function evidencePlane(opts: { now?: () => Date } = {}) {
  await migrateEvidence(OWNER);
  const writer = new EvidenceWriter(WRITER);
  const reader = new EvidenceReader(READER);
  const custody = new LocalKeyCustody(KEY_ID, SEED);
  const objects = new MemoryObjectStore();
  const packObjects = new MemoryObjectStore();
  const content = new ContentStore({ store: objects, writer, reader, ...(opts.now ? { now: opts.now } : {}) });
  const chain = new ChainService({ writer, reader, custody, content, ...(opts.now ? { now: opts.now } : {}) });
  await chain.register();
  const anchorer = new Anchorer({ reader, writer, custody, ...(opts.now ? { now: opts.now } : {}) });
  const keys = () => chain.publicKeys();
  const verifier = new ChainVerifier({ reader, writer, keys });
  const packs = new PackBuilder({ reader, writer, chain, anchorer, content, packs: packObjects, publicBase: 'https://vega.example' });
  const replay = new ReplayEngine({ reader, writer, content, chain });
  const trace = new TraceBuilder({ reader, content, keys });
  const app: FastifyInstance = await buildEvidenceApp({
    writer,
    reader,
    appendToken: TOKENS.append,
    controlAppendToken: TOKENS.control,
    queryToken: TOKENS.query,
    logger: silent(),
    custody,
    chain,
    content,
    anchorer,
    packs,
    replay,
    trace,
    verifier,
  });
  return {
    app,
    writer,
    reader,
    custody,
    objects,
    packObjects,
    content,
    chain,
    anchorer,
    verifier,
    packs,
    replay,
    trace,
    tenant: () => randomUUID(),
    async close() {
      await app.close();
      await writer.close();
      await reader.close();
    },
  };
}

export const json = (v: unknown) => ({ data: Buffer.from(JSON.stringify(v)).toString('base64'), mediaType: 'application/json' });
