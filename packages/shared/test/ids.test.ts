import { describe, expect, it } from 'vitest';
import { ID_PREFIXES, newId } from '../src/ids.js';

describe('ids', () => {
  it('prefixes ids so they are self-describing in logs and audit receipts', () => {
    expect(newId('tenant')).toMatch(/^ten_[0-9a-f-]{36}$/);
    expect(newId('run')).toMatch(/^run_[0-9a-f-]{36}$/);
    expect(newId('action')).toMatch(/^act_[0-9a-f-]{36}$/);
  });

  it('uses a distinct prefix per kind', () => {
    const prefixes = Object.values(ID_PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId('run')));
    expect(ids.size).toBe(500);
  });
});
