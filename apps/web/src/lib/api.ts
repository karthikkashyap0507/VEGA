/**
 * Browser API client. Same-origin (`/v1` is proxied to the gateway), cookie-authenticated,
 * so no token is ever held in JavaScript. Errors arrive as RFC 9457 problems and are thrown
 * as ApiError so forms can show the server's field-level messages.
 */

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: Array<{ path: string; message: string }>;
}

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
  }
  get status() {
    return this.problem.status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  // Mutations carry an Idempotency-Key so a double-click or a retried request after a
  // dropped connection produces one effect (module1.md §7.2).
  if (method !== 'GET') headers['idempotency-key'] = crypto.randomUUID();

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const problem = (data as Problem | undefined) ?? { type: 'about:blank', title: res.statusText, status: res.status };
    throw new ApiError(problem);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

export function loginUrl(returnTo: string, loginHint?: string) {
  const params = new URLSearchParams({ returnTo });
  if (loginHint) params.set('loginHint', loginHint);
  return `/v1/oauth/login?${params.toString()}`;
}
