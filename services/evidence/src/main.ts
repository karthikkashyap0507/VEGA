import { createHash } from 'node:crypto';
import { createLogger, internalServerTls, loadTls, startHealthServer } from '@vega/shared';
import { EvidenceReader, EvidenceWriter, migrateEvidence } from '@vega/db/evidence';
import { MemoryObjectStore, s3FromEnv, type ObjectStore } from '@vega/objectstore';
import { Anchorer, HttpTimestamper } from './anchor.js';
import { buildEvidenceApp } from './app.js';
import { LocalKeyCustody } from './chain/keys.js';
import { ChainService } from './chain/service.js';
import { ContentStore } from './content.js';
import { PackBuilder } from './packs/builder.js';
import { ReplayEngine } from './replay.js';
import { TraceBuilder } from './trace.js';
import { ChainVerifier } from './verify.js';

const logger = createLogger('evidence');
const env = process.env;
const production = env['NODE_ENV'] === 'production';
const ownerUrl = env['EVIDENCE_DATABASE_URL'];
const writerUrl = env['EVIDENCE_WRITER_URL'];
const readerUrl = env['EVIDENCE_READER_URL'];
const appendToken = env['EVIDENCE_APPEND_TOKEN'];
if (!ownerUrl || !writerUrl || !readerUrl || !appendToken) {
  throw new Error('EVIDENCE_DATABASE_URL, EVIDENCE_WRITER_URL, EVIDENCE_READER_URL and EVIDENCE_APPEND_TOKEN are required');
}

// KEY CUSTODY (module7.md §5.3). Deployed: a KMS/HSM adapter whose IAM the execution plane is not
// granted (infra/tests/plane-separation.sh [4]). Locally: an ML-DSA-65 key from a 32-byte seed.
let seed = env['EVIDENCE_SIGNING_SEED'];
if (!seed) {
  if (production) throw new Error('EVIDENCE_SIGNING_SEED (or a KMS custodian) is required in production');
  seed = createHash('sha256').update('vega-evidence-dev-signing-key').digest('hex');
  logger.warn('DEV: evidence entries are signed with a well-known development key — never use this outside a laptop');
}
const custody = new LocalKeyCustody(env['EVIDENCE_SIGNING_KEY_ID'] ?? (production ? 'vega-evidence' : 'vega-evidence-dev'), seed);

await migrateEvidence(ownerUrl);
const writer = new EvidenceWriter(writerUrl);
const reader = new EvidenceReader(readerUrl);
// The content-addressed store and WORM packs (S3 Object Lock deployed, TECHSTACK §11.3).
let contentBucket: ObjectStore;
let packBucket: ObjectStore;
if (env['S3_ENDPOINT'] || production) {
  contentBucket = s3FromEnv(env, env['S3_BUCKET_CONTENT'] ?? 'vega-content');
  packBucket = s3FromEnv(env, env['S3_BUCKET_EVIDENCE'] ?? 'vega-evidence');
  await contentBucket.ensureBucket();
  await packBucket.ensureBucket();
} else {
  logger.warn('DEV: no S3_ENDPOINT — content and packs are kept IN MEMORY and lost on restart (receipts and the chain are not)');
  contentBucket = new MemoryObjectStore();
  packBucket = new MemoryObjectStore();
}

const content = new ContentStore({ store: contentBucket, writer, reader, retentionDays: Number(env['EVIDENCE_RETENTION_DAYS'] ?? 2555) });
const chain = new ChainService({ writer, reader, custody, content });
await chain.register();
const anchorer = new Anchorer({ reader, writer, custody, timestamper: env['EVIDENCE_TSA_URL'] ? new HttpTimestamper(env['EVIDENCE_TSA_URL']) : undefined, log: logger });
const keys = () => chain.publicKeys();
const verifier = new ChainVerifier({ reader, writer, keys, log: logger });
const packs = new PackBuilder({ reader, writer, chain, anchorer, content, packs: packBucket, publicBase: env['GATEWAY_PUBLIC_URL'] ?? null, log: logger });
const replay = new ReplayEngine({ reader, writer, content, chain });
const trace = new TraceBuilder({ reader, content, keys });

const tls = loadTls();
if (!tls) logger.warn('DEV: plain HTTP; in a cluster evidence accepts only mTLS clients');
// Two doors, two listeners, two ports — so the network policy keeps the execution plane on the
// append port, not only the credential (infra/helm network-policies: execution → 3004 only).
const common = { writer, reader, appendToken, controlAppendToken: env['EVIDENCE_CONTROL_APPEND_TOKEN'], queryToken: env['EVIDENCE_QUERY_TOKEN'], logger, custody, chain, content, anchorer, packs, replay, trace, verifier, ...(tls ? { https: internalServerTls(tls) } : {}) };
const appendDoor = await buildEvidenceApp({ ...common, doors: { append: true, query: false } });
const queryDoor = await buildEvidenceApp({ ...common, doors: { append: false, query: true } });
anchorer.start(Number(env['EVIDENCE_ANCHOR_INTERVAL_MS'] ?? 3_600_000));
verifier.start(Number(env['EVIDENCE_VERIFY_INTERVAL_MS'] ?? 15 * 60_000));
const host = env['HOST'] ?? '127.0.0.1';
const port = Number(env['EVIDENCE_PORT'] ?? 3004);
const queryPort = Number(env['EVIDENCE_QUERY_PORT'] ?? 3008);
await appendDoor.listen({ port, host });
await queryDoor.listen({ port: queryPort, host });
logger.info({ port, query_port: queryPort, key_id: custody.keyId }, 'evidence plane listening (append door, query door; append-only chain, signed)');
// Probes cannot present client certificates; with mTLS on, health lives on its own port.
if (tls) startHealthServer(Number(env['HEALTH_PORT'] ?? 9000), () => writer.ping());
