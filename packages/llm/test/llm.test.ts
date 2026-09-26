import { describe, expect, it } from 'vitest';
import { AnthropicClient, LlmError } from '../src/index.js';

describe('AnthropicClient', () => {
  it('forces structured output through a single tool and returns its input', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'out', input: { a: 1 } }], usage: { input_tokens: 5, output_tokens: 2 }, stop_reason: 'tool_use', model: 'm' }), { status: 200 });
    }) as typeof fetch;
    const c = new AnthropicClient({ apiKey: 'k', baseUrl: 'http://gw', fetchImpl });
    const r = await c.complete({ model: 'm', system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 10, outputSchema: { name: 'out', description: 'd', schema: { type: 'object' } } });
    expect(r.json).toEqual({ a: 1 });
    expect(sent['tool_choice']).toEqual({ type: 'tool', name: 'out' });
    expect(sent['temperature']).toBe(0);
  });

  it('maps HTTP failures to retryable / non-retryable errors', async () => {
    const c = (status: number) => new AnthropicClient({ apiKey: 'k', fetchImpl: (async () => new Response('{}', { status })) as typeof fetch });
    await expect(c(429).complete({ model: 'm', system: '', messages: [], maxTokens: 1 })).rejects.toMatchObject({ retryable: true });
    await expect(c(400).complete({ model: 'm', system: '', messages: [], maxTokens: 1 })).rejects.toBeInstanceOf(LlmError);
  });
});
