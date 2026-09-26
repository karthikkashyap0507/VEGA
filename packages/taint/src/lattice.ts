import { TAINT_ORDER, type TaintLevel } from '@vega/contracts';

/**
 * The taint lattice — docs/module3.md §5.1.
 *
 *     TRUSTED  ⊑  ORG  ⊑  UNTRUSTED        join = least upper bound = most tainted wins
 *
 * These four functions are the whole algebra. Every propagation rule in the interpreter is a
 * join; nothing ever computes a meet (a meet would be a laundering operation).
 */
export type Taint = TaintLevel;

export const TRUSTED: Taint = 'TRUSTED';
export const ORG: Taint = 'ORG';
export const UNTRUSTED: Taint = 'UNTRUSTED';
export const LEVELS: readonly Taint[] = ['TRUSTED', 'ORG', 'UNTRUSTED'];

const BY_RANK: readonly Taint[] = LEVELS;

/** Least upper bound. join() of nothing is TRUSTED (the bottom). */
export function join(...levels: readonly Taint[]): Taint {
  let rank = 0;
  for (const l of levels) {
    const r = TAINT_ORDER[l];
    if (r === undefined) throw new TypeError(`not a taint level: ${String(l)}`);
    if (r > rank) rank = r;
  }
  return BY_RANK[rank]!;
}

/** a ⊑ b */
export function leq(a: Taint, b: Taint): boolean {
  return TAINT_ORDER[a] <= TAINT_ORDER[b];
}

/** a ⊐ b (strictly more tainted) */
export function gt(a: Taint, b: Taint): boolean {
  return TAINT_ORDER[a] > TAINT_ORDER[b];
}

/**
 * How strongly taint should push risk up (M5 consumes this as an input, never as a decision).
 * 0 for TRUSTED, 0.5 for ORG, 1 for UNTRUSTED.
 */
export function pressureOf(t: Taint): number {
  return TAINT_ORDER[t] / 2;
}
