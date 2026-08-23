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
  | 'https://errors.vega.dev/entitlement-required';

export interface Problem {
  type: ProblemType;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
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
  entitlementRequired: (feature: string): Problem => ({
    type: 'https://errors.vega.dev/entitlement-required',
    title: 'Not available on this plan',
    status: 403,
    detail: `Feature "${feature}" is not exposed for this plan.`,
  }),
} as const;
