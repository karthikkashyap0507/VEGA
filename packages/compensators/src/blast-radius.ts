import type { Effect, Reversibility, SimulationFidelity } from '@vega/contracts';

/**
 * BLAST RADIUS — docs/module6.md §5.6: the EFFECT of a whole program, not its plan. A dry run
 * executes the reads and simulate()s every other call; this folds those effects into what a
 * person needs before it happens:
 *
 *   This run will:
 *     send 1 email        → 1 external domain (northwind.example.com)   R2 · held first
 *     create 1 event      → 4 attendees                                 R1 · can be undone
 *     no financial actions
 *     reads: 12 emails, 3 documents
 *   Simulation fidelity: DERIVED for 2 of 2 actions
 *
 * Fidelity is reported honestly: the minimum across the run, because a blast radius is only as
 * trustworthy as its weakest simulation.
 */

export interface PlannedEffect {
  nodeId: string;
  toolId: string;
  reversibility: Reversibility;
  holdSupported: boolean;
  /** null when the simulation itself failed (then `error` says why). */
  effect: Effect<unknown> | null;
  error?: string | undefined;
}

export type Category = 'email' | 'draft' | 'message' | 'calendar' | 'file' | 'sharing' | 'label' | 'request' | 'other';

interface Kind {
  category: Category;
  verb: string;
  noun: [string, string];
}

const KINDS: Record<string, Kind> = {
  'gmail.send': { category: 'email', verb: 'send', noun: ['email', 'emails'] },
  'outlook.send': { category: 'email', verb: 'send', noun: ['email', 'emails'] },
  'gmail.draft': { category: 'draft', verb: 'create', noun: ['draft', 'drafts'] },
  'outlook.draft': { category: 'draft', verb: 'create', noun: ['draft', 'drafts'] },
  'gmail.label': { category: 'label', verb: 'label', noun: ['message', 'messages'] },
  'gcal.create': { category: 'calendar', verb: 'create', noun: ['event', 'events'] },
  'outlook.event_create': { category: 'calendar', verb: 'create', noun: ['event', 'events'] },
  'gcal.update': { category: 'calendar', verb: 'change', noun: ['event', 'events'] },
  'gcal.delete': { category: 'calendar', verb: 'cancel', noun: ['event', 'events'] },
  'gdrive.write': { category: 'file', verb: 'update', noun: ['file', 'files'] },
  'sharepoint.write': { category: 'file', verb: 'update', noun: ['document', 'documents'] },
  'gdrive.share': { category: 'sharing', verb: 'share', noun: ['file', 'files'] },
  'sharepoint.share': { category: 'sharing', verb: 'share', noun: ['document', 'documents'] },
  'slack.post': { category: 'message', verb: 'post', noun: ['message', 'messages'] },
  'http.request': { category: 'request', verb: 'call', noun: ['external API', 'external APIs'] },
};

const READS: Record<string, [string, string]> = {
  'gmail.search': ['email', 'emails'],
  'gmail.read': ['email', 'emails'],
  'outlook.search': ['email', 'emails'],
  'outlook.read': ['email', 'emails'],
  'gcal.list': ['event', 'events'],
  'gdrive.read': ['document', 'documents'],
  'sharepoint.read': ['document', 'documents'],
  'slack.channels': ['channel', 'channels'],
  'web.fetch': ['web page', 'web pages'],
  'web.search': ['search result', 'search results'],
};

const kindOf = (toolId: string): Kind => KINDS[toolId] ?? { category: 'other', verb: 'run', noun: [toolId, `${toolId} calls`] };
const plural = (n: number, noun: [string, string]) => `${n} ${n === 1 ? noun[0] : noun[1]}`;

const REV_ORDER: Record<Reversibility, number> = { R0: 0, R1: 1, R2: 2, R3: 3 };
const FIDELITY_ORDER: Record<SimulationFidelity, number> = { DECLARED: 0, DERIVED: 1, PROVIDER: 2 };

export interface BlastAction {
  nodeId: string;
  toolId: string;
  summary: string;
  reversibility: Reversibility;
  holdSupported: boolean;
  fidelity: SimulationFidelity | null;
  externalRecipients: string[];
  recordsAffected: Effect<unknown>['recordsAffected'];
  reversibilityNote: string | null;
  monetaryValue: { currency: string; amount: number } | null;
  error: string | null;
}

export interface BlastGroup {
  category: Category;
  toolId: string;
  /** "send 3 emails" */
  label: string;
  count: number;
  externalDomains: string[];
  externalRecipients: string[];
  /** The least reversible action in the group. */
  reversibility: Reversibility;
  holdSupported: boolean;
  actions: BlastAction[];
}

export interface BlastRadiusSummary {
  groups: BlastGroup[];
  consequential: number;
  financial: Array<{ currency: string; amount: number }>;
  reads: Array<{ toolId: string; label: string; calls: number; items: number }>;
  minFidelity: SimulationFidelity | 'NONE';
  /** "Simulation fidelity: DERIVED for 2 of 2 actions" */
  fidelityNote: string;
  failures: Array<{ nodeId: string; toolId: string; error: string }>;
}

/** Items a read returned: every provenance envelope (`sourceId`) in its detail. */
function itemsIn(v: unknown): number {
  if (!v || typeof v !== 'object') return 0;
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + itemsIn(x), 0);
  const o = v as Record<string, unknown>;
  if (typeof o['sourceId'] === 'string' && 'value' in o) return 1;
  return Object.values(o).reduce<number>((n, x) => n + itemsIn(x), 0);
}

const domainOf = (address: string) => (address.includes('@') ? address.split('@').pop()!.toLowerCase() : address.replace(/^https?:\/\//, '').split('/')[0]!.toLowerCase());

export function blastRadius(planned: readonly PlannedEffect[]): BlastRadiusSummary {
  const groups = new Map<string, BlastGroup>();
  const reads = new Map<string, { toolId: string; label: string; calls: number; items: number; noun: [string, string] }>();
  const money = new Map<string, number>();
  const failures: BlastRadiusSummary['failures'] = [];
  let weakest: SimulationFidelity | null = null;
  const fidelityCount = new Map<SimulationFidelity, number>();
  let consequential = 0;

  for (const p of planned) {
    if (p.reversibility === 'R0') {
      const noun = READS[p.toolId] ?? ([`${p.toolId} result`, `${p.toolId} results`] as [string, string]);
      const r = reads.get(p.toolId) ?? { toolId: p.toolId, label: '', calls: 0, items: 0, noun };
      r.calls += 1;
      r.items += p.effect ? itemsIn(p.effect.detail) : 0;
      reads.set(p.toolId, r);
      continue;
    }
    consequential += 1;
    if (!p.effect) failures.push({ nodeId: p.nodeId, toolId: p.toolId, error: p.error ?? 'the simulation failed' });
    const f = p.effect?.fidelity ?? null;
    if (f) {
      fidelityCount.set(f, (fidelityCount.get(f) ?? 0) + 1);
      if (!weakest || FIDELITY_ORDER[f] < FIDELITY_ORDER[weakest]) weakest = f;
    } else {
      // An action whose effect could not even be simulated is only DECLARED.
      weakest = 'DECLARED';
      fidelityCount.set('DECLARED', (fidelityCount.get('DECLARED') ?? 0) + 1);
    }
    if (p.effect?.monetaryValue) money.set(p.effect.monetaryValue.currency, (money.get(p.effect.monetaryValue.currency) ?? 0) + p.effect.monetaryValue.amount);

    const kind = kindOf(p.toolId);
    const g =
      groups.get(p.toolId) ??
      ({ category: kind.category, toolId: p.toolId, label: '', count: 0, externalDomains: [], externalRecipients: [], reversibility: p.reversibility, holdSupported: p.holdSupported, actions: [] } as BlastGroup);
    g.count += 1;
    if (REV_ORDER[p.reversibility] > REV_ORDER[g.reversibility]) g.reversibility = p.reversibility;
    g.holdSupported = g.holdSupported && p.holdSupported;
    const external = (p.effect?.externalRecipients ?? []).map((x) => x.toLowerCase());
    g.externalRecipients = [...new Set([...g.externalRecipients, ...external])].sort();
    g.externalDomains = [...new Set(g.externalRecipients.map(domainOf))].sort();
    g.label = `${kind.verb} ${plural(g.count, kind.noun)}`;
    g.actions.push({
      nodeId: p.nodeId,
      toolId: p.toolId,
      summary: p.effect?.summary ?? `${p.toolId}: ${p.error ?? 'could not be simulated'}`,
      reversibility: p.reversibility,
      holdSupported: p.holdSupported,
      fidelity: f,
      externalRecipients: external,
      recordsAffected: p.effect?.recordsAffected ?? [],
      reversibilityNote: p.effect?.reversibilityNote ?? null,
      monetaryValue: p.effect?.monetaryValue ?? null,
      error: p.effect ? null : (p.error ?? 'the simulation failed'),
    });
    groups.set(p.toolId, g);
  }

  const ordered = [...groups.values()].sort((a, b) => REV_ORDER[b.reversibility] - REV_ORDER[a.reversibility] || a.label.localeCompare(b.label));
  const fidelityNote = consequential
    ? `Simulation fidelity: ${weakest} for ${fidelityCount.get(weakest!) ?? 0} of ${consequential} action${consequential === 1 ? '' : 's'}`
    : 'Nothing consequential: this run only reads.';
  return {
    groups: ordered,
    consequential,
    financial: [...money].map(([currency, amount]) => ({ currency, amount })),
    reads: [...reads.values()].map((r) => ({ toolId: r.toolId, label: plural(r.items || r.calls, r.noun), calls: r.calls, items: r.items })),
    minFidelity: weakest ?? 'NONE',
    fidelityNote,
    failures,
  };
}
