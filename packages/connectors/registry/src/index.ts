import { ToolRegistry, type ConnectorDefinition } from '@vega/connector-sdk';
import { gmail } from '@vega/connector-gmail';
import { gcal } from '@vega/connector-gcal';
import { gdrive } from '@vega/connector-gdrive';
import { outlook } from '@vega/connector-outlook';
import { sharepoint } from '@vega/connector-sharepoint';
import { slackConnector } from '@vega/connector-slack';
import { web } from '@vega/connector-web';
import { http } from '@vega/connector-http';

/**
 * The launch connector set (docs/module2.md §1.3, PROJECT.md §9.3). Importing this module
 * registers every tool through the registry's validation — a connector with an incomplete
 * declaration fails here at startup, in CI, and in the declaration-sync check.
 */
export const LAUNCH_CONNECTORS: ConnectorDefinition[] = [gmail, gcal, gdrive, outlook, sharepoint, slackConnector, web, http];

export function launchRegistry(extra: ConnectorDefinition[] = []): ToolRegistry {
  const registry = new ToolRegistry();
  for (const c of [...LAUNCH_CONNECTORS, ...extra]) registry.register(c);
  return registry;
}

export { gmail, gcal, gdrive, outlook, sharepoint, slackConnector as slack, web, http };
