import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { internalServerTls, mtlsFetch, type TlsMaterial } from '../src/tls.js';

/**
 * mTLS between planes: the server must refuse a client with no certificate and a client
 * whose certificate chains to a different CA, and accept one from the plane CA. Certificates
 * are generated with openssl for the test — the same shape cert-manager issues in-cluster.
 */

let dir: string;
let serverTls: TlsMaterial;
let clientTls: TlsMaterial;
let foreignTls: TlsMaterial;
let url: string;
let close: () => Promise<void>;

function openssl(...args: string[]) {
  execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
}

function makeCa(name: string) {
  openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
    '-subj', `/CN=${name}`, '-keyout', `${name}.key`, '-out', `${name}.crt`);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mtls-'));
  makeCa('plane-ca');
  makeCa('other-ca');
  const leaf = (ca: string, name: string) => {
    execFileSync('openssl', ['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', `/CN=${name}`,
      '-keyout', `${name}.key`, '-out', `${name}.csr`], { cwd: dir, stdio: 'pipe' });
    execFileSync('openssl', ['x509', '-req', '-in', `${name}.csr`, '-CA', `${ca}.crt`, '-CAkey', `${ca}.key`,
      '-CAcreateserial', '-days', '1', '-out', `${name}.crt`, '-extfile', 'san.cnf'], {
      cwd: dir,
      stdio: 'pipe',
    });
    return { key: readFileSync(join(dir, `${name}.key`)), cert: readFileSync(join(dir, `${name}.crt`)), ca: readFileSync(join(dir, `${ca}.crt`)) };
  };
  execFileSync('sh', ['-c', 'printf "subjectAltName=DNS:localhost,IP:127.0.0.1\\n" > san.cnf'], { cwd: dir });
  serverTls = leaf('plane-ca', 'server');
  clientTls = leaf('plane-ca', 'client');
  foreignTls = { ...leaf('other-ca', 'intruder'), ca: readFileSync(join(dir, 'plane-ca.crt')) };

  const app = Fastify({ https: internalServerTls(serverTls) });
  app.get('/ping', async () => ({ ok: true }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  url = `https://localhost:${typeof address === 'object' && address ? address.port : 0}/ping`;
  close = () => app.close();
}, 30_000);

afterAll(async () => {
  await close?.();
});

describe('internal mTLS', () => {
  it('accepts a client presenting a certificate from the plane CA', async () => {
    const res = await mtlsFetch(clientTls)(url);
    expect(res.status).toBe(200);
  });

  it('refuses a client with no certificate', async () => {
    const noCert = mtlsFetch({ ...clientTls, cert: Buffer.alloc(0), key: Buffer.alloc(0) });
    await expect(noCert(url)).rejects.toThrow();
  });

  it('refuses a client whose certificate chains to another CA', async () => {
    await expect(mtlsFetch(foreignTls)(url)).rejects.toThrow();
  });

  it('the client refuses a server it cannot verify', async () => {
    const trustsOther = mtlsFetch({ ...clientTls, ca: readFileSync(join(dir, 'other-ca.crt')) });
    await expect(trustsOther(url)).rejects.toThrow();
  });
});
