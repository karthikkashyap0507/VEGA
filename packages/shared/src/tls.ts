import { readFileSync } from 'node:fs';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * mTLS between planes (module1.md §3.1, §10: "mTLS between namespaces").
 *
 * No service mesh (TECHSTACK §6: "Four services do not need a mesh"), so each internal server
 * terminates TLS itself and REQUIRES a client certificate from the same plane CA, and each
 * internal client presents one. cert-manager issues and rotates the certificates
 * (infra/helm); this module only loads them.
 *
 * Absent TLS_* configuration a service runs plain HTTP — local development only. In a
 * cluster the chart always mounts certificates, and Cilium's default-deny is the second,
 * independent control.
 */

export interface TlsMaterial {
  key: Buffer;
  cert: Buffer;
  ca: Buffer;
}

export function loadTls(env: NodeJS.ProcessEnv = process.env): TlsMaterial | undefined {
  const certPath = env['TLS_CERT_PATH'];
  const keyPath = env['TLS_KEY_PATH'];
  const caPath = env['TLS_CA_PATH'];
  if (!certPath && !keyPath && !caPath) return undefined;
  if (!certPath || !keyPath || !caPath) {
    throw new Error('TLS_CERT_PATH, TLS_KEY_PATH and TLS_CA_PATH must be set together');
  }
  return { cert: readFileSync(certPath), key: readFileSync(keyPath), ca: readFileSync(caPath) };
}

/** Fastify `https` options for an internal server: client certificates required, TLS 1.3. */
export function internalServerTls(tls: TlsMaterial) {
  return {
    key: tls.key,
    cert: tls.cert,
    ca: tls.ca,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.3' as const,
  };
}

/** A fetch that presents this workload's certificate and trusts only the plane CA. */
export function mtlsFetch(tls: TlsMaterial): typeof fetch {
  const dispatcher = new Agent({
    connect: { key: tls.key, cert: tls.cert, ca: tls.ca, minVersion: 'TLSv1.3', rejectUnauthorized: true },
  });
  // undici's own fetch, so the dispatcher and the fetch implementation are the same version.
  return ((input: string | URL, init?: Record<string, unknown>) =>
    undiciFetch(input, { ...init, dispatcher } as never)) as unknown as typeof fetch;
}
