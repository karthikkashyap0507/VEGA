/**
 * SINGLE SOURCE OF TRUTH FOR ALL BRAND STRINGS.
 *
 * PROJECT.md section 3.1: the product name is a PLACEHOLDER. "VEGA" has a live US trademark
 * (Reg. #5290045, Class 042) plus four active companies in adjacent AI categories. A rename is
 * expected before any public artifact.
 *
 * RULE: no other file in this repository may contain the product name as a literal.
 * `scripts/verify-invariants.mjs` enforces this in CI.
 */

export const BRAND = {
  /** Product name shown to users. */
  name: 'VEGA',
  /** Lowercase slug: package scopes, subdomains, CLI name. */
  slug: 'vega',
  /** Legal entity name, once incorporated. */
  legalName: 'VEGA (placeholder)',
  /** Primary domain, once acquired. */
  domain: 'example.invalid',
  /** Support contact. */
  supportEmail: 'support@example.invalid',
  /** One-line positioning (PROJECT.md section 1.3). */
  tagline: 'Reversible, provable, progressively trusted AI execution.',
} as const;

export type Brand = typeof BRAND;
