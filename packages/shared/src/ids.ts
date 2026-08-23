import { randomUUID } from 'node:crypto';

/**
 * Prefixed identifiers. The prefix makes an id self-describing in logs, traces, and audit
 * receipts - which matters when correlating a run_id with an audit sequence number (M7).
 */
export const ID_PREFIXES = {
  tenant: 'ten',
  user: 'usr',
  workspace: 'wsp',
  agent: 'agt',
  run: 'run',
  action: 'act',
  approval: 'apr',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${randomUUID()}`;
}
