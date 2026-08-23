import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, withContext } from '../src/logging.js';

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/**
 * The canary appears ONLY as a secret value, never as a key name. Asserting on the value
 * rather than on the substring "secret" matters: a key called `clientSecret` legitimately
 * contains that word, and a test that greps for it passes or fails for the wrong reason.
 */
const CANARY = 'LEAKED-CANARY-8f3a91';

describe('logging redaction', () => {
  // A secret reaching a log is a security incident (module1.md §10, module2.md §10.1).
  // These are the shapes that actually occur: a token nested inside a connector object,
  // and an Authorization header logged alongside a request.
  it.each([
    ['top-level token', { token: CANARY }],
    ['accessToken', { accessToken: CANARY }],
    ['refreshToken', { refreshToken: CANARY }],
    ['clientSecret', { clientSecret: CANARY }],
    ['apiKey', { apiKey: CANARY }],
    ['password', { password: CANARY }],
    ['nested token', { connector: { token: CANARY } }],
    ['nested clientSecret', { oauth: { clientSecret: CANARY } }],
    ['authorization header', { req: { headers: { authorization: `Bearer ${CANARY}` } } }],
  ])('redacts %s', (_label, payload) => {
    const { stream, lines } = capture();
    const log = createLogger('test', { level: 'info' }, stream);

    log.info(payload, 'connector authorized');

    const raw = JSON.stringify(lines());
    expect(raw).not.toContain(CANARY);
    expect(raw).toContain('[redacted]');
  });

  it('keeps non-secret fields intact', () => {
    const { stream, lines } = capture();
    const log = createLogger('test', { level: 'info' }, stream);

    log.info({ connectorId: 'con_123', kind: 'gmail' }, 'authorized');

    const [line] = lines();
    expect(line?.['connectorId']).toBe('con_123');
    expect(line?.['kind']).toBe('gmail');
  });
});

describe('log context', () => {
  // module1.md §12: every line carries tenant_id and trace_id so an alert can be traced
  // to a signed audit entry.
  it('binds tenant_id and trace_id to every line', () => {
    const { stream, lines } = capture();
    const base = createLogger('test', { level: 'info' }, stream);
    const log = withContext(base, { tenant_id: 'ten_1', trace_id: 'abc123' });

    log.info('first');
    log.info('second');

    for (const line of lines()) {
      expect(line['tenant_id']).toBe('ten_1');
      expect(line['trace_id']).toBe('abc123');
    }
  });
});
