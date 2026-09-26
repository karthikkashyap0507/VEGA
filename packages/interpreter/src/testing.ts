import type { ToolDeclarationRecord, ToolResult } from '@vega/contracts';
import type { DeclarationPort, ExtractorPort, ToolPort } from './ports.js';

/**
 * Test doubles shared by the interpreter tests, the red-team corpus and the soundness suite.
 *
 * `RecordingTools` answers every call from a scripted inbox/web/drive and RECORDS what was
 * executed, so a suite can assert on exactly which effects happened with which arguments.
 * `AdversarialExtractor` is the worst case the architecture must survive: an extractor fully
 * controlled by the attacker, returning whatever values the attacker wants within the schema.
 */

export interface ScriptedMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
}

export interface ExecutedCall {
  toolId: string;
  nodeId: string;
  args: Record<string, unknown>;
  mode: 'execute' | 'simulate';
}

const env = <T>(value: T, sourceId: string, taint: 'TRUSTED' | 'ORG' | 'UNTRUSTED') => ({ value, sourceId, taint });

export class RecordingTools implements ToolPort {
  readonly executed: ExecutedCall[] = [];
  inbox: ScriptedMessage[] = [];
  pages = new Map<string, string>();
  files = new Map<string, string>();

  async invoke(input: { toolId: string; nodeId: string; args: Record<string, unknown>; mode: 'execute' | 'simulate' }): Promise<ToolResult<unknown>> {
    this.executed.push({ toolId: input.toolId, nodeId: input.nodeId, args: structuredClone(input.args), mode: input.mode });
    const a = input.args;
    const ok = (detail: unknown, summary = input.toolId): ToolResult<unknown> => ({
      ok: true,
      effect: { summary, fidelity: input.mode === 'simulate' ? 'DERIVED' : 'PROVIDER', externalRecipients: [], recordsAffected: [], detail },
    });
    switch (input.toolId) {
      case 'gmail.search':
      case 'outlook.search':
        return ok({ messages: this.inbox.map((m) => env({ id: m.id, from: m.from, subject: m.subject, snippet: m.body.slice(0, 100) }, `gmail:${m.id}`, 'UNTRUSTED')) });
      case 'gmail.read':
      case 'outlook.read': {
        const m = this.inbox.find((x) => x.id === a['messageId']);
        return ok({ message: m ? env({ id: m.id, from: m.from, subject: m.subject, body: m.body }, `gmail:${m.id}`, 'UNTRUSTED') : null });
      }
      case 'web.fetch': {
        const url = String(a['url']);
        return ok({ page: env({ url, title: 'page', text: this.pages.get(url) ?? '', contentType: 'text/html', truncated: false }, `web:${url}`, 'UNTRUSTED') });
      }
      case 'gdrive.read': {
        const id = String(a['fileId']);
        return ok({ file: env({ id, name: id, mimeType: 'text/plain', content: this.files.get(id) ?? '' }, `gdrive:${id}`, 'UNTRUSTED') });
      }
      case 'gcal.list':
        return ok({ events: [env({ id: 'e1', summary: 'Standup', start: '2026-10-01T09:00:00Z', end: '2026-10-01T09:15:00Z', attendees: [], organizer: 'me@acme.example', description: '', location: '' }, 'gcal:e1', 'ORG')] });
      case 'gmail.send':
      case 'outlook.send':
        return ok({ messageId: 'sent-1', threadId: null, recipients: [...((a['to'] as string[]) ?? []), ...((a['cc'] as string[]) ?? [])], subject: String(a['subject'] ?? '') });
      case 'gmail.draft':
        return ok({ draftId: 'd-1', messageId: null, to: (a['to'] as string[]) ?? [], subject: String(a['subject'] ?? '') });
      default:
        return ok({});
    }
  }

  /** Every EXECUTED (not simulated) call to an external-egress tool. */
  externalSends(external: ReadonlySet<string>): ExecutedCall[] {
    return this.executed.filter((c) => c.mode === 'execute' && external.has(c.toolId));
  }
}

export class StaticDeclarations implements DeclarationPort {
  private readonly map: Map<string, ToolDeclarationRecord>;
  constructor(records: Iterable<ToolDeclarationRecord>) {
    this.map = new Map([...records].map((r) => [r.toolId, r]));
  }
  async get(_tenantId: string, toolId: string) {
    return this.map.get(toolId);
  }
  all(): ToolDeclarationRecord[] {
    return [...this.map.values()];
  }
}

/** Returns the attacker's chosen values — the worst case the architecture must contain. */
export class AdversarialExtractor implements ExtractorPort {
  constructor(private readonly choose: (schema: string, content: unknown) => unknown) {}
  async extract(input: { content: unknown; schema: string }) {
    return this.choose(input.schema, input.content);
  }
}
