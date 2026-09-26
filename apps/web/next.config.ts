import type { NextConfig } from 'next';

/**
 * The web app is same-origin with the API: `/v1/*` is proxied to the gateway, so the session
 * cookie (httpOnly, SameSite=Lax) is sent without CORS and the browser never holds a token
 * script can read. In a cluster the ingress does the same path routing.
 */
const gateway = process.env['GATEWAY_URL'] ?? 'http://localhost:3001';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@vega/contracts', '@vega/shared'],
  // Workspace packages use ESM `.js` specifiers that point at `.ts` sources (the NodeNext
  // convention the services compile with). Webpack maps them; Turbopack does not yet, so the
  // web app builds with webpack (`next build --webpack`).
  webpack(config: { resolve: { extensionAlias?: Record<string, string[]> } }) {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
  async rewrites() {
    return [{ source: '/v1/:path*', destination: `${gateway}/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
