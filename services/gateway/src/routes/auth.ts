import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { problems, safeEqual } from '@vega/shared';
import { activateInvitedUser, resolveSubject } from '@vega/db';
import { SignupInput } from '@vega/contracts';
import { SYSTEM_TENANT, type OidcClient } from '@vega/idp';
import { sessionCookieOptions, type GatewayDeps } from '../app.js';
import { defineRoute, sendProblem, type RouteHooks } from '../http.js';
import type { Sealer } from '../sealed.js';

/**
 * Sign-in, session lifecycle, and signup — module1.md §8.1:
 *
 *   Browser → /login → Zitadel OIDC → callback with code
 *     → gateway exchanges code, validates ID token
 *     → resolve users.idp_subject → user + tenant
 *     → mint session (httpOnly, SameSite=Lax, short TTL + refresh)
 *
 * The tenant is decided by `auth_resolve_subject(sub)` where `sub` comes from an id_token
 * whose signature, issuer, audience, expiry and nonce have all been verified. Nothing in the
 * request — no header, query or body — can name a tenant.
 */

interface LoginState {
  state: string;
  codeVerifier: string;
  nonce: string;
  returnTo: string;
}

const LOGIN_STATE_TTL = 600;

/** Only same-site relative paths. `//evil.example` and `/\evil` are protocol-relative tricks. */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) {
    return '/';
  }
  return raw.length > 512 ? '/' : raw;
}

function requireOidc(deps: GatewayDeps, reply: FastifyReply): OidcClient | undefined {
  if (!deps.oidc) {
    sendProblem(reply, problems.upstreamUnavailable('identity provider (not configured)'));
    return undefined;
  }
  return deps.oidc;
}

/**
 * Verified identity → (tenant, user), activating invited users on first sign-in. Returns a
 * reason code instead of throwing so the browser flow can redirect with it.
 */
async function resolveSignIn(subject: string) {
  const matches = await resolveSubject(subject);
  const m = matches[0];
  if (!m) return { error: 'no_account' as const };
  if (m.tenantStatus !== 'active') return { error: 'tenant_inactive' as const };
  if (m.userStatus === 'deactivated') return { error: 'account_deactivated' as const };
  if (m.userStatus === 'invited') await activateInvitedUser(m.tenantId, m.userId);
  return { tenantId: m.tenantId, userId: m.userId };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  hooks: RouteHooks,
  deps: GatewayDeps,
  ctx: { loginSealer: Sealer; cookieName: string },
): void {
  const loginCookie = `${ctx.cookieName}_login`;
  const webRedirect = (path: string) => new URL(path, deps.config.webUrl).toString();

  // ------------------------------------------------------------ browser flow
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/oauth/login',
    summary: 'Begin OIDC sign-in (redirects to the identity provider)',
    tags: ['auth'],
    auth: false,
    query: z.object({ returnTo: z.string().optional(), loginHint: z.string().email().optional() }),
    handler: async ({ reply, query }) => {
      const oidc = requireOidc(deps, reply);
      if (!oidc) return;
      const request = await oidc.createAuthorizationRequest(query.loginHint ? { loginHint: query.loginHint } : {});
      const state: LoginState = {
        state: request.state,
        codeVerifier: request.codeVerifier,
        nonce: request.nonce,
        returnTo: safeReturnTo(query.returnTo),
      };
      reply.setCookie(loginCookie, ctx.loginSealer.seal(state, LOGIN_STATE_TTL), {
        path: '/v1/oauth',
        httpOnly: true,
        secure: deps.config.cookieSecure,
        // Lax is what lets the cookie ride the top-level redirect back from the IdP.
        sameSite: 'lax',
        maxAge: LOGIN_STATE_TTL,
      });
      return reply.redirect(request.url, 302);
    },
  });

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/oauth/callback',
    summary: 'OIDC redirect target',
    tags: ['auth'],
    auth: false,
    query: z.object({
      code: z.string().optional(),
      state: z.string().optional(),
      error: z.string().optional(),
    }),
    handler: async ({ req, reply, query }) => {
      const oidc = requireOidc(deps, reply);
      if (!oidc) return;
      const saved = ctx.loginSealer.open<LoginState>(req.cookies[loginCookie]);
      reply.clearCookie(loginCookie, { path: '/v1/oauth' });

      const fail = (code: string) => reply.redirect(webRedirect(`/login?error=${encodeURIComponent(code)}`), 302);
      if (query.error) return fail(query.error);
      // CSRF defence for the callback: the state must match the sealed cookie this browser
      // was given when it started. Constant-time, since the state is a secret.
      if (!saved || !query.code || !query.state || !safeEqual(saved.state, query.state)) {
        return fail('invalid_state');
      }

      let identity;
      let tokens;
      try {
        tokens = await oidc.exchangeCode(query.code, saved.codeVerifier);
        identity = await oidc.verifyIdToken(tokens.idToken, saved.nonce);
      } catch (error) {
        deps.logger.warn({ err: error }, 'sign-in failed at code exchange or id_token verification');
        return fail('sign_in_failed');
      }

      const resolved = await resolveSignIn(identity.subject);
      if ('error' in resolved) return fail(resolved.error ?? 'no_account');

      const session = await deps.sessions.create({
        tenantId: resolved.tenantId,
        userId: resolved.userId,
        idp: {
          ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
          idToken: tokens.idToken,
        },
        ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}),
        ip: req.ip,
      });
      reply.setCookie(ctx.cookieName, session.token, sessionCookieOptions(deps, session.expiresAt));
      return reply.redirect(webRedirect(saved.returnTo), 302);
    },
  });

  // ------------------------------------------------------------ API clients
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/auth/token',
    summary: 'OIDC code exchange for API clients (PKCE performed by the client)',
    tags: ['auth'],
    auth: false,
    successStatus: 200,
    body: z.object({ code: z.string().min(1), codeVerifier: z.string().min(43).max(128), nonce: z.string().min(1) }),
    response: z.object({ accessToken: z.string(), tokenType: z.literal('Bearer'), expiresIn: z.number() }),
    handler: async ({ req, reply, body }) => {
      const oidc = requireOidc(deps, reply);
      if (!oidc) return;
      let identity;
      let tokens;
      try {
        tokens = await oidc.exchangeCode(body.code, body.codeVerifier);
        identity = await oidc.verifyIdToken(tokens.idToken, body.nonce);
      } catch (error) {
        deps.logger.warn({ err: error }, 'token exchange failed');
        return sendProblem(reply, problems.unauthorized('code exchange failed'));
      }
      const resolved = await resolveSignIn(identity.subject);
      if ('error' in resolved) return sendProblem(reply, problems.forbidden(resolved.error));
      const session = await deps.sessions.create({
        tenantId: resolved.tenantId,
        userId: resolved.userId,
        idp: { ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}), idToken: tokens.idToken },
        ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}),
        ip: req.ip,
      });
      return {
        accessToken: session.token,
        tokenType: 'Bearer' as const,
        expiresIn: Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
      };
    },
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/auth/refresh',
    summary: 'Rotate the session token now',
    tags: ['auth'],
    auth: false,
    successStatus: 200,
    response: z.object({ accessToken: z.string(), tokenType: z.literal('Bearer'), expiresIn: z.number() }),
    handler: async ({ req, reply }) => {
      const header = req.headers.authorization;
      const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
      const token = bearer ?? req.cookies[ctx.cookieName];
      if (!token) return sendProblem(reply, problems.unauthorized('no session'));
      const resolved = await deps.sessions.resolve(token, { forceRotate: true });
      if (!resolved?.rotatedToken) return sendProblem(reply, problems.unauthorized('session is not valid'));
      if (!bearer) {
        reply.setCookie(ctx.cookieName, resolved.rotatedToken, sessionCookieOptions(deps, resolved.expiresAt));
      }
      return {
        accessToken: resolved.rotatedToken,
        tokenType: 'Bearer' as const,
        expiresIn: Math.floor((resolved.expiresAt.getTime() - Date.now()) / 1000),
      };
    },
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/auth/logout',
    summary: 'Revoke this session; returns the IdP end-session URL when there is one',
    tags: ['auth'],
    successStatus: 200,
    response: z.object({ endSessionUrl: z.string().nullable() }),
    handler: async ({ reply, principal }) => {
      const idp = await deps.sessions.revoke(principal.tenantId, principal.sessionId, 'logout');
      reply.clearCookie(ctx.cookieName, { path: '/' });
      const endSessionUrl =
        deps.oidc && idp.idToken
          ? ((await deps.oidc.endSessionUrl(idp.idToken, webRedirect('/'))) ?? null)
          : null;
      return { endSessionUrl };
    },
  });

  // ------------------------------------------------------------ sessions
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/sessions',
    summary: 'Active sessions for the caller (admin console: session and security)',
    tags: ['auth'],
    handler: async ({ principal }) => {
      const rows = await deps.sessions.listActive(principal.tenantId, principal.userId);
      return {
        items: rows.map((r) => ({
          id: r.id,
          current: r.id === principal.sessionId,
          createdAt: r.createdAt.toISOString(),
          lastSeenAt: r.lastSeenAt.toISOString(),
          expiresAt: r.expiresAt.toISOString(),
          userAgent: r.userAgent,
          ip: r.ip,
        })),
      };
    },
  });

  defineRoute(app, hooks, {
    method: 'DELETE',
    url: '/v1/sessions/:id',
    summary: 'Revoke one of the caller\'s sessions',
    tags: ['auth'],
    successStatus: 200,
    params: z.object({ id: z.string().uuid() }),
    handler: async ({ principal, params }) => {
      const owned = await deps.sessions.listActive(principal.tenantId, principal.userId);
      if (!owned.some((s) => s.id === params.id)) return { ok: true };
      await deps.sessions.revoke(principal.tenantId, params.id, 'revoked_by_user');
      return { ok: true };
    },
  });

  // ------------------------------------------------------------ signup (Step 7)
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/signup',
    summary: 'Self-serve signup: provisions a tenant, an owner and a workspace on the free plan',
    tags: ['signup'],
    auth: false,
    body: SignupInput,
    handler: async ({ req, body }) => {
      const input = deps.config.signupAllowPassword ? body : { ...body, password: undefined };
      const control = deps.controlFor({ tenantId: SYSTEM_TENANT, userId: 'system:signup', system: 'signup' });
      const { password: _p, ...safe } = input;
      const result = await control.signup.provision.mutate(input.password ? input : safe);
      deps.logger.info({ tenant_id: result.tenantId, trace_id: req.traceId }, 'tenant provisioned via signup');
      return {
        ...result,
        signInUrl: new URL(`/v1/oauth/login?loginHint=${encodeURIComponent(body.email)}`, deps.config.publicUrl).toString(),
      };
    },
  });
}
