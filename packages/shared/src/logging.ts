import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

/**
 * Structured logging.
 *
 * CONVENTION (module1.md §12): every log line carries `tenant_id` and `trace_id`.
 * Once they exist, `run_id` and `action_id` join them. This is what makes it possible to get
 * from an alert to a trace to a signed audit entry in under a minute when a compensation
 * fails at 3am (module6.md §8.3).
 */

/**
 * Redaction paths. A secret reaching a log is a security incident, not a bug — plaintext
 * tokens exist only in memory during a call (module2.md §10.1).
 *
 * Paths are literal because pino redaction does not accept arbitrary regex. When a new
 * secret-bearing field is introduced, it is added here IN THE SAME PR.
 */
export const REDACT_PATHS = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'clientSecret',
  'secret',
  'apiKey',
  'authorization',
  'cookie',
  'sessionSecret',
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.clientSecret',
  '*.secret',
  '*.apiKey',
  '*.authorization',
];

export interface LogContext {
  /** Always present once a request is authenticated. */
  tenant_id?: string;
  /** W3C trace id, correlated with OTel spans and (from M7) audit sequence numbers. */
  trace_id?: string;
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  action_id?: string;
}

/**
 * @param destination optional sink. Supplied by tests; production uses stdout.
 */
export function createLogger(
  name: string,
  options: LoggerOptions = {},
  destination?: DestinationStream,
): Logger {
  const isDev = process.env['NODE_ENV'] !== 'production';
  const pretty = isDev && !destination;

  const opts: LoggerOptions = {
    name,
    level: process.env['LOG_LEVEL'] ?? (isDev ? 'debug' : 'info'),
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: { level: (label) => ({ level: label }) },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
    ...options,
  };

  return destination ? pino(opts, destination) : pino(opts);
}

/** Child logger bound to a request/run context. Prefer this over passing fields per call. */
export function withContext(logger: Logger, context: LogContext): Logger {
  return logger.child(context);
}

export type { Logger };
