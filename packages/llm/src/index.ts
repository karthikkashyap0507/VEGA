/**
 * Minimal Messages-API client (Anthropic wire format, which LiteLLM also speaks — decision
 * D-12: every model call goes through the gateway in deployed environments). Deliberately
 * tiny: the planner and the extractor need one request shape each, and every byte of a
 * dependency here sits on the security boundary.
 *
 * Structured output uses a single forced tool: the model must answer by "calling" a tool whose
 * input schema IS the output schema. Nothing is executed — the tool is a decoding constraint,
 * not a capability.
 */

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  temperature?: number;
  /** Forces a JSON object matching this schema. */
  outputSchema?: { name: string; description: string; schema: Record<string, unknown> };
}

export interface LlmResponse {
  text: string;
  json?: unknown;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface AnthropicClientOptions {
  apiKey: string;
  /** LiteLLM gateway or https://api.anthropic.com */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class AnthropicClient implements LlmClient {
  constructor(private readonly opts: AnthropicClientOptions) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      system: req.system,
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? 0,
      messages: req.messages,
    };
    if (req.outputSchema) {
      body['tools'] = [{ name: req.outputSchema.name, description: req.outputSchema.description, input_schema: req.outputSchema.schema }];
      body['tool_choice'] = { type: 'tool', name: req.outputSchema.name };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 60_000);
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(`${(this.opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.opts.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      throw new LlmError('model endpoint unreachable', undefined, true);
    } finally {
      clearTimeout(timer);
    }
    const data = (await res.json().catch(() => ({}))) as {
      content?: Array<{ type: string; text?: string; input?: unknown }>;
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string;
      error?: { message?: string };
    };
    if (!res.ok) throw new LlmError(`model call failed (${res.status})`, res.status, res.status === 429 || res.status >= 500);
    const blocks = data.content ?? [];
    const toolUse = blocks.find((b) => b.type === 'tool_use');
    return {
      text: blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''),
      ...(toolUse ? { json: toolUse.input } : {}),
      model: data.model ?? req.model,
      usage: { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 },
      stopReason: data.stop_reason ?? 'unknown',
    };
  }
}

/** Records every request (tests assert on captured prompts — e.g. planner isolation). */
export class ScriptedLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly respond: (req: LlmRequest) => Partial<LlmResponse> | Promise<Partial<LlmResponse>>) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone(req));
    const r = await this.respond(req);
    return { text: r.text ?? '', ...(r.json !== undefined ? { json: r.json } : {}), model: req.model, usage: { inputTokens: 0, outputTokens: 0 }, stopReason: r.stopReason ?? 'end_turn' };
  }
}
