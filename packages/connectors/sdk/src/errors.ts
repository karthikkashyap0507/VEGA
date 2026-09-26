import type { ToolErrorCode } from '@vega/contracts';

/**
 * Normalized connector errors (module2.md §5.3). Tools and the runtime throw ToolError; nothing
 * above the SDK ever sees a provider's own status code or error body.
 *
 * `committed` records whether the provider may have applied the side effect before failing. It
 * is what the retry policy consults: an R2/R3 action is never retried when it might be
 * committed (§5.3 "never retry an R2/R3 past commit").
 */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly options: { retryAfterSeconds?: number; committed?: 'no' | 'maybe'; cause?: unknown } = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ToolError';
  }

  get retryAfterSeconds(): number | undefined {
    return this.options.retryAfterSeconds;
  }

  /** Whether the side effect may have happened. Defaults to the conservative answer. */
  get committed(): 'no' | 'maybe' {
    return this.options.committed ?? 'maybe';
  }
}

function retryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/**
 * HTTP status → normalized code. The provider body is summarized, never echoed wholesale:
 * error bodies are where tokens and message contents leak into logs.
 *
 * Commit semantics: a 401/403/404/409/429 means the provider REFUSED the request, so nothing
 * was applied. A 5xx is ambiguous — the provider may have committed before failing.
 */
export function fromHttpStatus(status: number, headers: Headers, summary: string): ToolError {
  const safe = summary.slice(0, 200);
  switch (true) {
    case status === 401:
      return new ToolError('AUTH_EXPIRED', `provider rejected credentials (401): ${safe}`, { committed: 'no' });
    case status === 403:
      return new ToolError('PERMISSION_DENIED', `provider denied the request (403): ${safe}`, { committed: 'no' });
    case status === 404 || status === 410:
      return new ToolError('NOT_FOUND', `not found (${status}): ${safe}`, { committed: 'no' });
    case status === 409 || status === 412:
      return new ToolError('CONFLICT', `conflict (${status}): ${safe}`, { committed: 'no' });
    case status === 429: {
      const after = retryAfter(headers);
      return new ToolError('RATE_LIMITED', `rate limited: ${safe}`, {
        committed: 'no',
        ...(after !== undefined ? { retryAfterSeconds: after } : {}),
      });
    }
    case status === 400 || status === 422:
      return new ToolError('VALIDATION', `provider rejected the arguments (${status}): ${safe}`, { committed: 'no' });
    case status === 502 || status === 503 || status === 504: {
      const after = retryAfter(headers);
      return new ToolError('TRANSIENT', `provider unavailable (${status})`, {
        committed: 'maybe',
        ...(after !== undefined ? { retryAfterSeconds: after } : {}),
      });
    }
    default:
      return new ToolError('PROVIDER_ERROR', `provider error (${status}): ${safe}`, { committed: 'maybe' });
  }
}
