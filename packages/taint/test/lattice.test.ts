import { describe, expect, it } from 'vitest';
import { derive, endorse, fromSource, gt, isTainted, join, leq, literal, pressureOf, TaintProvenanceError, type TaintedValue } from '../src/index.js';

describe('lattice', () => {
  it('join is the least upper bound; join() is bottom', () => {
    expect(join()).toBe('TRUSTED');
    expect(join('TRUSTED', 'ORG')).toBe('ORG');
    expect(join('ORG', 'UNTRUSTED', 'TRUSTED')).toBe('UNTRUSTED');
    expect(leq('TRUSTED', 'UNTRUSTED')).toBe(true);
    expect(gt('ORG', 'ORG')).toBe(false);
    expect(pressureOf('UNTRUSTED')).toBe(1);
  });

  it('rejects values that are not levels', () => {
    expect(() => join('SAFE' as never)).toThrow(TypeError);
  });
});

describe('TaintedValue', () => {
  it('derive joins inputs and context; nothing lowers taint', () => {
    const a = literal('x', 'v1');
    const b = fromSource('evil', { sourceId: 'gmail:m1', taint: 'UNTRUSTED' }, 'v2');
    const c = derive('xevil', [a, b], 'v3');
    expect(c.taint).toBe('UNTRUSTED');
    expect(c.sourceIds).toEqual(['gmail:m1']);
    const d = derive('y', [a], 'v4', { context: 'ORG' });
    expect(d.taint).toBe('ORG');
  });

  it('context raises taint but not dataTaint; endorse lowers only dataTaint', () => {
    const lit = literal('boss@acme.example', 'v1');
    const inBranch = derive(lit.data, [lit], 'v2', { context: 'UNTRUSTED' });
    expect([inBranch.taint, inBranch.dataTaint]).toEqual(['UNTRUSTED', 'TRUSTED']);
    const key = fromSource('bob@acme.example', { sourceId: 'gmail:m1', taint: 'UNTRUSTED' }, 'v3');
    const entity = endorse({ email: 'bob@acme.example' }, key, { name: 'directory', taint: 'TRUSTED' }, 'v4');
    expect([entity.taint, entity.dataTaint]).toEqual(['UNTRUSTED', 'TRUSTED']);
    expect(entity.sourceIds).toEqual(['gmail:m1', 'registry:directory']);
  });

  it('forged values are detected and refused', () => {
    const forged = { data: 'x', taint: 'TRUSTED', sourceIds: [], valueRef: 'f' } as unknown as TaintedValue;
    expect(isTainted(forged)).toBe(false);
    expect(() => derive('y', [forged], 'v')).toThrow(TaintProvenanceError);
    const clone = JSON.parse(JSON.stringify(literal('x', 'v'))) as TaintedValue;
    expect(isTainted(clone)).toBe(false);
  });

  it('values are immutable', () => {
    const v = fromSource('x', { sourceId: 's', taint: 'UNTRUSTED' }, 'v');
    expect(() => {
      (v as { taint: string }).taint = 'TRUSTED';
    }).toThrow();
    expect(v.taint).toBe('UNTRUSTED');
  });
});
