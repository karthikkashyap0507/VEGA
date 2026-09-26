import type { ExtractorPort } from './ports.js';

/**
 * Execution plane → quarantined extractor (services/extractor). A 422 means the model would
 * not produce the schema: the raw output is passed back so the interpreter's own validation
 * records the SCHEMA violation (the interpreter never trusts the extractor's validation either).
 */
export class HttpExtractor implements ExtractorPort {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async extract(input: { content: unknown; schema: string; purpose: string }): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ content: input.content, schema: input.schema, purpose: input.purpose }),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: unknown; error?: { code: string; message: string } };
    if (res.ok || res.status === 422) return body.data;
    throw new Error(`extractor unavailable (${res.status}${body.error ? ` ${body.error.code}` : ''})`);
  }
}
