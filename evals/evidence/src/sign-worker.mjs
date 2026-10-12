// Signs entry hashes for the load generator (ML-DSA-65 is the slow part of building a chain).
// Plain ESM so a worker thread can load it without a TypeScript loader.
import { parentPort, workerData } from 'node:worker_threads';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

const { secretKey } = ml_dsa65.keygen(Uint8Array.from(Buffer.from(workerData.seedHex, 'hex')));
const enc = new TextEncoder();
parentPort.on('message', ({ id, hashes }) => {
  const sigs = hashes.map((h) => `ML-DSA-65:${Buffer.from(ml_dsa65.sign(enc.encode(`vega-entry-v1\n${h}`), secretKey)).toString('base64')}`);
  parentPort.postMessage({ id, sigs });
});
