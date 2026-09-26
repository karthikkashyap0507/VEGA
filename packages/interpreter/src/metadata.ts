import { SourceMetadata } from '@vega/contracts';
import type { TaintedValue } from '@vega/taint';

/**
 * TaintedValue → planner-safe metadata (docs/module3.md §7.5). This function is the ONLY bridge
 * from content to the planner, so it emits counts, lengths, booleans and a hostname — never a
 * string the content chose. The result is parsed through the contract schema before it leaves.
 */

const DOMAIN = /^[a-z0-9.-]{1,253}$/;

function domainOf(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const at = v.lastIndexOf('@');
  let host = at >= 0 ? v.slice(at + 1) : v;
  try {
    if (/^https?:\/\//i.test(v)) host = new URL(v).hostname;
  } catch {
    return undefined;
  }
  host = host.replace(/[>\s].*$/, '').toLowerCase();
  // Punycode and every non-hostname character are refused, not transliterated: a homoglyph
  // domain gets no domain at all rather than a misleading one.
  return DOMAIN.test(host) && !host.startsWith('xn--') ? host : undefined;
}

const len = (v: unknown) => (typeof v === 'string' ? v.length : undefined);

export function describeSource(value: TaintedValue, opts: { kind?: SourceMetadata['kind']; binding?: string } = {}): SourceMetadata {
  const d = value.data;
  const o = d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : undefined;
  const wrapped = o ? ['message', 'page', 'file', 'event'].map((k) => o[k]).find((x) => x && typeof x === 'object' && !Array.isArray(x)) : undefined;
  const inner = (wrapped as Record<string, unknown> | undefined) ?? o;
  const list = Array.isArray(d) ? d : o && Array.isArray(o['messages']) ? (o['messages'] as unknown[]) : undefined;
  const meta = {
    id: value.sourceIds[0] ?? value.valueRef,
    taint: value.taint,
    kind: opts.kind ?? (list ? 'collection' : inner && 'subject' in inner ? 'email' : inner && 'url' in inner ? 'web' : 'unknown'),
    ...(list ? { itemCount: list.length } : {}),
    ...(inner && domainOf(inner['from'] ?? inner['url']) ? { fromDomain: domainOf(inner['from'] ?? inner['url'])! } : {}),
    ...(inner && len(inner['subject']) !== undefined ? { subjectLength: len(inner['subject'])! } : {}),
    ...(inner && (len(inner['body']) ?? len(inner['text'])) !== undefined ? { bodyLength: (len(inner['body']) ?? len(inner['text']))! } : {}),
    ...(inner && 'hasAttachments' in inner ? { hasAttachments: Boolean(inner['hasAttachments']) } : {}),
    ...(opts.binding ? { binding: opts.binding } : {}),
  };
  return SourceMetadata.parse(meta);
}
