import { createHash } from 'node:crypto';
import { join, type Taint } from './lattice.js';

/**
 * TaintedValue — docs/module3.md §7.1. Taint is PART of the value, not metadata beside it.
 *
 * There is no way to make one except through this module's constructors:
 *   · the interface carries a unique-symbol brand no other module can name, so an object
 *     literal does not typecheck as a TaintedValue;
 *   · every minted value is recorded in a WeakSet, so a forged object (a cast, a JSON
 *     round-trip, a structuredClone) is detected at runtime by `isTainted()` — the tool gate
 *     fails closed on anything it did not see minted;
 *   · the lint rule `no-taint-cast` forbids `as TaintedValue` casts outside this package.
 */

declare const brand: unique symbol;

export interface TaintedValue<T = unknown> {
  readonly data: T;
  /** Full taint: data dependencies AND the control-flow context the value was produced in. */
  readonly taint: Taint;
  /**
   * Data-dependency taint only (always ⊑ `taint`). Differs from `taint` in two places:
   * values produced inside a branch on tainted data (the branch condition raises `taint`, not
   * `dataTaint`), and `resolve` — an entity looked up in a TRUSTED registry has TRUSTED data
   * even when the lookup key was untrusted. The tool gate checks recipient-class arguments on
   * this; everything else (the aggregate ceiling, approval) uses `taint`.
   */
  readonly dataTaint: Taint;
  /** Transitive closure of the sources this value was derived from, sorted, unique. */
  readonly sourceIds: readonly string[];
  /** Interpreter-assigned id, the key of this value's `derivations` row. */
  readonly valueRef: string;
  readonly [brand]: true;
}

/**
 * The type the privileged planner may never reference (lint: no-untrusted-in-privileged).
 * A value whose taint is not statically known to be TRUSTED is, for that purpose, untrusted.
 */
export type Untrusted<T = unknown> = TaintedValue<T>;

const minted = new WeakSet<object>();

function mint<T>(data: T, taint: Taint, dataTaint: Taint, sourceIds: Iterable<string>, valueRef: string): TaintedValue<T> {
  const v = Object.freeze({
    data,
    taint: join(taint, dataTaint),
    dataTaint,
    sourceIds: Object.freeze([...new Set(sourceIds)].sort()),
    valueRef,
  }) as unknown as TaintedValue<T>;
  minted.add(v);
  return v;
}

/** True only for values this module minted. Forgeries (casts, clones, JSON) are false. */
export function isTainted(v: unknown): v is TaintedValue {
  return typeof v === 'object' && v !== null && minted.has(v);
}

/** A literal written by the TRUSTED principal (or the planner acting on their instruction). */
export function literal<T>(data: T, valueRef: string): TaintedValue<T> {
  return mint(data, 'TRUSTED', 'TRUSTED', [], valueRef);
}

/**
 * Content that ENTERED the system: its label comes from the connector (M2 labels at the
 * source). `sourceId` is the provenance root, e.g. `gmail:msg_44#<digest>`.
 */
export function fromSource<T>(data: T, source: { sourceId: string; taint: Taint }, valueRef: string): TaintedValue<T> {
  return mint(data, source.taint, source.taint, [source.sourceId], valueRef);
}

/**
 * The ONLY way to compute a new value from existing ones. The result taint is the join of
 * every input's taint, the control-flow context, and any extra taint the operation adds (a
 * tool's declared output taint). There is no parameter that lowers it.
 */
export function derive<T>(
  data: T,
  inputs: readonly TaintedValue[],
  valueRef: string,
  opts: { context?: Taint; extra?: readonly Taint[]; extraSources?: readonly string[] } = {},
): TaintedValue<T> {
  for (const i of inputs) {
    if (!isTainted(i)) throw new TaintProvenanceError('input without provenance');
  }
  const extra = opts.extra ?? [];
  const taint = join(...inputs.map((i) => i.taint), opts.context ?? 'TRUSTED', ...extra);
  const dataTaint = join(...inputs.map((i) => i.dataTaint), ...extra);
  const sources = inputs.flatMap((i) => i.sourceIds).concat(opts.extraSources ?? []);
  return mint(data, taint, dataTaint, sources, valueRef);
}

/**
 * ENDORSEMENT — the one operation whose data is less tainted than its input: an entity looked
 * up in a registry the tenant controls (its user directory, its trusted contacts). The attacker
 * can influence WHICH trusted entity is chosen, never inject a new one, so:
 *   · `dataTaint` = the registry's label (TRUSTED) — a recipient-class argument may use it
 *   · `taint` = join(key, context) — the choice was influenced, so approval rules still apply
 * Used only by the interpreter's `resolve` operation; the property suite asserts nothing else
 * ever lowers dataTaint.
 */
export function endorse<T>(
  data: T,
  key: TaintedValue,
  registry: { name: string; taint: Taint },
  valueRef: string,
  opts: { context?: Taint } = {},
): TaintedValue<T> {
  if (!isTainted(key)) throw new TaintProvenanceError('resolve key without provenance');
  return mint(data, join(key.taint, opts.context ?? 'TRUSTED'), registry.taint, [...key.sourceIds, `registry:${registry.name}`], valueRef);
}

export class TaintProvenanceError extends Error {
  constructor(message: string) {
    super(`unresolved provenance: ${message}`);
    this.name = 'TaintProvenanceError';
  }
}

/** Content digest for `sources.digest` — sha256 over a canonical JSON rendering. */
export function digestOf(data: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(data)).digest('hex')}`;
}

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}
