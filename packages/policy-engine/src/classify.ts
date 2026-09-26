import { createHash } from 'node:crypto';

/**
 * DATA CLASSIFICATION — docs/module5.md §5.3. Presidio (a sidecar; the one place Python earns its
 * place in the serving path) finds PII/PHI/PCI with confidence scores; our own patterns find
 * credentials and the beachhead vertical's identifiers. The output is an entity list and a 0–100
 * sensitivity — a GRADED risk input, which is why confidence scores map onto it cleanly.
 *
 * Runs on generated content only (what a step is about to send or write), never on every
 * argument, and results are cached by content digest. Only the digest and the entity list are
 * stored — never the content.
 */

export interface Entity {
  type: string;
  score: number;
  start: number;
  end: number;
  source: 'presidio' | 'pattern';
}

export interface Classification {
  digest: string;
  entities: Entity[];
  sensitivity: number;
  labels: string[];
}

/** Custom recognizers for the professional-services beachhead, sent to Presidio ad hoc. */
export const VERTICAL_RECOGNIZERS = [
  { name: 'account-number', entity: 'ACCOUNT_NUMBER', regex: String.raw`\b(?:ACCT|ACC|Account(?:\s+(?:No\.?|Number|#)))[\s:#-]*\d{6,12}\b`, score: 0.85 },
  { name: 'client-id', entity: 'CLIENT_ID', regex: String.raw`\bCLI-\d{4,8}\b`, score: 0.9 },
  { name: 'matter-number', entity: 'MATTER_NUMBER', regex: String.raw`\bMAT-\d{4}-\d{3,6}\b`, score: 0.9 },
  { name: 'policy-number', entity: 'POLICY_NUMBER', regex: String.raw`\bPOL-\d{6,10}\b`, score: 0.85 },
  { name: 'medical-record', entity: 'MEDICAL_RECORD_NUMBER', regex: String.raw`\bMRN[\s:#-]*\d{6,10}\b`, score: 0.9 },
] as const;

/** Credentials that must never leave in a message (detect-secrets / Gitleaks families). */
export const SECRET_PATTERNS: Array<{ type: string; re: RegExp }> = [
  { type: 'AWS_ACCESS_KEY', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: 'PRIVATE_KEY', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g },
  { type: 'GITHUB_TOKEN', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { type: 'SLACK_TOKEN', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: 'STRIPE_KEY', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
  { type: 'GOOGLE_API_KEY', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { type: 'GENERIC_SECRET', re: /\b(?:api[_-]?key|secret|passw(?:or)?d|token)\s*[:=]\s*['"]?[A-Za-z0-9/+_=-]{16,}/gi },
];

/** Marking words: an author's own label on the content. They can only RAISE sensitivity. */
const MARKINGS: Array<{ label: string; re: RegExp }> = [
  { label: 'CONFIDENTIAL', re: /\b(?:confidential|privileged|attorney[- ]client|under nda)\b/i },
  { label: 'RESTRICTED', re: /\b(?:strictly confidential|restricted[- ]distribution|do not forward)\b/i },
];

const WEIGHT: Record<string, { weight: number; label: string }> = {
  CREDIT_CARD: { weight: 90, label: 'PCI' },
  IBAN_CODE: { weight: 80, label: 'PCI' },
  US_BANK_NUMBER: { weight: 80, label: 'PCI' },
  CRYPTO: { weight: 60, label: 'PCI' },
  US_SSN: { weight: 90, label: 'PII' },
  US_PASSPORT: { weight: 85, label: 'PII' },
  US_DRIVER_LICENSE: { weight: 75, label: 'PII' },
  UK_NHS: { weight: 85, label: 'PHI' },
  MEDICAL_LICENSE: { weight: 60, label: 'PHI' },
  MEDICAL_RECORD_NUMBER: { weight: 90, label: 'PHI' },
  ACCOUNT_NUMBER: { weight: 70, label: 'CONFIDENTIAL' },
  CLIENT_ID: { weight: 50, label: 'CONFIDENTIAL' },
  MATTER_NUMBER: { weight: 50, label: 'CONFIDENTIAL' },
  POLICY_NUMBER: { weight: 60, label: 'CONFIDENTIAL' },
  PERSON: { weight: 25, label: 'PII' },
  EMAIL_ADDRESS: { weight: 25, label: 'PII' },
  PHONE_NUMBER: { weight: 30, label: 'PII' },
  LOCATION: { weight: 15, label: 'PII' },
  IP_ADDRESS: { weight: 20, label: 'PII' },
  DATE_TIME: { weight: 0, label: '' },
  URL: { weight: 0, label: '' },
  NRP: { weight: 20, label: 'PII' },
};

export function digestOf(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** Entities → sensitivity (the strongest finding, plus a little for volume) and labels. */
export function summarize(text: string, entities: Entity[]): Classification {
  const labels = new Set<string>();
  let top = 0;
  for (const e of entities) {
    if (e.source === 'pattern' && e.type in SECRET_TYPES) {
      labels.add('SECRET');
      top = 100;
      continue;
    }
    const w = WEIGHT[e.type];
    if (!w || !w.weight) continue;
    if (w.label) labels.add(w.label);
    top = Math.max(top, Math.round(w.weight * Math.min(1, e.score)));
  }
  for (const m of MARKINGS) {
    if (m.re.test(text)) {
      labels.add(m.label);
      top = Math.max(top, m.label === 'RESTRICTED' ? 80 : 60);
    }
  }
  const counted = entities.filter((e) => (WEIGHT[e.type]?.weight ?? (e.type in SECRET_TYPES ? 100 : 0)) > 0).length;
  const sensitivity = Math.min(100, top + Math.min(15, 3 * Math.max(0, counted - 1)));
  return { digest: digestOf(text), entities, sensitivity, labels: [...labels].sort() };
}

const SECRET_TYPES: Record<string, true> = Object.fromEntries(SECRET_PATTERNS.map((p) => [p.type, true]));

export function secretEntities(text: string): Entity[] {
  const out: Entity[] = [];
  for (const p of SECRET_PATTERNS) {
    for (const m of text.matchAll(p.re)) out.push({ type: p.type, score: 1, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, source: 'pattern' });
  }
  return out;
}

export interface Classifier {
  classify(text: string): Promise<Classification>;
}

export class ClassifierUnavailable extends Error {}

/** Presidio's analyzer over HTTP, with the vertical recognizers ad hoc and our secret patterns. */
export class PresidioClassifier implements Classifier {
  constructor(
    private readonly baseUrl: string,
    private readonly opts: { fetchImpl?: typeof fetch; timeoutMs?: number; scoreThreshold?: number } = {},
  ) {}

  async analyze(text: string): Promise<Entity[]> {
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(`${this.baseUrl.replace(/\/$/, '')}/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 2_000),
        body: JSON.stringify({
          text,
          language: 'en',
          score_threshold: this.opts.scoreThreshold ?? 0.35,
          ad_hoc_recognizers: VERTICAL_RECOGNIZERS.map((r) => ({ name: r.name, supported_language: 'en', supported_entity: r.entity, patterns: [{ name: r.name, regex: r.regex, score: r.score }] })),
        }),
      });
    } catch (cause) {
      throw new ClassifierUnavailable('Presidio unreachable', { cause });
    }
    if (res.status !== 200) throw new ClassifierUnavailable(`Presidio answered ${res.status}`);
    const found = (await res.json()) as Array<{ entity_type: string; score: number; start: number; end: number }>;
    return found.map((f) => ({ type: f.entity_type, score: f.score, start: f.start, end: f.end, source: 'presidio' as const }));
  }

  async classify(text: string): Promise<Classification> {
    if (!text.trim()) return summarize(text, []);
    return summarize(text, [...(await this.analyze(text)), ...secretEntities(text)]);
  }
}

/**
 * Development only, loudly: pattern recognizers without Presidio's NER (no PERSON/LOCATION).
 * Production refuses to start without Presidio.
 */
export class PatternClassifier implements Classifier {
  async classify(text: string): Promise<Classification> {
    const entities: Entity[] = [...secretEntities(text)];
    const add = (type: string, re: RegExp, score: number) => {
      for (const m of text.matchAll(re)) entities.push({ type, score, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, source: 'pattern' });
    };
    add('EMAIL_ADDRESS', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g, 1);
    add('CREDIT_CARD', /\b(?:\d[ -]?){13,16}\b/g, 0.6);
    add('US_SSN', /\b\d{3}-\d{2}-\d{4}\b/g, 0.8);
    add('PHONE_NUMBER', /(?:\+\d{1,3}[ -]?)?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}\b/g, 0.5);
    // Presidio compiles recognizer patterns with IGNORECASE (and DOTALL | MULTILINE); match that.
    for (const r of VERTICAL_RECOGNIZERS) add(r.entity, new RegExp(r.regex, 'gim'), r.score);
    return summarize(text, entities);
  }
}
