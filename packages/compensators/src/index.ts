/**
 * @vega/compensators — Module 6, the Reversibility Layer (docs/module6.md).
 *
 * The compensator CONTRACT lives with the connectors (@vega/connector-sdk: `Compensator`,
 * `defineCompensator`, `defineHoldOnly`) because a compensator speaks its provider's API; each
 * connector registers its own. This package is the LIFECYCLE around them: arming and TTLs,
 * strict reverse ordering, bounded retries, sealed tokens, divergence detection, blast-radius
 * aggregation, Time-to-Undo, manual remediation — and the store for all of it.
 */
export type {
  AnyCompensator,
  CompensationConfidence,
  CompensationResult,
  CompensationSideEffects,
  CompensationToken,
  Compensator,
  CompensatorInfo,
  ForwardOutcome,
  HoldOnlyCompensator,
} from '@vega/connector-sdk';
export * from './blast-radius.js';
export * from './divergence.js';
export * from './edit.js';
export * from './lifecycle.js';
export * from './metrics.js';
export * from './remediation.js';
export * from './seal.js';
export * from './store.js';
