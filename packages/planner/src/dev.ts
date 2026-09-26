import type { LlmClient, LlmRequest, LlmResponse } from '@vega/llm';

/**
 * THE DEVELOPMENT PLANNER — a deterministic stand-in for the planner model when no model key
 * is configured, announced loudly by every service that uses it. It is an `LlmClient`, so it
 * receives exactly what the real model receives — the metadata-only prompt (docs/module3.md
 * §7.5) — and goes through the same parse → validate → one-replan pipeline. It never sees
 * content either; it reads the objective, the resolved entities and the tool list.
 *
 * It knows a handful of objective shapes (the beachhead's everyday requests). Anything else
 * comes back as an explicit "cannot plan", which C2 reports as PLAN_REJECTED with the reason.
 */

interface PromptView {
  objective: string;
  tools: Set<string>;
  entities: Array<{ binding: string; type: string; name?: string; email?: string }>;
  limits?: { maxSteps: number; maxFanout: number };
}

const q = (s: string) => JSON.stringify(s);

function view(req: LlmRequest): PromptView {
  const raw = req.messages.at(-1)?.content ?? '{}';
  const parsed = JSON.parse(raw) as {
    objective?: string;
    available_tools?: Array<{ tool: string }>;
    resolved_entities?: PromptView['entities'];
    limits?: PromptView['limits'];
  };
  return {
    objective: parsed.objective ?? '',
    tools: new Set((parsed.available_tools ?? []).map((t) => t.tool)),
    entities: parsed.resolved_entities ?? [],
    ...(parsed.limits ? { limits: parsed.limits } : {}),
  };
}

/** The first person/contact entity with an address: who "X" is in "email X …". */
const recipient = (v: PromptView) => v.entities.find((e) => (e.type === 'person' || e.type === 'contact') && e.email);

function quoted(text: string): string | undefined {
  return /"([^"]{1,200})"|“([^”]{1,200})”/.exec(text)?.slice(1).find(Boolean);
}

function topic(text: string): string | undefined {
  return quoted(text) ?? /\b(?:about|regarding|re:?)\s+([A-Za-z0-9][\w .-]{1,60}?)(?:[.,;!?]|$)/i.exec(text)?.[1]?.trim();
}

function isoAt(text: string): { start: string; end: string } | undefined {
  const d = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text)?.[1];
  const t = /\b(?:at\s+)?(\d{1,2}):(\d{2})\b/.exec(text);
  if (!d || !t) return undefined;
  const minutes = Number(/\bfor\s+(\d{1,3})\s*(?:min|minutes)\b/i.exec(text)?.[1] ?? 30);
  const start = new Date(`${d}T${t[1]!.padStart(2, '0')}:${t[2]}:00Z`);
  if (Number.isNaN(start.getTime())) return undefined;
  return { start: start.toISOString().replace('.000', ''), end: new Date(start.getTime() + minutes * 60_000).toISOString().replace('.000', '') };
}

/** What the principal wants said: the text after "saying"/"that"/":" (TRUSTED: it is the principal's). */
function message(text: string): string | undefined {
  return /\b(?:saying|that says|to say|with the message)\s+(.{1,2000})$/i.exec(text)?.[1]?.trim() ?? /:\s*(.{1,2000})$/.exec(text)?.[1]?.trim();
}

type Plan = { program: string } | { cannot: string };

export function devPlan(v: PromptView): Plan {
  const text = v.objective.trim();
  const lower = text.toLowerCase();
  const has = (...ids: string[]) => ids.every((id) => v.tools.has(id));
  const who = recipient(v);

  if (/meeting request/.test(lower) || /\b(handle|answer|reply to)\b.*\bmeeting\b/.test(lower)) {
    if (!has('gmail.search', 'gmail.read', 'gmail.draft')) return { cannot: 'needs gmail.search, gmail.read and gmail.draft' };
    return {
      program: [
        `let inbox = call gmail.search({ query: ${q(topic(text) ?? 'meeting')} })`,
        `let msg = call gmail.read({ messageId: inbox.messages[0].id })`,
        `let request = extract msg into MeetingRequest`,
        `let sender = resolve request.fromEmail in contacts`,
        `when sender {`,
        `  call gmail.draft({ to: [sender.email], subject: "Re: meeting", body: render("meeting-offer", { times: request.proposedTimes }) }) as draft`,
        `  emit draft`,
        `} otherwise {`,
        `  emit "The sender is not a trusted contact: no reply was drafted."`,
        `}`,
      ].join('\n'),
    };
  }

  if (/\b(schedule|book|set up|arrange)\b.*\b(meeting|call|sync|event)\b/.test(lower)) {
    if (!has('gcal.create')) return { cannot: 'needs gcal.create' };
    const when = isoAt(text);
    if (!when) return { cannot: 'give the date and time as YYYY-MM-DD at HH:MM (UTC)' };
    const attendees = who ? `[${who.binding}.email]` : '[]';
    const title = topic(text) ?? (who?.name ? `Meeting with ${who.name}` : 'Meeting');
    return { program: `call gcal.create({ summary: ${q(title)}, start: ${q(when.start)}, end: ${q(when.end)}, attendees: ${attendees} }) as event\nemit event` };
  }

  if (/\b(summari[sz]e|digest|what'?s new in|check)\b.*\b(e-?mails?|inbox|mail)\b/.test(lower)) {
    if (!has('gmail.search', 'gmail.read')) return { cannot: 'needs gmail.search and gmail.read' };
    const max = Math.min(5, v.limits?.maxFanout ?? 5);
    return {
      program: [
        `let inbox = call gmail.search({ query: ${q(topic(text) ?? '')} })`,
        `let summaries = map inbox.messages as m limit ${max} { extract call gmail.read({ messageId: m.id }) into Summary }`,
        `emit summaries`,
      ].join('\n'),
    };
  }

  const post = /\bpost\b.*?\b(?:to|in)\s+(#[a-z0-9_-]{1,80})/i.exec(text);
  if (post) {
    if (!has('slack.post')) return { cannot: 'needs slack.post' };
    const body = message(text) ?? quoted(text);
    if (!body) return { cannot: 'say what to post: …saying "<text>"' };
    return { program: `call slack.post({ channel: ${q(post[1]!)}, text: ${q(body)} }) as posted\nemit posted` };
  }

  if (/\b(e-?mail|send|write to|draft)\b/.test(lower)) {
    const draft = /\bdraft\b/.test(lower);
    const tool = draft ? 'gmail.draft' : 'gmail.send';
    if (!has(tool)) return { cannot: `needs ${tool}` };
    if (!who) return { cannot: 'name a recipient in your directory or trusted contacts, or give their address' };
    const body = message(text) ?? quoted(text);
    if (!body) return { cannot: 'say what to write: …saying "<text>"' };
    const subject = topic(text) ?? body.split(/[.!?\n]/)[0]!.slice(0, 80);
    return { program: `call ${tool}({ to: [${who.binding}.email], subject: ${q(subject)}, body: ${q(body)} }) as sent\nemit sent` };
  }

  return { cannot: 'the development planner does not recognise this objective; configure a planner model (ANTHROPIC_API_KEY or LITELLM) for open-ended requests' };
}

export class DevPlannerModel implements LlmClient {
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const plan = devPlan(view(req));
    const text = 'program' in plan ? `\`\`\`dsl\n${plan.program}\n\`\`\`` : `CANNOT_PLAN: ${plan.cannot}`;
    return { text, model: 'dev-planner', usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn' };
  }
}
