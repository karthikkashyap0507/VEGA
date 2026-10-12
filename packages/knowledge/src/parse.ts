import { unzipSync, strFromU8 } from 'fflate';

/**
 * PARSING AND STRUCTURAL CHUNKING — docs/module9.md §7.1. Documents are split along their own
 * structure (headings), and every chunk keeps its heading path — never fixed-size windows that
 * cut a section in half and lose what it was about.
 *
 * Text, Markdown, HTML and DOCX are parsed here (DOCX is a zip of XML; headings are its
 * `Heading1…6` paragraph styles). Layout-heavy formats (PDF, PPTX, scanned images) go to Docling
 * (`docling-serve`, self-hosted), which returns Markdown — then the same chunker.
 */

export interface Section {
  headingPath: string[];
  text: string;
}

export interface Chunk {
  ordinal: number;
  content: string;
  headingPath: string[];
  tokenCount: number;
}

export class UnsupportedFormat extends Error {}

export interface DoclingClient {
  toMarkdown(data: Uint8Array, mime: string, filename: string): Promise<string>;
}

/** docling-serve's `/v1/convert/file` (multipart), Markdown out. */
export function doclingServe(url: string, fetchImpl: typeof fetch = fetch): DoclingClient {
  return {
    async toMarkdown(data, mime, filename) {
      const form = new FormData();
      form.append('files', new Blob([data], { type: mime }), filename);
      form.append('to_formats', 'md');
      const res = await fetchImpl(`${url.replace(/\/$/, '')}/v1/convert/file`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(`docling answered ${res.status}`);
      const body = (await res.json()) as { document?: { md_content?: string } };
      if (!body.document?.md_content) throw new Error('docling returned no markdown');
      return body.document.md_content;
    },
  };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) => s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)));
const squash = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/** Sections from a list of (level, text) blocks: level 0 = body, 1–6 = heading. */
function sectionsFrom(blocks: Array<{ level: number; text: string }>, title: string): Section[] {
  const out: Section[] = [];
  const path: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    const text = squash(buf.join('\n\n'));
    if (text) out.push({ headingPath: path.length ? [...path] : [title], text });
    buf = [];
  };
  for (const b of blocks) {
    const t = squash(b.text);
    if (!t) continue;
    if (b.level > 0) {
      flush();
      path.length = Math.min(path.length, b.level - 1);
      while (path.length < b.level - 1) path.push('');
      path.push(t);
    } else buf.push(t);
  }
  flush();
  return out.map((s) => ({ ...s, headingPath: s.headingPath.filter(Boolean) }));
}

export function parseMarkdown(md: string, title: string): Section[] {
  const blocks: Array<{ level: number; text: string }> = [];
  let para: string[] = [];
  const end = () => {
    if (para.length) blocks.push({ level: 0, text: para.join('\n') });
    para = [];
  };
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      end();
      blocks.push({ level: h[1]!.length, text: h[2]! });
    } else if (!line.trim()) end();
    else para.push(line.replace(/^\s*[-*+]\s+/, '• '));
  }
  end();
  return sectionsFrom(blocks, title);
}

export function parseHtml(html: string, title: string): Section[] {
  const body = html.replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  // Walk the block-level tags in order: every block boundary ends the text before it, so nested
  // containers (a <p> inside a <div>) never swallow or drop their children.
  const blocks: Array<{ level: number; text: string }> = [];
  let level = 0;
  let item = false;
  let buf = '';
  const flush = () => {
    const text = decode(buf.replace(/<[^>]+>/g, ' '));
    if (text.trim()) blocks.push({ level, text: item ? `• ${text}` : text });
    buf = '';
  };
  const BLOCK = /^<(\/?)(h[1-6]|p|li|td|th|tr|pre|blockquote|div|section|article|ul|ol|table|header|footer|main)\b/i;
  for (const part of body.replace(/<br\s*\/?>/gi, '\n').split(/(<\/?[a-z][a-z0-9]*\b[^>]*>)/i)) {
    const m = BLOCK.exec(part);
    if (!m) {
      buf += part;
      continue;
    }
    flush();
    const tag = m[2]!.toLowerCase();
    level = !m[1] && /^h[1-6]$/.test(tag) ? Number(tag[1]) : 0;
    item = !m[1] && tag === 'li';
  }
  flush();
  return sectionsFrom(blocks, title);
}

export function parseDocx(data: Uint8Array, title: string): Section[] {
  let xml: string;
  try {
    const files = unzipSync(data, { filter: (f) => f.name === 'word/document.xml' });
    xml = strFromU8(files['word/document.xml']!);
  } catch {
    throw new UnsupportedFormat('not a readable .docx (word/document.xml missing)');
  }
  const blocks: Array<{ level: number; text: string }> = [];
  for (const p of xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p[0])?.[1] ?? '';
    const level = /^(?:Heading|heading)(\d)$/.exec(style)?.[1] ? Number(/(\d)$/.exec(style)![1]) : style === 'Title' ? 1 : 0;
    const text = decode([...p[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((t) => t[1]).join(''));
    blocks.push({ level, text });
  }
  return sectionsFrom(blocks, title);
}

export async function parseDocument(data: Uint8Array, mime: string, title: string, docling?: DoclingClient): Promise<Section[]> {
  const m = mime.toLowerCase().split(';')[0]!.trim();
  if (m === 'text/markdown' || m === 'text/x-markdown') return parseMarkdown(strFromU8(data), title);
  if (m === 'text/plain') return sectionsFrom(strFromU8(data).replace(/\r\n/g, '\n').split(/\n{2,}/).map((text) => ({ level: 0, text })), title);
  if (m === 'text/html' || m === 'application/xhtml+xml') return parseHtml(strFromU8(data), title);
  if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return parseDocx(data, title);
  if (docling) return parseMarkdown(await docling.toMarkdown(data, m, title), title);
  throw new UnsupportedFormat(`${m} needs the document parser (Docling); set DOCLING_URL`);
}

/** ≈ tokens for budget purposes (words × 1.3; good enough to size chunks, never to bill). */
export const tokenCount = (s: string) => Math.ceil((s.match(/\S+/g)?.length ?? 0) * 1.3);

/** Sections → chunks: a section is one chunk unless it is long; long ones split at paragraphs. */
export function chunk(sections: Section[], maxTokens = 350): Chunk[] {
  const out: Chunk[] = [];
  for (const s of sections) {
    const paras = s.text.split(/\n{2,}/);
    let buf: string[] = [];
    const flush = () => {
      if (!buf.length) return;
      const content = buf.join('\n\n');
      out.push({ ordinal: out.length, content, headingPath: s.headingPath, tokenCount: tokenCount(content) });
      buf = [];
    };
    for (const p of paras) {
      if (tokenCount([...buf, p].join(' ')) > maxTokens && buf.length) flush();
      if (tokenCount(p) > maxTokens) {
        // One huge paragraph: split at sentences.
        let acc = '';
        for (const sent of p.split(/(?<=[.!?])\s+/)) {
          if (tokenCount(`${acc} ${sent}`) > maxTokens && acc) {
            buf.push(acc.trim());
            flush();
            acc = '';
          }
          acc += ` ${sent}`;
        }
        if (acc.trim()) buf.push(acc.trim());
      } else buf.push(p);
    }
    flush();
  }
  return out;
}
