import { createTRPCClient, httpLink } from '@trpc/client';
import type { AppRouter } from '@vega/service-control';
import type { PrincipalAssertionIssuer, PrincipalClaims } from '@vega/idp';

/**
 * Gateway → control-plane client. One per request, carrying a freshly minted 60-second
 * principal assertion; the control plane verifies it before any procedure runs. `traceparent`
 * propagates the W3C trace so a span in the control plane joins the gateway's trace.
 */

export const PRINCIPAL_HEADER = 'x-principal-assertion';

export type ControlClient = ReturnType<typeof createTRPCClient<AppRouter>>;

export interface ControlClientFactory {
  (claims: PrincipalClaims, traceparent?: string): ControlClient;
}

export function controlClientFactory(
  url: string,
  issuer: PrincipalAssertionIssuer,
  fetchImpl?: typeof fetch,
): ControlClientFactory {
  return (claims, traceparent) =>
    createTRPCClient<AppRouter>({
      links: [
        httpLink({
          url: `${url.replace(/\/$/, '')}/trpc`,
          ...(fetchImpl ? { fetch: fetchImpl as never } : {}),
          headers: async () => ({
            [PRINCIPAL_HEADER]: await issuer.mint(claims),
            ...(traceparent ? { traceparent } : {}),
          }),
        }),
      ],
    });
}
