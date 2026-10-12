import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { chunk, cosine, HashingEmbedder, LexicalReranker, parseDocument, parseHtml, parseMarkdown, rrf, UnsupportedFormat } from '../src/index.js';

/** Golden documents: structure is kept, every chunk knows its heading path (§7.1). */

const handbook = `# Travel policy

Employees book economy for flights under six hours.

## Hotels

The nightly cap is 180 EUR in Berlin and 220 EUR in London.

## Per diem

Meals are reimbursed at 45 EUR per day.

# Expenses

Receipts are required above 25 EUR.
`;

function docx(paras: Array<[string | null, string]>): Uint8Array {
  const body = paras.map(([style, text]) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`).join('');
  return zipSync({ 'word/document.xml': strToU8(`<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`), '[Content_Types].xml': strToU8('<Types/>') });
}

describe('structural parsing', () => {
  it('markdown keeps the heading path of every section', () => {
    expect(parseMarkdown(handbook, 'Handbook')).toEqual([
      { headingPath: ['Travel policy'], text: 'Employees book economy for flights under six hours.' },
      { headingPath: ['Travel policy', 'Hotels'], text: 'The nightly cap is 180 EUR in Berlin and 220 EUR in London.' },
      { headingPath: ['Travel policy', 'Per diem'], text: 'Meals are reimbursed at 45 EUR per day.' },
      { headingPath: ['Expenses'], text: 'Receipts are required above 25 EUR.' },
    ]);
  });

  it('html drops scripts and keeps headings, lists and entities', () => {
    const s = parseHtml('<html><script>alert(1)</script><h1>Onboarding</h1><div><p>Day one: laptop &amp; badge.</p></div><h2>Accounts</h2><ul><li>Email</li><li>Chat</li></ul></html>', 'x');
    expect(s).toEqual([
      { headingPath: ['Onboarding'], text: 'Day one: laptop & badge.' },
      { headingPath: ['Onboarding', 'Accounts'], text: '• Email\n\n• Chat' },
    ]);
  });

  it('docx headings come from the Heading styles', async () => {
    const s = await parseDocument(docx([['Title', 'Pricing'], [null, 'List price is 1,200 USD per seat.'], ['Heading2', 'Discounts'], [null, 'Up to 15% for annual plans.']]), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Pricing');
    expect(s).toEqual([
      { headingPath: ['Pricing'], text: 'List price is 1,200 USD per seat.' },
      { headingPath: ['Pricing', 'Discounts'], text: 'Up to 15% for annual plans.' },
    ]);
  });

  it('plain text falls back to the title as heading', async () => {
    expect(await parseDocument(strToU8('one\n\ntwo'), 'text/plain', 'Notes')).toEqual([{ headingPath: ['Notes'], text: 'one\n\ntwo' }]);
  });

  it('layout formats need Docling, and say so', async () => {
    await expect(parseDocument(new Uint8Array([1]), 'application/pdf', 'x')).rejects.toBeInstanceOf(UnsupportedFormat);
    const md = await parseDocument(new Uint8Array([1]), 'application/pdf', 'Deck', { toMarkdown: async () => '# Q3\n\nRevenue grew.' });
    expect(md).toEqual([{ headingPath: ['Q3'], text: 'Revenue grew.' }]);
  });
});

describe('chunking', () => {
  it('a short section is one chunk; a long one splits at paragraphs, never mid-heading', () => {
    const para = (n: number) => Array.from({ length: 60 }, (_, i) => `word${n}x${i}`).join(' ');
    const chunks = chunk([{ headingPath: ['A'], text: 'short' }, { headingPath: ['B', 'C'], text: [para(1), para(2), para(3), para(4), para(5)].join('\n\n') }], 120);
    expect(chunks[0]).toMatchObject({ ordinal: 0, content: 'short', headingPath: ['A'] });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks.slice(1)) {
      expect(c.headingPath).toEqual(['B', 'C']);
      expect(c.tokenCount).toBeLessThanOrEqual(120);
    }
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it('one huge paragraph splits at sentences', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about the quarterly plan.`).join(' ');
    const chunks = chunk([{ headingPath: ['P'], text }], 50);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => /\.$/.test(c.content))).toBe(true);
  });
});

describe('retrieval primitives', () => {
  it('RRF rewards agreement between the lists', () => {
    const fused = rrf([['a', 'b', 'c'], ['c', 'a', 'd']]);
    expect(fused.map((f) => f.id)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('the dev embedder is deterministic, normalized and lexical', async () => {
    const e = new HashingEmbedder();
    const [a, b, c, a2] = await e.embed(['hotel cap in Berlin', 'Berlin hotel nightly cap', 'quarterly revenue grew', 'hotel cap in Berlin']);
    expect(a).toEqual(a2);
    expect(cosine(a!, a!)).toBeCloseTo(1, 6);
    expect(cosine(a!, b!)).toBeGreaterThan(e.sameTopic);
    expect(cosine(a!, c!)).toBeLessThan(0.1);
  });

  it('the lexical reranker puts the passage that answers first', async () => {
    const s = await new LexicalReranker().rerank('hotel cap Berlin', ['Meals are 45 EUR', 'The hotel cap is 180 EUR in Berlin', 'Receipts above 25 EUR']);
    expect(s.indexOf(Math.max(...s))).toBe(1);
  });
});
