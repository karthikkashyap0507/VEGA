import { FakeProviders, serveProviders } from '@vega/connector-testing';

/**
 * DEVELOPMENT SANDBOX PROVIDER — the provider fakes (Google, Microsoft Graph, Slack) over HTTP,
 * for the local stack and the E2E suite. Start the services with CONNECTOR_SANDBOX_URL pointing
 * here and every provider request (token exchange, Gmail, Calendar…) lands in this process.
 *
 *   POST /__authorize { url, account, provider }  play the user at the consent screen → { code, state }
 *   POST /__seed      { account, from, subject, body }  put a message in a mailbox
 *   GET  /__sent                                    every message actually sent
 *   GET  /__events?account=…                         calendar events
 *   POST /__drafts    { account }                     drafts in a mailbox (Module 6: an undone draft is gone)
 *
 * Never deployed: the services refuse CONNECTOR_SANDBOX_URL in production.
 */
const providers = new FakeProviders();
const port = Number(process.env['SANDBOX_PORT'] ?? 3099);
void serveProviders(providers.fetch, {
  port,
  admin: (path, body) => {
    const b = (body ?? {}) as Record<string, string>;
    if (path === '/__authorize') return providers.core.authorize(b['url']!, b['account']!, (b['provider'] ?? 'google') as 'google');
    if (path === '/__seed') return providers.google.seedMessage(b['account']!, { from: b['from']!, subject: b['subject']!, body: b['body']! });
    if (path === '/__sent') return providers.google.sent;
    if (path === '/__events') return providers.google.events(b['account'] ?? '');
    if (path === '/__drafts') return providers.google.drafts(b['account'] ?? '').map((d) => ({ id: d.id, subject: d.message.headers['Subject'] ?? '', to: d.message.headers['To'] ?? '' }));
    return undefined;
  },
}).then((server) => console.log(`sandbox providers listening on ${server.url}`));
