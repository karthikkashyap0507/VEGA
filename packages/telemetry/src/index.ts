import { context, trace, type Span, type Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

/**
 * OpenTelemetry setup.
 *
 * THE CORRELATION REQUIREMENT (module1.md §12, module7.md §10): a trace id, a run id, and
 * an audit chain sequence number must be mutually resolvable. Establish the convention now,
 * before there are runs or audit entries to correlate — retrofitting correlation across four
 * planes is far more expensive than carrying the fields from the start.
 */

let provider: NodeTracerProvider | undefined;

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion?: string;
  endpoint?: string;
}

export function initTelemetry(options: TelemetryOptions): NodeTracerProvider {
  if (provider) return provider;

  const endpoint =
    options.endpoint ?? process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318';

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? '0.0.0',
    }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })),
    ],
  });

  provider.register();
  return provider;
}

export async function shutdownTelemetry(): Promise<void> {
  await provider?.shutdown();
  provider = undefined;
}

export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}

/** Current W3C trace id, for log correlation. Empty string when there is no active span. */
export function currentTraceId(): string {
  return trace.getSpan(context.active())?.spanContext().traceId ?? '';
}

/**
 * Attributes that must appear on every span carrying tenant context.
 * Kept as a helper so the key names cannot drift between planes.
 */
export function tenantAttributes(input: {
  tenantId: string;
  userId?: string;
  agentId?: string;
  runId?: string;
}): Record<string, string> {
  const attrs: Record<string, string> = { 'vega.tenant_id': input.tenantId };
  if (input.userId) attrs['vega.user_id'] = input.userId;
  if (input.agentId) attrs['vega.agent_id'] = input.agentId;
  if (input.runId) attrs['vega.run_id'] = input.runId;
  return attrs;
}

export { trace, context, propagation } from '@opentelemetry/api';
export type { Span, Tracer };
