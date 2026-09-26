import { randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import type { LoadedKey } from './keyfile.js';

/**
 * Zitadel administration: the provisioning half of identity.
 *
 * module1.md §5.5 — one Zitadel ORGANIZATION per tenant, human users inside it, and every agent
 * a MACHINE USER in its own right. This client is the only code that creates those objects.
 *
 * Endpoints were verified against Zitadel v4.19. The v2 user/org API is used where it exists;
 * machine users and project apps still live on the v1 management API.
 *
 * Authentication is the service account's key (RFC 7523 JWT-profile grant), never a shared
 * secret. A personal access token is accepted only so the local bootstrap script can create
 * that service account in the first place.
 */

export type ZitadelAdminAuth =
  | { kind: 'serviceAccount'; key: LoadedKey }
  | { kind: 'pat'; token: string };

export interface ZitadelAdminConfig {
  issuer: string;
  auth: ZitadelAdminAuth;
  fetchImpl?: typeof fetch;
}

export interface CreateHumanInput {
  orgId: string;
  email: string;
  givenName: string;
  familyName: string;
  displayName?: string;
  /** Development and tests only. Production users set their own password via the invite. */
  password?: string;
  emailVerified?: boolean;
}

export interface CreateMachineInput {
  orgId: string;
  /** Unique within the org. We use the agent id, so it is stable and collision-free. */
  username: string;
  name: string;
  description?: string;
}

/**
 * The provisioning surface every other module depends on. An interface so the control plane
 * can run against an in-memory fake in tests and against Zitadel everywhere else — the
 * contract is identical, which is what the integration test asserts.
 */
export interface IdentityAdmin {
  createOrganization(name: string): Promise<{ orgId: string }>;
  createHumanUser(input: CreateHumanInput): Promise<{ userId: string }>;
  /** Returns the code only when the IdP is configured not to send mail itself (local dev). */
  createInviteCode(userId: string, options?: { returnCode?: boolean }): Promise<{ code?: string }>;
  createMachineUser(input: CreateMachineInput): Promise<{ userId: string }>;
  deactivateUser(userId: string): Promise<void>;
  reactivateUser(userId: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
}

export class ZitadelError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ZitadelError';
  }
}

const ADMIN_SCOPE = 'openid urn:zitadel:iam:org:project:id:zitadel:aud';

export class ZitadelAdmin implements IdentityAdmin {
  private cachedToken?: { value: string; expiresAt: number };

  constructor(private readonly config: ZitadelAdminConfig) {}

  private get fetch(): typeof fetch {
    return this.config.fetchImpl ?? globalThis.fetch;
  }

  /** RFC 7523 §2.1 JWT-profile grant. Cached until one minute before expiry. */
  private async accessToken(): Promise<string> {
    const auth = this.config.auth;
    if (auth.kind === 'pat') return auth.token;

    if (this.cachedToken && this.cachedToken.expiresAt - 60_000 > Date.now()) {
      return this.cachedToken.value;
    }

    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: auth.key.keyId })
      .setIssuer(auth.key.clientId)
      .setSubject(auth.key.clientId)
      .setAudience(this.config.issuer)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .setJti(randomBytes(16).toString('base64url'))
      .sign(auth.key.privateKey);

    const res = await this.fetch(new URL('/oauth/v2/token', this.config.issuer), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
        scope: ADMIN_SCOPE,
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body['access_token'] !== 'string') {
      throw new ZitadelError(
        `service account token request failed: ${String(body['error'] ?? res.status)}`,
        res.status,
        body,
      );
    }
    this.cachedToken = {
      value: body['access_token'],
      expiresAt: Date.now() + Number(body['expires_in'] ?? 300) * 1000,
    };
    return this.cachedToken.value;
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    orgId?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.accessToken()}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    // v1 management calls are scoped to an org by header; without it they act on the
    // service account's own org, which would put every tenant's agents in one place.
    if (orgId) headers['x-zitadel-orgid'] = orgId;

    const res = await this.fetch(new URL(path, this.config.issuer), {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const parsed: unknown = text ? safeJson(text) : {};
    if (!res.ok) {
      const message =
        (parsed as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`;
      throw new ZitadelError(`${method} ${path} failed: ${message}`, res.status, parsed);
    }
    return parsed as T;
  }

  async createOrganization(name: string): Promise<{ orgId: string }> {
    const r = await this.call<{ organizationId: string }>('POST', '/v2/organizations', { name });
    return { orgId: r.organizationId };
  }

  async createHumanUser(input: CreateHumanInput): Promise<{ userId: string }> {
    const r = await this.call<{ userId: string }>('POST', '/v2/users/human', {
      organization: { orgId: input.orgId },
      username: input.email,
      profile: {
        givenName: input.givenName,
        familyName: input.familyName,
        ...(input.displayName ? { displayName: input.displayName } : {}),
      },
      email: { email: input.email, isVerified: input.emailVerified ?? false },
      ...(input.password ? { password: { password: input.password, changeRequired: false } } : {}),
    });
    return { userId: r.userId };
  }

  async createInviteCode(
    userId: string,
    options: { returnCode?: boolean } = {},
  ): Promise<{ code?: string }> {
    const r = await this.call<{ inviteCode?: string }>(
      'POST',
      `/v2/users/${encodeURIComponent(userId)}/invite_code`,
      options.returnCode ? { returnCode: {} } : { sendCode: {} },
    );
    return r.inviteCode ? { code: r.inviteCode } : {};
  }

  async createMachineUser(input: CreateMachineInput): Promise<{ userId: string }> {
    const r = await this.call<{ userId: string }>(
      'POST',
      '/management/v1/users/machine',
      {
        userName: input.username,
        name: input.name,
        description: input.description ?? '',
        // JWT access tokens can be verified offline by the execution plane.
        accessTokenType: 'ACCESS_TOKEN_TYPE_JWT',
      },
      input.orgId,
    );
    return { userId: r.userId };
  }

  async deactivateUser(userId: string): Promise<void> {
    await this.call('POST', `/v2/users/${encodeURIComponent(userId)}/deactivate`, {});
  }

  async reactivateUser(userId: string): Promise<void> {
    await this.call('POST', `/v2/users/${encodeURIComponent(userId)}/reactivate`, {});
  }

  async deleteUser(userId: string): Promise<void> {
    await this.call('DELETE', `/v2/users/${encodeURIComponent(userId)}`);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * In-memory IdentityAdmin for unit tests and for running the control plane with no IdP.
 *
 * It enforces the same shape rules that matter downstream: ids are opaque strings, machine
 * usernames are unique per org, and deleted users are gone. It does not pretend to issue
 * tokens — that is the OIDC client's job, tested against a fake issuer with real keys.
 */
export class InMemoryIdentityAdmin implements IdentityAdmin {
  readonly orgs = new Map<string, { name: string }>();
  readonly users = new Map<
    string,
    { orgId: string; kind: 'human' | 'machine'; username: string; active: boolean; email?: string }
  >();
  private seq = 1000;

  private id(): string {
    this.seq += 1;
    return String(this.seq) + randomBytes(3).toString('hex');
  }

  async createOrganization(name: string) {
    const orgId = this.id();
    this.orgs.set(orgId, { name });
    return { orgId };
  }

  async createHumanUser(input: CreateHumanInput) {
    this.requireOrg(input.orgId);
    for (const u of this.users.values()) {
      if (u.orgId === input.orgId && u.username === input.email) {
        throw new ZitadelError('user already exists', 409, {});
      }
    }
    const userId = this.id();
    this.users.set(userId, {
      orgId: input.orgId,
      kind: 'human',
      username: input.email,
      email: input.email,
      active: true,
    });
    return { userId };
  }

  async createInviteCode(userId: string, options: { returnCode?: boolean } = {}) {
    this.requireUser(userId);
    return options.returnCode ? { code: randomBytes(3).toString('hex').toUpperCase() } : {};
  }

  async createMachineUser(input: CreateMachineInput) {
    this.requireOrg(input.orgId);
    for (const u of this.users.values()) {
      if (u.orgId === input.orgId && u.username === input.username) {
        throw new ZitadelError('machine user already exists', 409, {});
      }
    }
    const userId = this.id();
    this.users.set(userId, {
      orgId: input.orgId,
      kind: 'machine',
      username: input.username,
      active: true,
    });
    return { userId };
  }

  async deactivateUser(userId: string) {
    this.requireUser(userId).active = false;
  }

  async reactivateUser(userId: string) {
    this.requireUser(userId).active = true;
  }

  async deleteUser(userId: string) {
    this.requireUser(userId);
    this.users.delete(userId);
  }

  private requireOrg(orgId: string) {
    if (!this.orgs.has(orgId)) throw new ZitadelError(`org ${orgId} not found`, 404, {});
  }

  private requireUser(userId: string) {
    const user = this.users.get(userId);
    if (!user) throw new ZitadelError(`user ${userId} not found`, 404, {});
    return user;
  }
}
