/**
 * GROUNDEDNESS — docs/module9.md §5.2. Generated content is split into atomic claims; each claim
 * is looked for in the run's evidence (what it read, what it was told, the knowledge base); each
 * is SUPPORTED, UNSUPPORTED or CONTRADICTED; severity follows the claim's kind and the step's tier.
 *
 *   numbers, prices, dates, commitments  unsupported → BLOCK at HIGH+, WARN below
 *   other factual sentences              unsupported → WARN (a paraphrase is not a fabrication)
 *   pleasantries, transitions            not claims at all
 *
 * The extractor here is deterministic (patterns, not a model): it is what runs when no model is
 * configured, and it is precise on exactly the kinds that BLOCK — a number either appears in the
 * evidence or it does not. A model-based extractor plugs in through `ClaimExtractor` and its
 * claims are matched the same way.
 */

export type ClaimKind = 'number' | 'price' | 'date' | 'commitment' | 'fact';
export type ClaimVerdict = 'SUPPORTED' | 'UNSUPPORTED' | 'CONTRADICTED';
export type Severity = 'INFO' | 'WARN' | 'BLOCK';
export type Taint = 'TRUSTED' | 'ORG' | 'UNTRUSTED';

export interface Claim {
  kind: ClaimKind;
  /** The argument it came from (body, subject…). */
  field: string;
  /** The words as written (a span of the content). */
  text: string;
  /** Normalized value for number / price / date claims ("1200", "usd:1200", "11-30"). */
  value?: string;
  /** The sentence around it: what the claim is about. */
  context: string;
}

export interface Evidence {
  id: string;
  text: string;
  taint: Taint;
}

export interface Finding {
  claim: Claim;
  verdict: ClaimVerdict;
  severity: Severity;
  /** The evidence that supports (or contradicts) it. */
  sourceIds: string[];
  /** SUPPORTED only by UNTRUSTED content: true is not the same as grounded. */
  untrustedOnly?: boolean;
  note?: string;
}

export interface ClaimExtractor {
  extract(field: string, text: string): Promise<Claim[]>;
}

const STOP = new Set(
  'a an and are as at be by for from has have i in is it its of on or that the this to was were will with you your we our they their he she his her my me us do does did not no but if then so than too very can just also all any per please kind regards thanks thank hi hello dear'.split(' '),
);
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const CURRENCY: Record<string, string> = { $: 'usd', usd: 'usd', '€': 'eur', eur: 'eur', '£': 'gbp', gbp: 'gbp', chf: 'chf', inr: 'inr', '₹': 'inr', jpy: 'jpy', '¥': 'jpy' };

export const contentWords = (s: string) =>
  (s.toLowerCase().normalize('NFKD').match(/[\p{L}]+/gu) ?? []).map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).filter((w) => w.length > 2 && !STOP.has(w));

const num = (s: string) => {
  const n = Number(s.replace(/[,\s']/g, ''));
  return Number.isFinite(n) ? String(n) : s;
};
const scaled = (n: string, unit?: string) => {
  const u = unit?.toLowerCase();
  const m = u === 'k' || u === 'thousand' ? 1e3 : u === 'm' || u === 'million' || u === 'mn' ? 1e6 : u === 'b' || u === 'bn' || u === 'billion' ? 1e9 : 1;
  return String(Number(num(n)) * m);
};

const SENTENCES = /(?<=[.!?])\s+(?=[A-Z0-9"'(])|\n+/;
const PLEASANTRY = /^(hi|hello|hey|dear|thanks|thank you|many thanks|best|kind regards|regards|cheers|sincerely|hope (you|this|all)|looking forward|let me know|please let me know|have a (great|good|nice)|good (morning|afternoon|evening))\b/i;
const COMMITMENT = /\b(we will|we'll|i will|i'll|we shall|we can (offer|guarantee|deliver|ship|refund)|guarantee[sd]?|commit(ted|ment)? to|promise[sd]?|you will receive|will be (delivered|shipped|refunded|credited|paid|completed|ready)|refund(ed)?|waive[sd]?|free of charge|at no (extra )?cost)\b/i;

const PRICE = /(?:([$€£¥₹])\s?(\d[\d,]*(?:\.\d+)?)\s?(k|m|bn|b|million|thousand|billion)?\b)|(?:\b(usd|eur|gbp|chf|inr|jpy)\s?(\d[\d,]*(?:\.\d+)?)\s?(k|m|bn|million|thousand|billion)?\b)|(?:\b(\d[\d,]*(?:\.\d+)?)\s?(k|m|bn|million|thousand|billion)?\s?(usd|eur|gbp|chf|inr|jpy|dollars|euros|pounds)\b)/gi;
const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const MDY = new RegExp(`\\b(${Object.keys(MONTHS).join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi');
const DMY = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${Object.keys(MONTHS).join('|')})[a-z]*\\b`, 'gi');
const WEEKDAY = new RegExp(`\\b(${WEEKDAYS.join('|')})\\b`, 'gi');
const NUMBER = /(?<![\w.$€£¥₹#-])(\d[\d,]*(?:\.\d+)?)\s?(%|percent|k\b|million|thousand|billion)?(?![\w-])/gi;

const curr = (s: string) => CURRENCY[s.toLowerCase()] ?? (s.toLowerCase().startsWith('dollar') ? 'usd' : s.toLowerCase().startsWith('euro') ? 'eur' : s.toLowerCase().startsWith('pound') ? 'gbp' : s.toLowerCase());

/** Values of each kind in a text, normalized, with their spans (so a number inside a price is not counted twice). */
export function values(text: string): Array<{ kind: 'number' | 'price' | 'date'; value: string; span: [number, number]; raw: string }> {
  const out: Array<{ kind: 'number' | 'price' | 'date'; value: string; span: [number, number]; raw: string }> = [];
  const taken = (a: number, b: number) => out.some((o) => a < o.span[1] && b > o.span[0]);
  const add = (kind: 'number' | 'price' | 'date', value: string, m: RegExpMatchArray) => {
    const a = m.index!;
    const b = a + m[0].length;
    if (!taken(a, b)) out.push({ kind, value, span: [a, b], raw: m[0].trim() });
  };
  for (const m of text.matchAll(PRICE)) {
    const [c, n, u] = m[1] ? [m[1], m[2]!, m[3]] : m[4] ? [m[4], m[5]!, m[6]] : [m[9]!, m[7]!, m[8]];
    add('price', `${curr(c!)}:${scaled(n, u)}`, m);
  }
  for (const m of text.matchAll(ISO)) add('date', `${Number(m[2])}-${Number(m[3])}`, m);
  for (const m of text.matchAll(MDY)) add('date', `${MONTHS[m[1]!.toLowerCase().slice(0, 3)] ?? MONTHS[m[1]!.toLowerCase()]}-${Number(m[2])}`, m);
  for (const m of text.matchAll(DMY)) add('date', `${MONTHS[m[2]!.toLowerCase().slice(0, 3)]}-${Number(m[1])}`, m);
  for (const m of text.matchAll(WEEKDAY)) add('date', m[1]!.toLowerCase(), m);
  for (const m of text.matchAll(NUMBER)) {
    const u = m[2]?.toLowerCase();
    add('number', u === '%' || u === 'percent' ? `${num(m[1]!)}%` : scaled(m[1]!, u), m);
  }
  return out.sort((x, y) => x.span[0] - y.span[0]);
}

/** Deterministic extraction: every number / price / date is a claim; so is every commitment and every substantive sentence. */
export function extractClaims(field: string, text: string): Claim[] {
  const claims: Claim[] = [];
  for (const raw of text.split(SENTENCES)) {
    const s = raw.trim();
    if (!s) continue;
    if (PLEASANTRY.test(s) && !values(s).length && !COMMITMENT.test(s)) continue;
    const vs = values(s).filter((v) => !(v.kind === 'number' && /^\d$/.test(v.value))); // "1 attachment", list markers
    for (const v of vs) claims.push({ kind: v.kind, field, text: v.raw, value: v.value, context: s });
    if (COMMITMENT.test(s)) claims.push({ kind: 'commitment', field, text: s, context: s });
    else if (!vs.length && contentWords(s).length >= 4) claims.push({ kind: 'fact', field, text: s, context: s });
  }
  return claims;
}

export const deterministicExtractor: ClaimExtractor = { extract: async (field, text) => extractClaims(field, text) };

const overlap = (claimWords: string[], evidenceWords: Set<string>) => (claimWords.length ? claimWords.filter((w) => evidenceWords.has(w)).length / claimWords.length : 0);

/** One claim against the evidence. */
export function match(claim: Claim, evidence: Evidence[]): { verdict: ClaimVerdict; sourceIds: string[]; untrustedOnly: boolean; note?: string } {
  const supporting: Evidence[] = [];
  const contradicting: Array<{ e: Evidence; saw: string }> = [];
  const ctx = contentWords(claim.context.replace(claim.text, ' '));
  for (const e of evidence) {
    if (claim.value !== undefined) {
      const ev = values(e.text);
      if (ev.some((v) => v.value === claim.value || (claim.kind === 'price' && v.kind === 'number' && claim.value!.endsWith(`:${v.value}`)) || (claim.kind === 'number' && v.kind === 'price' && v.value.endsWith(`:${claim.value}`)))) {
        supporting.push(e);
        continue;
      }
      // A different value of the same kind, said about the same thing: a contradiction.
      for (const sentence of e.text.split(SENTENCES)) {
        const other = values(sentence).find((v) => v.kind === claim.kind && v.value !== claim.value && (claim.kind !== 'price' || v.value.split(':')[0] === claim.value!.split(':')[0]));
        if (!other) continue;
        const sw = new Set(contentWords(sentence));
        if (ctx.length >= 1 && ctx.filter((w) => sw.has(w)).length >= Math.min(2, ctx.length)) contradicting.push({ e, saw: other.raw });
      }
    } else {
      const words = contentWords(claim.text);
      const need = claim.kind === 'commitment' ? 0.6 : 0.5;
      if (overlap(words, new Set(contentWords(e.text))) >= need) supporting.push(e);
    }
  }
  if (supporting.length) {
    const trusted = supporting.filter((e) => e.taint !== 'UNTRUSTED');
    return { verdict: 'SUPPORTED', sourceIds: (trusted.length ? trusted : supporting).map((e) => e.id), untrustedOnly: !trusted.length };
  }
  if (contradicting.length) return { verdict: 'CONTRADICTED', sourceIds: contradicting.map((c) => c.e.id), untrustedOnly: false, note: `the source says ${contradicting[0]!.saw}` };
  return { verdict: 'UNSUPPORTED', sourceIds: [], untrustedOnly: false };
}

const HIGH = new Set(['HIGH', 'CRITICAL']);
const BLOCKABLE = new Set<ClaimKind>(['number', 'price', 'date', 'commitment']);

export function severity(kind: ClaimKind, verdict: ClaimVerdict, tier: string | null | undefined, untrustedOnly = false): Severity {
  if (verdict === 'SUPPORTED') return untrustedOnly && BLOCKABLE.has(kind) ? 'WARN' : 'INFO';
  if (!BLOCKABLE.has(kind)) return 'WARN';
  return HIGH.has(tier ?? '') ? 'BLOCK' : 'WARN';
}

export interface GroundednessReport {
  findings: Finding[];
  claims: number;
  unsupported: number;
  contradicted: number;
  blocking: number;
}

/** The whole pipeline for one step's generated content. */
export async function groundedness(content: Array<{ field: string; text: string }>, evidence: Evidence[], tier: string | null | undefined, extractor: ClaimExtractor = deterministicExtractor): Promise<GroundednessReport> {
  const findings: Finding[] = [];
  for (const c of content) {
    for (const claim of await extractor.extract(c.field, c.text)) {
      const m = match(claim, evidence);
      findings.push({ claim, verdict: m.verdict, severity: severity(claim.kind, m.verdict, tier, m.untrustedOnly), sourceIds: m.sourceIds, ...(m.untrustedOnly ? { untrustedOnly: true } : {}), ...(m.note ? { note: m.note } : {}) });
    }
  }
  return {
    findings,
    claims: findings.length,
    unsupported: findings.filter((f) => f.verdict === 'UNSUPPORTED').length,
    contradicted: findings.filter((f) => f.verdict === 'CONTRADICTED').length,
    blocking: findings.filter((f) => f.severity === 'BLOCK').length,
  };
}

/** The text fields of a call's arguments that hold generated content (not addresses, not ids). */
export function generatedContent(args: Record<string, unknown>, recipientArgs: readonly string[] = []): Array<{ field: string; text: string }> {
  const skip = new Set(recipientArgs.map((p) => p.split('.')[0]!.replace(/\[\]$/, '')));
  const out: Array<{ field: string; text: string }> = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'string') {
      if (/\s/.test(v.trim()) && contentWords(v).length >= 1 && !/^[\w.+-]+@[\w.-]+$/.test(v.trim())) out.push({ field: path, text: v });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  for (const [k, v] of Object.entries(args)) if (!skip.has(k)) walk(v, k);
  return out;
}

/** Evidence from anything JSON-ish a run read: every string leaf, joined per source. */
export function evidenceFrom(id: string, value: unknown, taint: Taint): Evidence {
  const parts: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') parts.push(v);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (typeof x === 'number') parts.push(`${k} ${x}.`);
        else walk(x);
      }
    }
  };
  walk(value);
  return { id, text: parts.join('\n'), taint };
}
