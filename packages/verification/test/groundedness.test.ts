import { describe, expect, it } from 'vitest';
import { evidenceFrom, extractClaims, generatedContent, groundedness, match, severity, values, type Evidence } from '../src/index.js';
import { CORPUS } from './corpus.js';

const ev = (id: string, text: string, taint: Evidence['taint'] = 'ORG'): Evidence => ({ id, text, taint });

describe('claim extraction', () => {
  it('finds prices, numbers, dates and commitments; skips pleasantries', () => {
    const claims = extractClaims('body', 'Hi Dana,\n\nThe annual plan is $12,000 for 40 seats, a 15% discount. We will deliver the onboarding by Nov 30. Hope this helps!\n\nBest regards');
    expect(claims.map((c) => [c.kind, c.value ?? c.text])).toEqual([
      ['price', 'usd:12000'],
      ['number', '40'],
      ['number', '15%'],
      ['date', '11-30'],
      ['commitment', 'We will deliver the onboarding by Nov 30.'],
    ]);
  });

  it('normalizes values so "1.2k EUR", "EUR 1,200" and "€1200" are the same claim', () => {
    expect(values('1.2k EUR').map((v) => v.value)).toEqual(['eur:1200']);
    expect(values('EUR 1,200').map((v) => v.value)).toEqual(['eur:1200']);
    expect(values('€1200').map((v) => v.value)).toEqual(['eur:1200']);
    expect(values('2026-11-30 or 30th November').map((v) => v.value)).toEqual(['11-30', '11-30']);
  });

  it('a substantive sentence with no values is a fact claim', () => {
    expect(extractClaims('body', 'Your account manager moved to the enterprise team.')).toEqual([expect.objectContaining({ kind: 'fact' })]);
  });
});

describe('matching', () => {
  it('a value in the evidence supports the claim', () => {
    const [c] = extractClaims('body', 'The price is $1,200 per seat.');
    expect(match(c!, [ev('crm:1', 'List price: USD 1200 per seat')])).toMatchObject({ verdict: 'SUPPORTED', sourceIds: ['crm:1'] });
  });

  it('a different value said about the same thing is a contradiction', () => {
    const [c] = extractClaims('body', 'The hotel cap in Berlin is 250 EUR.');
    expect(match(c!, [ev('kb:1', 'The nightly hotel cap is 180 EUR in Berlin.')])).toMatchObject({ verdict: 'CONTRADICTED', note: 'the source says 180 EUR' });
  });

  it('a value nowhere in the evidence is unsupported', () => {
    const [c] = extractClaims('body', 'We offer a 30% discount.');
    expect(match(c!, [ev('kb:1', 'Discounts are approved by finance.')]).verdict).toBe('UNSUPPORTED');
  });

  it('support from untrusted content alone is marked, and does not count as grounded for blocking kinds', () => {
    const [c] = extractClaims('body', 'Please pay $9,800 today.');
    const m = match(c!, [ev('email:1', 'Invoice total $9,800, pay today', 'UNTRUSTED')]);
    expect(m).toMatchObject({ verdict: 'SUPPORTED', untrustedOnly: true });
    expect(severity('price', 'SUPPORTED', 'HIGH', true)).toBe('WARN');
  });
});

describe('severity', () => {
  it('blocks unsupported numbers, prices, dates and commitments only at HIGH and above', () => {
    for (const k of ['number', 'price', 'date', 'commitment'] as const) {
      expect(severity(k, 'UNSUPPORTED', 'HIGH')).toBe('BLOCK');
      expect(severity(k, 'CONTRADICTED', 'CRITICAL')).toBe('BLOCK');
      expect(severity(k, 'UNSUPPORTED', 'MEDIUM')).toBe('WARN');
    }
    expect(severity('fact', 'UNSUPPORTED', 'CRITICAL')).toBe('WARN');
    expect(severity('price', 'SUPPORTED', 'CRITICAL')).toBe('INFO');
  });
});

describe('content and evidence helpers', () => {
  it('only free-text arguments are content; recipients and ids are not', () => {
    expect(generatedContent({ to: ['dana@acme.example'], subject: 'Renewal quote', body: 'The price is $1,200.', id: 'abc123', count: 3 }, ['to'])).toEqual([
      { field: 'subject', text: 'Renewal quote' },
      { field: 'body', text: 'The price is $1,200.' },
    ]);
  });

  it('evidence flattens a tool result, keeping numeric fields with their names', () => {
    expect(evidenceFrom('crm.get:1', { name: 'Acme', seats: 40, notes: ['renewal due Nov 30'] }, 'ORG').text).toBe('Acme\nseats 40.\nrenewal due Nov 30');
  });
});

describe('★ the labeled corpus (§12): BLOCK precision ≥ 90%', () => {
  it('meets the gate', async () => {
    let blocked = 0;
    let correct = 0;
    let bad = 0;
    let caught = 0;
    const misses: string[] = [];
    for (const c of CORPUS) {
      const r = await groundedness([{ field: 'body', text: c.content }], c.evidence.map((e, i) => ev(`e${i}`, e.text, e.taint ?? 'ORG')), c.tier);
      const ungrounded = new Set(c.ungrounded);
      bad += ungrounded.size;
      for (const f of r.findings) {
        if (f.severity !== 'BLOCK') continue;
        blocked++;
        if (ungrounded.has(f.claim.text)) correct++;
        else misses.push(`${c.name}: blocked "${f.claim.text}"`);
      }
      caught += r.findings.filter((f) => f.severity === 'BLOCK' && ungrounded.has(f.claim.text)).length;
    }
    const precision = correct / blocked;
    const recall = caught / bad;
    // Tracked and printed; precision is the gate (an approver who sees false alarms stops reading).
    console.info(`groundedness corpus: ${CORPUS.length} cases, BLOCK precision ${(precision * 100).toFixed(1)}% (${correct}/${blocked}), recall ${(recall * 100).toFixed(1)}% (${caught}/${bad})`);
    expect(misses).toEqual([]);
    expect(precision).toBeGreaterThanOrEqual(0.9);
    expect(recall).toBeGreaterThanOrEqual(0.8);
  });
});
