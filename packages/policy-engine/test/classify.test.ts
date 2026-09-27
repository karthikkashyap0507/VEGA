import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ClassifierUnavailable, digestOf, PatternClassifier, PresidioClassifier, secretEntities, summarize, VERTICAL_RECOGNIZERS, type Entity } from '../src/index.js';

/**
 * Data classification (docs/module5.md §5.3, §11): the sensitivity mapping and secret patterns
 * offline, and the Presidio sidecar against a labeled professional-services corpus — the
 * acceptance gate is ≥ 95% recall (§12).
 */

const PRESIDIO = process.env['PRESIDIO_TEST_URL'] ?? 'http://localhost:5002';
const here = dirname(fileURLToPath(import.meta.url));

interface Sample {
  text: string;
  entities: Array<{ value: string; type: string }>;
}
const corpus = (JSON.parse(readFileSync(join(here, 'corpus', 'professional-services.json'), 'utf8')) as { samples: Sample[] }).samples;

const ent = (type: string, score = 1, source: Entity['source'] = 'presidio'): Entity => ({ type, score, start: 0, end: 1, source });

describe('sensitivity mapping', () => {
  it('the strongest finding sets the level; confidence scales it', () => {
    expect(summarize('x', [ent('US_SSN')]).sensitivity).toBe(90);
    expect(summarize('x', [ent('US_SSN', 0.5)]).sensitivity).toBe(45);
    expect(summarize('x', [ent('PERSON', 0.85)])).toMatchObject({ sensitivity: 21, labels: ['PII'] });
  });

  it('volume adds a little, capped at +15', () => {
    const many = Array.from({ length: 20 }, () => ent('EMAIL_ADDRESS'));
    expect(summarize('x', many.slice(0, 2)).sensitivity).toBe(28);
    expect(summarize('x', many).sensitivity).toBe(40);
  });

  it('dates and URLs are not sensitive on their own', () => {
    expect(summarize('x', [ent('DATE_TIME'), ent('URL')])).toMatchObject({ sensitivity: 0, labels: [] });
  });

  it('labels follow the entity family and are sorted', () => {
    const c = summarize('x', [ent('CREDIT_CARD'), ent('MEDICAL_RECORD_NUMBER'), ent('PERSON'), ent('MATTER_NUMBER')]);
    expect(c.labels).toEqual(['CONFIDENTIAL', 'PCI', 'PHI', 'PII']);
  });

  it("an author's marking can only raise sensitivity", () => {
    expect(summarize('Privileged & Confidential — attorney-client communication', [])).toMatchObject({ sensitivity: 60, labels: ['CONFIDENTIAL'] });
    expect(summarize('Strictly confidential. Do not forward.', [])).toMatchObject({ sensitivity: 80, labels: ['CONFIDENTIAL', 'RESTRICTED'] });
    expect(summarize('confidential', [ent('US_SSN')]).sensitivity).toBe(90);
  });

  it('stores the digest and the entity list, never the content', () => {
    const text = 'Maria Gonzalez, SSN 536-22-8415';
    const c = summarize(text, [ent('PERSON')]);
    expect(c.digest).toBe(digestOf(text));
    expect(c.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(c)).not.toContain('Gonzalez');
    expect(JSON.stringify(c)).not.toContain('536-22');
  });
});

describe('secret detection (detect-secrets / Gitleaks families)', () => {
  const cases: Array<[string, string]> = [
    ['AWS_ACCESS_KEY', 'use AKIAIOSFODNN7EXAMPLE for the upload'],
    // Assembled, so no PEM header appears in source (invariant SEC-001 guards the repository).
    ['PRIVATE_KEY', `-----BEGIN ${'RSA PRIVATE'} KEY-----\nMIIE...`],
    ['GITHUB_TOKEN', `token ghp_${'a1B2'.repeat(9)}`],
    ['SLACK_TOKEN', 'xoxb-1234567890-abcdefghij'],
    ['STRIPE_KEY', `sk_live_${'4eC39HqLyjWDarjtT1zdp7dc'}`],
    ['GOOGLE_API_KEY', `AIza${'SyA-1234567890abcdefghijklmnopqrstu'}`],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['GENERIC_SECRET', 'api_key = "q8Zr2Lm0Xv7Bn4Kd1Tt9"'],
  ];
  it.each(cases)('%s is found and marks the content SECRET (sensitivity 100)', (type, text) => {
    const found = secretEntities(text);
    expect(found.map((e) => e.type)).toContain(type);
    expect(summarize(text, found)).toMatchObject({ sensitivity: 100, labels: expect.arrayContaining(['SECRET']) as unknown });
  });

  it('ordinary prose is not a secret', () => {
    expect(secretEntities('The password policy requires 12 characters; see the token budget memo.')).toEqual([]);
  });
});

describe('the vertical recognizers', () => {
  // Presidio compiles ad hoc patterns with re.IGNORECASE | re.MULTILINE | re.DOTALL.
  const compiled = (regex: string) => new RegExp(regex, 'gims');

  it('every vertical identifier in the corpus matches its recognizer (Python-regex-compatible patterns)', () => {
    const byEntity = new Map(VERTICAL_RECOGNIZERS.map((r) => [r.entity as string, compiled(r.regex)]));
    let checked = 0;
    for (const s of corpus) {
      for (const e of s.entities) {
        const re = byEntity.get(e.type);
        if (!re) continue;
        checked++;
        expect([...s.text.matchAll(re)].map((m) => m[0]), `${e.type} in "${s.text}"`).toContain(e.value);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(25);
  });

  it('near-misses do not match', () => {
    const all = VERTICAL_RECOGNIZERS.map((r) => compiled(r.regex));
    for (const text of ['CLI-12', 'MAT-24-0117', 'POL-123', 'MRN 123', 'account of 4 people', 'CLIENT-004821']) expect(all.some((re) => re.test(text)), text).toBe(false);
  });
});

describe('PresidioClassifier (contract, no network)', () => {
  it('sends the vertical recognizers ad hoc, at the configured threshold', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify([{ entity_type: 'US_SSN', score: 0.85, start: 4, end: 15 }]), { status: 200 });
    }) as unknown as typeof fetch;
    const c = await new PresidioClassifier('http://presidio.test/', { fetchImpl }).classify('SSN 536-22-8415');
    expect(body).toMatchObject({ language: 'en', score_threshold: 0.35, text: 'SSN 536-22-8415' });
    expect((body['ad_hoc_recognizers'] as unknown[]).length).toBe(VERTICAL_RECOGNIZERS.length);
    expect(c).toMatchObject({ sensitivity: 77, labels: ['PII'] });
  });

  it('is unavailable — never "clean" — when Presidio fails', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const broken = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    await expect(new PresidioClassifier('http://x', { fetchImpl: down }).classify('hello there')).rejects.toBeInstanceOf(ClassifierUnavailable);
    await expect(new PresidioClassifier('http://x', { fetchImpl: broken }).classify('hello there')).rejects.toBeInstanceOf(ClassifierUnavailable);
  });

  it('does not call Presidio for empty content', async () => {
    const never = (async () => {
      throw new Error('called');
    }) as unknown as typeof fetch;
    expect(await new PresidioClassifier('http://x', { fetchImpl: never }).classify('  ')).toMatchObject({ sensitivity: 0, entities: [] });
  });
});

describe('PatternClassifier (development fallback)', () => {
  it('finds the structured identifiers it can', async () => {
    const c = await new PatternClassifier().classify('SSN 536-22-8415, email a@b.example.com, matter MAT-2024-0117, MRN 00482913');
    expect(c.entities.map((e) => e.type)).toEqual(expect.arrayContaining(['US_SSN', 'EMAIL_ADDRESS', 'MATTER_NUMBER', 'MEDICAL_RECORD_NUMBER']));
    expect(c.labels).toEqual(expect.arrayContaining(['PII', 'PHI', 'CONFIDENTIAL']));
  });
});

describe('Presidio recall on the professional-services corpus (≥ 95%, module5.md §12)', () => {
  const presidio = new PresidioClassifier(PRESIDIO, { timeoutMs: 15_000 });

  beforeAll(async () => {
    const ok = await fetch(`${PRESIDIO}/health`).then((r) => r.ok, () => false);
    expect(ok, `Presidio must be reachable at ${PRESIDIO} (docker run -p 5002:3000 mcr.microsoft.com/presidio-analyzer)`).toBe(true);
  });

  it('finds at least 95% of the labeled entities, as the right type, at the right span', async () => {
    let hit = 0;
    let total = 0;
    const misses: string[] = [];
    const perType = new Map<string, { hit: number; total: number }>();
    for (const s of corpus) {
      const found = await presidio.analyze(s.text);
      for (const e of s.entities) {
        const start = s.text.indexOf(e.value);
        expect(start, `corpus value "${e.value}" not in its text`).toBeGreaterThanOrEqual(0);
        const end = start + e.value.length;
        const ok = found.some((f) => f.type === e.type && f.start < end && f.end > start);
        const t = perType.get(e.type) ?? { hit: 0, total: 0 };
        perType.set(e.type, { hit: t.hit + (ok ? 1 : 0), total: t.total + 1 });
        total++;
        if (ok) hit++;
        else misses.push(`${e.type} "${e.value}"`);
      }
    }
    const recall = hit / total;
    console.info(`Presidio recall ${hit}/${total} = ${(recall * 100).toFixed(1)}%`, Object.fromEntries(perType), misses);
    expect(total).toBeGreaterThanOrEqual(100);
    expect(recall, `misses: ${misses.join(', ')}`).toBeGreaterThanOrEqual(0.95);
  }, 120_000);

  it('the labels a policy keys on come through end to end', async () => {
    expect((await presidio.classify('Patient chart MRN 00482913 was requested.')).labels).toContain('PHI');
    expect((await presidio.classify('The retainer was charged to card 4111 1111 1111 1111.')).labels).toContain('PCI');
    expect((await presidio.classify('SSN 536-22-8415 for the return.')).sensitivity).toBeGreaterThanOrEqual(60);
    const secret = await presidio.classify(`Here is the deploy key AKIAIOSFODNN7EXAMPLE`);
    expect(secret).toMatchObject({ sensitivity: 100, labels: expect.arrayContaining(['SECRET']) as unknown });
  });

  it('ordinary business prose stays low', async () => {
    for (const text of ['Can we move the quarterly planning meeting to next week?', 'The draft looks good, please circulate it for comments.', 'Attached is the updated project timeline.']) {
      expect((await presidio.classify(text)).sensitivity, text).toBeLessThan(25);
    }
  });
});
