import { router } from '../trpc.js';
import { agentsRouter } from './agents.js';
import { meRouter } from './me.js';
import { signupRouter } from './signup.js';
import { tenantsRouter } from './tenants.js';
import { usersRouter } from './users.js';
import { workspacesRouter } from './workspaces.js';

export const appRouter = router({
  me: meRouter,
  tenants: tenantsRouter,
  users: usersRouter,
  workspaces: workspacesRouter,
  agents: agentsRouter,
  signup: signupRouter,
});

export type AppRouter = typeof appRouter;
