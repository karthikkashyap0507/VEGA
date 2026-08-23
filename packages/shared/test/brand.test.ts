import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BRAND } from '../src/brand.js';

describe('brand', () => {
  // PROJECT.md §3.1: the name is a placeholder pending trademark clearance. The rename
  // must stay a one-file change, so every consumer reads from BRAND rather than a literal.
  it('exposes the strings a rename would touch', () => {
    expect(BRAND.name).toBeTruthy();
    expect(BRAND.slug).toMatch(/^[a-z0-9-]+$/);
    expect(BRAND.domain).toBeTruthy();
    expect(BRAND.supportEmail).toContain('@');
  });

  it('documents the placeholder status in the source file', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/brand.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/PLACEHOLDER/i);
    expect(src).toMatch(/trademark/i);
  });
});
