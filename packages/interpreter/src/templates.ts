/**
 * render() templates. Text is assembled from a FIXED template plus context values; context values
 * are neutralized first, because rendering is an exfiltration channel (docs/module3.md §11.1:
 * "Markdown image with data in the URL; tracking pixel"):
 *   · markdown image / link syntax and HTML tags are defused, so no client fetches a URL
 *   · bare URLs are defanged (hxxps://) so they are not auto-linked
 *   · control, zero-width and bidi-override characters are removed
 * The result's taint is the join of its context (the interpreter applies that, not this file).
 */

// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

export function neutralize(s: string): string {
  return s
    .replace(INVISIBLE, '')
    .replace(/!\[/g, '[')
    .replace(/\]\(/g, '] (')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\b(https?):\/\//gi, (_, p: string) => `${p.replace(/t/gi, 'x')}://`)
    .slice(0, 20_000);
}

function text(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(', ');
  if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${text(x)}`).join('; ');
  return neutralize(String(v));
}

const field = (ctx: unknown, k: string) => (ctx && typeof ctx === 'object' ? (ctx as Record<string, unknown>)[k] : undefined);

export const TEMPLATES: Record<string, (ctx: unknown) => string> = {
  'meeting-offer': (c) => {
    const times = field(c, 'times');
    const list = Array.isArray(times) && times.length ? times.map((t) => `  - ${text(t)}`).join('\n') : '  (no times available)';
    return `Thanks for reaching out. I can do any of these times:\n${list}\n\nLet me know which works best.`;
  },
  reply: (c) => `${text(field(c, 'greeting') ?? 'Hi,')}\n\n${text(field(c, 'body'))}\n\n${text(field(c, 'signoff') ?? 'Best regards')}`,
  summary: (c) => `Summary: ${text(field(c, 'text'))}${field(c, 'topics') ? `\nTopics: ${text(field(c, 'topics'))}` : ''}`,
  plain: (c) => text(c),
};

export function hasTemplate(name: string): boolean {
  return Object.hasOwn(TEMPLATES, name);
}

export function renderTemplate(name: string, ctx: unknown): string {
  const t = TEMPLATES[name];
  if (!t) throw new Error(`no template ${name}`);
  return t(ctx);
}
