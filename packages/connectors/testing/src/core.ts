import { createHash, randomBytes } from 'node:crypto';

/**
 * Provider fakes — shared machinery.
 *
 * WHAT THESE ARE: in-process emulations of the Google, Microsoft Graph and Slack HTTP APIs,
 * reached through the same `fetch` seam the connectors use in production. They implement the
 * semantics that matter to the rest of the system — scope checks per endpoint, expiring access
 * tokens and refresh, PKCE-verified code exchange, revocation, 429 with Retry-After, and
 * injectable faults — so contract tests exercise real request shapes and real failure modes.
 *
 * WHAT THESE ARE NOT: a substitute for the provider sandbox tenants in docs/module2.md §11.1.
 * The same contract tests run against live sandboxes when credentials are configured
 * (CONNECTOR_SANDBOX=live); until then, a passing fake contract test means "our side is
 * correct against the documented API", not "Google agrees".
 */

export interface Grant {
  provider: 'google' | 'microsoft' | 'slack';
  account: string;
  scopes: Set<string>;
  expiresAt: number;
  refreshToken?: string;
}

export interface Fault {
  match: (url: URL, method: string) => boolean;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** How many requests to affect; Infinity for all. */
  times: number;
}

export interface PendingCode {
  provider: Grant['provider'];
  account: string;
  scopes: string[];
  challenge: string;
  redirectUri: string;
  clientId: string;
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export class FakeCore {
  readonly grants = new Map<string, Grant>();
  readonly refreshTokens = new Map<string, { provider: Grant['provider']; account: string; scopes: string[] }>();
  readonly codes = new Map<string, PendingCode>();
  readonly faults: Fault[] = [];
  readonly calls: Array<{ method: string; url: string }> = [];
  tokenTtlSeconds = 3600;
  now: () => number = Date.now;

  /** Plays the user at the provider's consent screen: returns the code the redirect carries. */
  authorize(authorizationUrl: string, account: string, provider: Grant['provider']): { code: string; state: string } {
    const url = new URL(authorizationUrl);
    const challenge = url.searchParams.get('code_challenge');
    const state = url.searchParams.get('state');
    if (!challenge || !state || url.searchParams.get('code_challenge_method') !== 'S256') {
      throw new Error('authorization request lacks PKCE/state');
    }
    const sep = provider === 'slack' ? ',' : ' ';
    const code = randomBytes(12).toString('hex');
    this.codes.set(code, {
      provider,
      account,
      scopes: (url.searchParams.get('scope') ?? '').split(sep).filter(Boolean),
      challenge,
      redirectUri: url.searchParams.get('redirect_uri') ?? '',
      clientId: url.searchParams.get('client_id') ?? '',
    });
    return { code, state };
  }

  issue(provider: Grant['provider'], account: string, scopes: string[]): { access: string; refresh: string } {
    const access = `${provider}-at-${randomBytes(10).toString('hex')}`;
    const refresh = `${provider}-rt-${randomBytes(10).toString('hex')}`;
    this.grants.set(access, { provider, account, scopes: new Set(scopes), expiresAt: this.now() + this.tokenTtlSeconds * 1000, refreshToken: refresh });
    this.refreshTokens.set(refresh, { provider, account, scopes });
    return { access, refresh };
  }

  /** Token endpoint: authorization_code (with PKCE) and refresh_token grants. */
  async token(provider: Grant['provider'], form: URLSearchParams): Promise<Response> {
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      const pending = this.codes.get(form.get('code') ?? '');
      if (!pending || pending.provider !== provider) return json(400, { error: 'invalid_grant' });
      this.codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      if (createHash('sha256').update(verifier, 'ascii').digest('base64url') !== pending.challenge) {
        return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }
      if (form.get('redirect_uri') !== pending.redirectUri) return json(400, { error: 'invalid_grant' });
      const t = this.issue(provider, pending.account, pending.scopes);
      return json(200, {
        ...(provider === 'slack' ? { ok: true } : {}),
        access_token: t.access,
        refresh_token: t.refresh,
        expires_in: this.tokenTtlSeconds,
        scope: pending.scopes.join(provider === 'slack' ? ',' : ' '),
        token_type: 'Bearer',
      });
    }
    if (grant === 'refresh_token') {
      const r = this.refreshTokens.get(form.get('refresh_token') ?? '');
      if (!r || r.provider !== provider) {
        return json(provider === 'slack' ? 200 : 400, { ...(provider === 'slack' ? { ok: false } : {}), error: 'invalid_grant' });
      }
      const access = `${provider}-at-${randomBytes(10).toString('hex')}`;
      this.grants.set(access, { provider, account: r.account, scopes: new Set(r.scopes), expiresAt: this.now() + this.tokenTtlSeconds * 1000 });
      return json(200, {
        ...(provider === 'slack' ? { ok: true } : {}),
        access_token: access,
        expires_in: this.tokenTtlSeconds,
        scope: r.scopes.join(provider === 'slack' ? ',' : ' '),
        token_type: 'Bearer',
      });
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  /** Revocation: kills the refresh token and every access token from it. */
  revoke(token: string): Response {
    const r = this.refreshTokens.get(token);
    if (r) {
      this.refreshTokens.delete(token);
      for (const [access, g] of this.grants) if (g.refreshToken === token || g.account === r.account) this.grants.delete(access);
      return new Response(null, { status: 200 });
    }
    if (this.grants.delete(token)) return new Response(null, { status: 200 });
    return json(400, { error: 'invalid_token' });
  }

  /** Bearer check + scope check. Returns the grant, or the Response the provider would send. */
  authenticate(req: Request, provider: Grant['provider'], anyOf: string[]): Grant | Response {
    const header = req.headers.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const g = this.grants.get(token);
    if (!g || g.provider !== provider) return this.unauthorized(provider, 'invalid_auth');
    if (g.expiresAt <= this.now()) return this.unauthorized(provider, 'token_expired');
    if (anyOf.length && !anyOf.some((s) => g.scopes.has(s))) {
      return provider === 'slack'
        ? json(200, { ok: false, error: 'missing_scope' })
        : json(403, { error: { code: 403, message: 'Request had insufficient authentication scopes.' } });
    }
    return g;
  }

  private unauthorized(provider: Grant['provider'], reason: string): Response {
    return provider === 'slack' ? json(200, { ok: false, error: reason }) : json(401, { error: { code: 401, message: 'Invalid Credentials' } });
  }

  /** Makes every current access token expire now (refresh tokens stay valid). */
  expireAll(): void {
    for (const g of this.grants.values()) g.expiresAt = this.now() - 1;
  }

  inject(fault: Omit<Fault, 'times'> & { times?: number }): void {
    this.faults.push({ times: 1, ...fault });
  }

  /** Applies the first matching fault, if any. */
  fault(url: URL, method: string): Response | undefined {
    const f = this.faults.find((x) => x.times > 0 && x.match(url, method));
    if (!f) return undefined;
    f.times -= 1;
    return json(f.status, f.body ?? { error: { code: f.status, message: 'injected fault' } }, f.headers ?? {});
  }

  seq = 0;
  id(prefix: string): string {
    this.seq += 1;
    return `${prefix}${this.seq.toString(36)}${randomBytes(3).toString('hex')}`;
  }
}

export async function formOf(req: Request): Promise<URLSearchParams> {
  return new URLSearchParams(await req.text());
}
