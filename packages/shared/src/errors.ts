/**
 * RFC 9457 Problem Details. Stable `type` URIs - clients branch on these, so they are API.
 */
export type ProblemType =
  | 'about:blank'
  | 'https://errors.vega.dev/unauthorized'
  | 'https://errors.vega.dev/forbidden'
  | 'https://errors.vega.dev/not-found'
  | 'https://errors.vega.dev/conflict'
  | 'https://errors.vega.dev/rate-limited'
  | 'https://errors.vega.dev/tenant-context-missing'
  | 'https://errors.vega.dev/entitlement-required'
  | 'https://errors.vega.dev/validation'
  | 'https://errors.vega.dev/precondition-failed'
  | 'https://errors.vega.dev/idempotency-conflict'
  | 'https://errors.vega.dev/limit-exceeded'
  | 'https://errors.vega.dev/upstream-unavailable'
  | 'https://errors.vega.dev/internal';

export interface Problem {
  type: ProblemType;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** RFC 9457 §3.2 extension member: field-level validation errors. */
  errors?: Array<{ path: string; message: string }>;
}

export class VegaError extends Error {
  constructor(
    readonly problem: Problem,
    options?: { cause?: unknown },
  ) {
    super(problem.title, options);
    this.name = 'VegaError';
  }
}

export const problems = {
  unauthorized: (detail?: string): Problem => ({
    type: 'https://errors.vega.dev/unauthorized',
    title: 'Authentication required',
    status: 401,
    ...(detail ? { detail } : {}),
  }),
  forbidden: (detail?: string): Problem => ({
    type: 'https://errors.vega.dev/forbidden',
    title: 'Not permitted',
    status: 403,
    ...(detail ? { detail } : {}),
  }),
  notFound: (detail?: string): Problem => ({
    type: 'https://errors.vega.dev/not-found',
    title: 'Not found',
    status: 404,
    ...(detail ? { detail } : {}),
  }),
  tenantContextMissing: (): Problem => ({
    type: 'https://errors.vega.dev/tenant-context-missing',
    title: 'Tenant context was not resolved before data access',
    status: 500,
    detail: 'This is an invariant violation, not a user error. See docs/module1.md section 4.1.',
  }),
  conflict: (detail?: string): Problem => ({
    type: 'https://errors.vega.dev/conflict',
    title: 'Conflict',
    status: 409,
    ...(detail ? { detail } : {}),
  }),
  validation: (errors: Array<{ path: string; message: string }>, detail?: string): Problem => ({
    type: 'https://errors.vega.dev/validation',
    title: 'Request failed validation',
    status: 400,
    errors,
    ...(detail ? { detail } : {}),
  }),
  preconditionFailed: (detail: string): Problem => ({
    type: 'https://errors.vega.dev/precondition-failed',
    title: 'Precondition failed',
    status: 422,
    detail,
  }),
  idempotencyConflict: (detail: string): Problem => ({
    type: 'https://errors.vega.dev/idempotency-conflict',
    title: 'Idempotency key reused with a different request',
    status: 422,
    detail,
  }),
  rateLimited: (retryAfterSeconds: number): Problem => ({
    type: 'https://errors.vega.dev/rate-limited',
    title: 'Too many requests',
    status: 429,
    detail: `Retry after ${retryAfterSeconds} seconds.`,
  }),
  limitExceeded: (limit: string, detail: string): Problem => ({
    type: 'https://errors.vega.dev/limit-exceeded',
    title: `Plan limit reached: ${limit}`,
    status: 403,
    detail,
  }),
  upstreamUnavailable: (service: string): Problem => ({
    type: 'https://errors.vega.dev/upstream-unavailable',
    title: 'A dependency is unavailable',
    status: 503,
    detail: `${service} did not respond. The operation was not completed.`,
  }),
  internal: (): Problem => ({
    type: 'https://errors.vega.dev/internal',
    title: 'Internal error',
    status: 500,
  }),
  entitlementRequired: (feature: string): Problem => ({
    type: 'https://errors.vega.dev/entitlement-required',
    title: 'Not available on this plan',
    status: 403,
    detail: `Feature "${feature}" is not exposed for this plan.`,
  }),
} as const;
