import { router } from '../trpc.js';
import { agentsRouter } from './agents.js';
import { connectorsRouter } from './connectors.js';
import { mcpRouter } from './mcp.js';
import { contactsRouter, programsRouter, securityRouter } from './programs.js';
import { toolsRouter } from './tools.js';
import { meRouter } from './me.js';
import { signupRouter } from './signup.js';
import { tenantsRouter } from './tenants.js';
import { usersRouter } from './users.js';
import { workspacesRouter } from './workspaces.js';
import { runsRouter } from './runs.js';
import { conversationsRouter } from './conversations.js';
import { triggersRouter, webhooksRouter } from './webhooks.js';

export const appRouter = router({
  me: meRouter,
  tenants: tenantsRouter,
  users: usersRouter,
  workspaces: workspacesRouter,
  agents: agentsRouter,
  connectors: connectorsRouter,
  tools: toolsRouter,
  mcp: mcpRouter,
  programs: programsRouter,
  security: securityRouter,
  contacts: contactsRouter,
  runs: runsRouter,
  conversations: conversationsRouter,
  webhooks: webhooksRouter,
  triggers: triggersRouter,
  signup: signupRouter,
});

export type AppRouter = typeof appRouter;
