import type { EntryFacets } from '@vega/db/evidence';

/**
 * The Audit Explorer's facets (module7.md §6.1), read out of a payload at append time. They are
 * stored beside the entry, not hashed: anyone can recompute them from the payload, which is.
 *
 * Two payload shapes reach the chain: the receipt (§5.1, snake_case — what an auditor reads) and
 * the platform's own events (camelCase: compensations, policy activations, pack builds). Both
 * are read; whichever names a field wins.
 */
const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v.slice(0, 300) : typeof v === 'number' ? String(v) : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function facetsOf(kind: string, payload: Record<string, unknown>): EntryFacets {
  const actor = obj(payload['actor']);
  const tool = obj(payload['tool']);
  const risk = obj(payload['risk']);
  const policy = obj(payload['policy']);
  const subjects = new Set<string>();
  for (const s of Array.isArray(payload['subjects']) ? payload['subjects'] : []) {
    const v = str(s);
    if (v) subjects.add(v.toLowerCase());
  }
  return {
    runId: str(payload['run_id']) ?? str(payload['runId']),
    actionId: str(payload['action_id']) ?? str(payload['actionId']),
    actor: str(actor['principal']) ?? str(payload['actorId']) ?? str(payload['requestedBy']),
    agentId: str(actor['agent']) ?? str(payload['agentId']),
    toolId: str(tool['id']) ?? str(payload['toolId']),
    connectorId: str(payload['connector_id']) ?? str(payload['connectorId']),
    riskTier: str(risk['tier']) ?? str(payload['riskTier']),
    decision: str(policy['decision']) ?? str(payload['decision']),
    outcome: str(payload['outcome']) ?? (kind.startsWith('compensation.') ? kind.slice('compensation.'.length) : null),
    subjects: [...subjects].slice(0, 50),
  };
}
