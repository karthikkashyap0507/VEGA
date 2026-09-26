import { FakeCore } from './core.js';
import { FakeGoogle } from './google.js';
import { FakeMicrosoft } from './microsoft.js';
import { FakeSlack } from './slack.js';

export { FakeCore, json, type Fault, type Grant } from './core.js';
export { FakeGoogle, type FakeEvent, type FakeFile, type FakeMessage } from './google.js';
export { FakeMicrosoft } from './microsoft.js';
export { FakeSlack } from './slack.js';

/**
 * All provider fakes behind one `fetch`. Unrouted hosts are a test bug and throw, rather than
 * silently reaching the real network.
 */
export class FakeProviders {
  readonly core = new FakeCore();
  readonly google = new FakeGoogle(this.core);
  readonly microsoft = new FakeMicrosoft(this.core);
  readonly slack = new FakeSlack(this.core);

  readonly fetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    this.core.calls.push({ method: req.method, url: url.toString() });
    const injected = this.core.fault(url, req.method);
    if (injected) return injected;
    const res =
      (await this.google.handle(req, url)) ?? (await this.microsoft.handle(req, url)) ?? (await this.slack.handle(req, url));
    if (!res) throw new Error(`FakeProviders: no fake for ${req.method} ${url.origin}${url.pathname}`);
    return res;
  }) as typeof fetch;

  /** Grants a token directly (tests that are not about the OAuth flow itself). */
  grant(provider: 'google' | 'microsoft' | 'slack', account: string, scopes: string[]) {
    return this.core.issue(provider, account, scopes);
  }
}
