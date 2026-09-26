import type { AnyTool, ConnectorDefinition } from './connector.js';
import { minimalScopes } from './oauth.js';

/**
 * The consent transparency screen (module2.md §6.2), GENERATED from declarations — never
 * hand-written prose that can drift from what is actually granted.
 */
export interface ConsentModel {
  connector: string;
  scopes: string[];
  permissions: Array<{
    toolId: string;
    title: string;
    scopes: string[];
    /** Present for consequential tools: what stands between the agent and the effect. */
    safeguard?: string;
  }>;
  neverDoes: string[];
  toolCount: number;
}

export function safeguardFor(tool: AnyTool): string | undefined {
  if (tool.reversibility === 'R0') return undefined;
  const parts: string[] = [];
  if (tool.egressClass !== 'INTERNAL') parts.push('Reaches people or systems outside your organization.');
  if (tool.reversibility === 'R2' && tool.holdSupported) {
    parts.push('Held before release, with a window in which it can be pulled back.');
  } else if (tool.reversibility === 'R1') {
    parts.push('Can be undone automatically.');
  } else if (tool.reversibility === 'R3') {
    parts.push('Cannot be undone once it happens; requires approval by default.');
  }
  if (tool.maxTaint === 'TRUSTED') parts.push('Never acts on instructions found inside content it reads.');
  return parts.join(' ');
}

export function consentModel(connector: ConnectorDefinition, enabledToolIds: string[]): ConsentModel {
  const enabled = connector.tools.filter((t) => enabledToolIds.includes(t.toolId));
  const permissions = enabled.map((t) => {
    const safeguard = safeguardFor(t);
    return { toolId: t.toolId, title: t.title, scopes: [...t.scopes], ...(safeguard ? { safeguard } : {}) };
  });
  return {
    connector: connector.displayName,
    scopes: minimalScopes(connector.tools, enabledToolIds),
    permissions,
    neverDoes: [...connector.neverDoes, 'Act on instructions contained inside content it reads'],
    toolCount: enabled.length,
  };
}
